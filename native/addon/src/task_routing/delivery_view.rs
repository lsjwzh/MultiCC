//! Read live evidence in source order. Getter exceptions and object-valued
//! identifiers cross the binding unchanged, including when evidence is sparse.
use crate::{
    host_methods::call,
    js_iteration::read,
    js_live::{fields, spread, LiveValue as L},
};
use multicc_core::{
    js::JsValue as V,
    task_routing::delivery_view::{Attribution, DeliveryFacts, Evidence},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

struct Inputs<'a> {
    task: L<'a>,
    candidate: L<'a>,
    separation: L<'a>,
    run: L<'a>,
    integration: L<'a>,
    barrier: L<'a>,
    application: L<'a>,
    baseline: L<'a>,
}

fn or_null(value: L<'_>) -> Result<L<'_>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&V::Null)
    }
}
fn copy_fields<'a>(source: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    let out = fields(source, &[])?;
    for &key in keys {
        out.set(key, read(source, key)?)?;
    }
    Ok(out)
}

impl<'a> Inputs<'a> {
    fn facts(&self) -> Result<DeliveryFacts> {
        let Self {
            task,
            candidate,
            separation,
            run,
            integration,
            barrier,
            application,
            baseline,
        } = *self;
        let succeeded = run.optional(c"outcome")?.is_string("succeeded")?
            && !read(run, c"pendingInput")?.truthy()?;
        let code_observed = run.optional(c"endCodeRevision")?.truthy()?;
        let code_changed = if code_observed && read(run, c"startCodeRevision")?.truthy()? {
            Some(!read(run, c"startCodeRevision")?.equals(read(run, c"endCodeRevision")?)?)
        } else {
            None
        };
        let snapshot = separation
            .optional(c"deliveryKind")?
            .is_string("workspace_snapshot")?;
        let has_integration = integration.truthy()?;
        let integration_current =
            has_integration && baseline.optional(c"effectValid")?.is_true()?;
        let snapshot_stopped =
            snapshot && barrier.truthy()? && read(barrier, c"writersStopped")?.is_true()?;
        let barrier_current = barrier.truthy()?
            && read(barrier, c"turnId")?.equals(run.optional(c"id")?)?
            && read(barrier, c"writersStopped")?.is_true()?
            && (snapshot
                || read(barrier, c"codeRevision")?.equals(run.optional(c"endCodeRevision")?)?);
        let applied = separation.optional(c"state")?.is_string("separated")?
            && application.truthy()?
            && read(application, c"separationId")?.equals(read(separation, c"id")?)?
            && read(application, c"targetTaskId")?.equals(read(separation, c"taskId")?)?;
        let separated = separation.truthy()?;
        let has_run = run.truthy()?;
        let fixed_attribution = !separated
            && !candidate.truthy()?
            && has_run
            && (!task.truthy()? || read(run, c"taskId")?.equals(task)?);
        let kept = separation.optional(c"state")?.is_string("kept")?;
        let stale_candidate = !separated && candidate.optional(c"state")?.is_string("stale")?;
        let attribution = if separated {
            if kept {
                Attribution::Kept
            } else if applied {
                Attribution::Applied
            } else {
                Attribution::Pending
            }
        } else if candidate.truthy()? {
            Attribution::Candidate
        } else {
            Attribution::Fixed
        };
        Ok(DeliveryFacts {
            has_run,
            succeeded,
            code_observed,
            code_changed,
            has_integration,
            integration_current,
            snapshot,
            snapshot_stopped,
            barrier_current,
            attribution,
            fixed_attribution,
            stale_candidate,
            separation_applied: applied,
        })
    }

