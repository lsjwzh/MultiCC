//! Cooperative, single-threaded generator scheduler. The owner object keeps
//! jobs and callbacks visible to V8's cycle collector. No Rust borrow across a
//! callback is exclusive: a generator can enqueue, stop or clear its own queue.
use crate::{
    host_methods::{call, function},
    js_live::{fields, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cell::Cell, rc::Rc};

struct Schedule {
    budget: f64,
    share: f64,
    stopped: Cell<bool>,
    scheduled: Cell<bool>,
    slices: Cell<f64>,
}

fn fallback(n: f64, default: f64) -> f64 {
    if n == 0.0 || n.is_nan() {
        default
    } else {
        n
    }
}

impl Schedule {
    fn defer(&self, owner: L<'_>, delay: f64) -> Result<()> {
        self.scheduled.set(true);
        call(
            owner,
            c"defer",
            &[owner.get(c"tick")?, owner.from_value(&V::Number(delay))?],
        )?;
        Ok(())
    }

    fn tick(&self, owner: L<'_>) -> Result<()> {
        self.scheduled.set(false);
        if self.stopped.get() {
            return Ok(());
        }
        self.slices.set(self.slices.get() + 1.0);
        let began = call(owner, c"now", &[])?;
        let queue = owner.get(c"queue")?;
        while queue.get(c"length")?.truthy()? {
            let job = queue.element(0)?;
            let step = match call(owner, c"next", &[job]) {
                Ok(step) => step,
                Err(error) => {
                    let reason = owner.exception_value()?.ok_or(error)?;
                    call(queue, c"shift", &[])?;
                    owner.catch(|| call(owner, c"failed", &[job, reason]))?;
                    continue;
                }
            };
            if call(owner, c"done", &[step])?.truthy()? {
                call(queue, c"shift", &[])?;
                owner.catch(|| call(owner, c"complete", &[job, step]))?;
            }
            if call(
                owner,
                c"expired",
                &[began, owner.from_value(&V::Number(self.budget))?],
            )?
            .truthy()?
            {
                break;
            }
        }
        if queue.get(c"length")?.truthy()? && !self.stopped.get() {
            // Observable if the injected clock throws or reenters the runner.
            self.scheduled.set(true);
            let worked = call(owner, c"elapsed", &[began])?;
            let delay = if self.share >= 1.0 {
                0.0
            } else {
                let ms = call(owner, c"numericWork", &[worked])?.number()?;
                (ms * (1.0 - self.share) / self.share)
                    .ceil()
                    .clamp(1.0, 500.0)
            };
            // Reentrant clock calls may have cleared scheduled since the write.
            call(
                owner,
                c"defer",
                &[owner.get(c"tick")?, owner.from_value(&V::Number(delay))?],
            )?;
        }
        Ok(())
    }
}

#[napi]
pub fn search_slice_runner(
    env: Env,
    host: Unknown<'_>,
    slice_ms: f64,
    duty: f64,
) -> Result<sys::napi_value> {
    let owner = L::new(&env, host);
    owner.set(c"queue", owner.from_value(&V::Array(vec![]))?)?;
    let schedule = Rc::new(Schedule {
        budget: fallback(slice_ms, 8.0).max(1.0),
        share: fallback(duty, 0.1).clamp(0.01, 1.0),
        stopped: Cell::new(false),
        scheduled: Cell::new(false),
        slices: Cell::new(0.0),
    });
    let state = schedule.clone();
    owner.set(
        c"tick",
        function(owner, "tick", 0, 0, move |owner, _| {
            state.tick(owner)?;
            owner.from_value(&V::Undefined)
        })?,
    )?;
    let state = schedule.clone();
    let enqueue = function(owner, "enqueue", 2, 2, move |owner, args| {
        let queue = owner.get(c"queue")?;
        call(
            queue,
            if args[1].truthy()? {
                c"unshift"
            } else {
                c"push"
            },
            &[args[0]],
        )?;
        if !state.scheduled.get() && !state.stopped.get() && queue.get(c"length")?.truthy()? {
            state.defer(owner, 0.0)?;
        }
        Ok(args[0])
    })?;
    let clear = function(owner, "clear", 0, 0, |owner, _| {
        owner
            .get(c"queue")?
            .assign(c"length", owner.from_value(&V::Number(0.0))?)?;
        owner.from_value(&V::Undefined)
    })?;
    let state = schedule.clone();
    let stop = function(owner, "stop", 0, 0, move |owner, _| {
        state.stopped.set(true);
        owner
            .get(c"queue")?
            .assign(c"length", owner.from_value(&V::Number(0.0))?)?;
        owner.from_value(&V::Undefined)
    })?;
    let pending = function(owner, "pending", 0, 0, |owner, _| {
        owner.get(c"queue")?.get(c"length")
    })?;
    let stats = function(owner, "stats", 0, 0, move |owner, _| {
        fields(
            owner,
            &[
                (
                    "slices",
                    owner.from_value(&V::Number(schedule.slices.get()))?,
                ),
                ("queued", owner.get(c"queue")?.get(c"length")?),
                (
                    "scheduled",
                    owner.from_value(&V::Bool(schedule.scheduled.get()))?,
                ),
            ],
        )
    })?;
    Ok(fields(
        owner,
        &[
            ("enqueue", enqueue),
            ("clear", clear),
            ("stop", stop),
            ("pending", pending),
            ("stats", stats),
        ],
    )?
    .raw())
}
