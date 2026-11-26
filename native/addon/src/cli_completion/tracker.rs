//! One evidence slot per runner; V8 traces evidence and tool identities. The
//! public low-level tracker still accepts existing host read/write/settle ports.
use super::*;
use crate::{
    host_methods::{arg, default_object, env, function, raw},
    route_response::{fields, text},
};
use std::rc::Rc;

pub(super) struct Evidence<'a> {
    pub port: LiveValue<'a>,
    local: bool,
}
impl<'a> Evidence<'a> {
    pub fn external(port: LiveValue<'a>) -> Self {
        Self { port, local: false }
    }
    fn local(port: LiveValue<'a>) -> Self {
        Self { port, local: true }
    }
    pub fn read(&self) -> Result<LiveValue<'a>> {
        if self.local {
            self.port.get(c"evidence")
        } else {
            self.port.get(c"read")?.call_plain(&[])
        }
    }
    pub fn write(&self, value: LiveValue<'a>) -> Result<()> {
        if self.local {
            self.port.set(c"evidence", value)
        } else {
            self.port.get(c"write")?.call_plain(&[value])?;
            Ok(())
        }
    }
    pub fn settle(&self) -> Result<LiveValue<'a>> {
        if !self.local {
            return self.port.get(c"settle")?.call_plain(&[]);
        }
        let next = crate::js_live::spread(self.read()?)?;
        next.set(c"settled", self.port.from_value(&JsValue::Bool(true))?)?;
        let next = next.freeze()?;
        self.write(next)?;
        Ok(next)
    }
}
pub(crate) enum Protocol {
    Custom,
    Result,
    Named,
    Steps(Rc<RustStepCompletionTracker>),
}
pub(crate) fn create<'a>(
    opts: LiveValue<'a>,
    name: LiveValue<'a>,
    protocol: Protocol,
) -> Result<LiveValue<'a>> {
    let observe_port = crate::js_iteration::read(opts, c"observe")?;
    let close_port = crate::js_iteration::read(opts, c"close")?;
    let fallback = crate::js_iteration::read(opts, c"fallback")?;
    let step = if let Protocol::Steps(tracker) = &protocol {
        Some(tracker.clone())
    } else {
        None
    };
    let owner = Rc::new(RustCliCompletionTracker::new());
    let evidence = completion(
        opts,
        "unknown",
        text(opts, "missing_terminal_event")?,
        text(opts, "protocol")?,
    )?;
    let tools = opts.global()?.get(c"Set")?.construct(&[])?;
    let p = fields(
        opts,
        &[
            ("observe", observe_port),
            ("close", close_port),
            ("fallback", fallback),
            ("tools", tools),
            ("evidence", evidence),
            ("name", name),
        ],
    )?;
    let observer = owner.clone();
    let observe = function(p, "observe", 1, 2, move |p, a| {
        let evidence = Evidence::local(p);
        if !observer.accepts_raw(env(p), arg(a[0])?)? {
            return evidence.read();
        }
        let decoded = if a[1].undefined()? {
            p.from_value(&JsValue::Array(vec![]))?
        } else {
            a[1]
        };
        decoded.for_each(|event| {
            observer.observe_decoded(env(p), arg(event)?, arg(p.get(c"tools")?)?)
        })?;
        let next = match &protocol {
            Protocol::Result => result_completion(a[0])?,
            Protocol::Named => raw(
                p,
                cli_protocol_completion(
                    env(p),
                    unsafe {
                        <String as napi::bindgen_prelude::FromNapiValue>::from_napi_value(
                            p.env(),
                            p.get(c"name")?.raw(),
                        )
                    }?,
                    arg(a[0])?,
                )?,
            ),
            Protocol::Steps(step) => raw(p, step.observe(env(p), arg(a[0])?)?),
            Protocol::Custom => {
                let callback = p.get(c"observe")?;
                if callback.nullish()? {
                    p.from_value(&JsValue::Undefined)?
                } else {
                    callback.call_plain(&[a[0], decoded])?
                }
            }
        };
        observer.commit_observation(evidence, next)
    })?;
    fields(
        p,
        &[
            ("observe", observe),
            (
                "finish",
                function(p, "finish", 0, 1, move |p, a| {
                    owner.finish_live(default_object(a[0])?, Evidence::local(p), step.as_deref())
                })?,
            ),
            (
                "snapshot",
                function(p, "snapshot", 0, 0, |p, _| Evidence::local(p).read())?,
            ),
        ],
    )?
    .freeze()
}
#[napi]
pub fn create_cli_completion_tracker(e: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    let options = default_object(LiveValue::new(&e, options))?;
    Ok(create(
        options,
        options.from_value(&JsValue::Undefined)?,
        Protocol::Custom,
    )?
    .raw())
}
#[napi]
pub fn create_protocol_completion_tracker(
    e: Env,
    protocol: Unknown<'_>,
) -> Result<sys::napi_value> {
    let protocol = LiveValue::new(&e, protocol);
    Ok(create(fields(protocol, &[])?, protocol, Protocol::Named)?.raw())
}
#[napi]
pub fn create_result_completion_tracker(e: Env) -> Result<sys::napi_value> {
    use napi::bindgen_prelude::ToNapiValue;
    let value = LiveValue::new(&e, ().into_unknown(&e)?);
    Ok(create(fields(value, &[])?, value, Protocol::Result)?.raw())
}

#[napi]
pub fn create_step_completion_tracker(e: Env, stream_boundary: bool) -> Result<sys::napi_value> {
    use napi::bindgen_prelude::ToNapiValue;
    let anchor = LiveValue::new(&e, ().into_unknown(&e)?);
    Ok(create(
        fields(anchor, &[])?,
        anchor,
        Protocol::Steps(Rc::new(RustStepCompletionTracker::new(stream_boundary))),
    )?
    .raw())
}