    fn steps(&self, facts: &DeliveryFacts) -> Result<L<'a>> {
        let a = self.run;
        let steps = a.from_value(&V::Array(vec![]))?;
        for (i, step) in facts.steps().into_iter().enumerate() {
            let id = match step.evidence {
                Evidence::Run => or_null(a.optional(c"id")?)?,
                Evidence::UnchangedRun => {
                    let id = a.optional(c"id")?;
                    if id.undefined()? {
                        a.from_value(&V::Null)?
                    } else {
                        id
                    }
                }
                Evidence::Integration => or_null(self.integration.optional(c"id")?)?,
                Evidence::Barrier => or_null(self.barrier.optional(c"id")?)?,
                Evidence::Attribution => {
                    let id = self.application.optional(c"id")?;
                    if id.truthy()? {
                        id
                    } else {
                        or_null(a.optional(c"receiptId")?)?
                    }
                }
            };
            steps.set_element(
                i as u32,
                fields(
                    a,
                    &[
                        ("key", a.from_value(&step.key.into())?),
                        ("label", a.from_value(&step.label.into())?),
                        ("status", a.from_value(&step.status.into())?),
                        ("evidenceId", id),
                    ],
                )?,
            )?;
        }
        Ok(steps)
    }

    fn blockers(&self, facts: &DeliveryFacts) -> Result<L<'a>> {
        let s = self.separation;
        let blockers = s.from_value(&V::Array(
            facts.blockers().into_iter().map(V::from).collect(),
        ))?;
        if s.optional(c"lastError")?.optional(c"code")?.truthy()?
            && !call(
                blockers,
                c"includes",
                &[read(read(s, c"lastError")?, c"code")?],
            )?
            .truthy()?
        {
            call(blockers, c"push", &[read(read(s, c"lastError")?, c"code")?])?;
        }
        Ok(blockers)
    }

    fn separation_view(&self) -> Result<L<'a>> {
        let s = self.separation;
        if !s.truthy()? {
            return s.from_value(&V::Null);
        }
        let out = copy_fields(s, &[c"id", c"state"])?;
        out.set(c"phase", or_null(read(s, c"phase")?)?)?;
        for key in [c"sourceTaskId", c"sourceTitle"] {
            out.set(key, read(s, key)?)?;
        }
        out.set(c"targetTaskId", or_null(read(s, c"taskId")?)?)?;
        out.set(c"targetTitle", read(s, c"title")?)?;
        let reason = read(s, c"reason")?;
        out.set(
            c"reason",
            if reason.truthy()? {
                reason
            } else {
                s.from_value(&"".into())?
            },
        )?;
        out.set(c"deliveryKind", or_null(read(s, c"deliveryKind")?)?)?;
        let last = if read(s, c"lastError")?.optional(c"code")?.truthy()? {
            let code = read(read(s, c"lastError")?, c"code")?;
            let string = s.global()?.get(c"String")?.call_plain(&[code])?;
            let short = call(
                string,
                c"slice",
                &[
                    s.from_value(&V::Number(0.0))?,
                    s.from_value(&V::Number(100.0))?,
                ],
            )?;
            fields(s, &[("code", short)])?
        } else {
            s.from_value(&V::Null)?
        };
        out.set(c"lastError", last)?;
        out.set(c"result", or_null(read(s, c"result")?)?)?;
        Ok(out)
    }

    fn project(&self) -> Result<L<'a>> {
        let f = self.facts()?;
        let blockers = self.blockers(&f)?;
        let steps = self.steps(&f)?;
        let a = self.run;
        let null = a.from_value(&V::Null)?;
        let candidate = if self.candidate.truthy()? {
            let copy = spread(self.candidate)?;
            copy.set(c"blockers", blockers)?;
            copy
        } else {
            null
        };
        let separation = self.separation_view()?;
        let run = if f.has_run {
            let out = copy_fields(
                a,
                &[
                    c"id",
                    c"taskId",
                    c"attemptId",
                    c"outcome",
                    c"pendingInput",
                    c"finishedAt",
                    c"endDirty",
                ],
            )?;
            out.set(c"codeObserved", a.from_value(&V::Bool(f.code_observed))?)?;
            out.set(
                c"codeChanged",
                a.from_value(&f.code_changed.map(V::Bool).unwrap_or(V::Null))?,
            )?;
            out.set(
                c"noCodeChange",
                a.from_value(&V::Bool(f.code_changed == Some(false)))?,
            )?;
            out
        } else {
            null
        };
        let integration = if f.has_integration {
            let out = copy_fields(
                self.integration,
                &[c"id", c"operationId", c"integrationHead", c"baseRef"],
            )?;
            out.set(
                c"baselineCurrent",
                a.from_value(&V::Bool(f.integration_current))?,
            )?;
            out
        } else {
            null
        };
        let barrier = if f.barrier_current {
            copy_fields(self.barrier, &[c"id", c"verifiedAt", c"dirty"])?
        } else {
            null
        };
        let application = if f.separation_applied {
            copy_fields(
                self.application,
                &[c"id", c"targetTaskId", c"targetSessionId", c"appliedAt"],
            )?
        } else {
            null
        };
        fields(
            a,
            &[
                ("mode", a.from_value(&f.attribution.mode().into())?),
                ("candidate", candidate),
                ("separation", separation),
                ("blockers", blockers),
                ("steps", steps),
                ("run", run),
                ("integration", integration),
                ("barrier", barrier),
                ("application", application),
            ],
        )
    }
}

#[napi]
pub fn project_delivery_view(
    env: Env,
    task: Unknown<'_>,
    candidate: Unknown<'_>,
    separation: Unknown<'_>,
    run: Unknown<'_>,
    integration: Unknown<'_>,
    barrier: Unknown<'_>,
    application: Unknown<'_>,
    baseline: Unknown<'_>,
) -> Result<sys::napi_value> {
    let live = |v| L::new(&env, v);
    Ok(Inputs {
        task: live(task),
        candidate: live(candidate),
        separation: live(separation),
        run: live(run),
        integration: live(integration),
        barrier: live(barrier),
        application: live(application),
        baseline: live(baseline),
    }
    .project()?
    .raw())
}

/// Capture evidence before the optional await. Projection runs in this callback
/// for synchronous paths, including a verifier that throws before returning.
#[napi]
pub fn begin_delivery_view(
    env: Env,
    session: Unknown<'_>,
    task: Unknown<'_>,
    candidate: Unknown<'_>,
    separation: Unknown<'_>,
    admission: Unknown<'_>,
    cwd: Unknown<'_>,
) -> Result<sys::napi_value> {
    let live = |v| L::new(&env, v);
    let (session, task, candidate, separation, admission, cwd) = (
        live(session),
        live(task),
        live(candidate),
        live(separation),
        live(admission),
        live(cwd),
    );
    let separated_session = separation.optional(c"sessionId")?;
    let session = if separated_session.truthy()? {
        separated_session
    } else {
        session
    };
    let separated_turn = separation.optional(c"turnId")?;
    let turn = if separated_turn.truthy()? {
        separated_turn
    } else {
        or_null(candidate.optional(c"turnId")?)?
    };
    let evidence = crate::js_live::invoke(
        admission,
        read(admission, c"deliveryEvidence")?,
        &[session, turn],
        "admission.deliveryEvidence",
    )?;
    if evidence.nullish()? {
        let kind = if evidence.undefined()? {
            "undefined"
        } else {
            "null"
        };
        return Err(evidence.type_error(&format!(
            "Cannot destructure property 'run' of 'evidence' as it is {kind}."
        )));
    }
    // Snapshot the four host properties in destructuring order before verification.
    let run = read(evidence, c"run")?;
    let integration = read(evidence, c"integration")?;
    let barrier = read(evidence, c"barrier")?;
    let application = read(evidence, c"application")?;
    if integration.truthy()? && cwd.truthy()? {
        if let Some(pending) =
            admission.catch(|| call(admission, c"verifyBaseline", &[integration, cwd]))?
        {
            let captured = fields(
                task,
                &[
                    ("run", run),
                    ("integration", integration),
                    ("barrier", barrier),
                    ("application", application),
                ],
            )?;
            return Ok(fields(task, &[("evidence", captured), ("value", pending)])?.raw());
        }
    }
    let null = task.from_value(&V::Null)?;
    let value = Inputs {
        task,
        candidate,
        separation,
        run,
        integration,
        barrier,
        application,
        baseline: null,
    }
    .project()?;
    Ok(fields(task, &[("evidence", null), ("value", value)])?.raw())
}
