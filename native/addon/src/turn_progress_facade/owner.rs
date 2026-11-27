use super::*;
use crate::{
    host_methods::{arg, env, raw},
    turn_progress::RustTurnProgress,
};
use napi::bindgen_prelude::{ClassInstance, FromNapiValue, TypeTag};

pub(super) fn invoke<'a>(owner: L<'a>, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let mut tagged = false;
    if owner.kind()? == sys::ValueType::napi_object && !owner.nullish()? {
        napi::check_status!(unsafe {
            sys::napi_check_object_type_tag(
                owner.env(),
                owner.raw(),
                &RustTurnProgress::type_tag(),
                &mut tagged,
            )
        })?;
    }
    if !tagged || !crate::host_methods::uses_class_method(owner, "RustTurnProgress\0", op)? {
        return call(owner, op, args);
    }
    let state: ClassInstance<'_, RustTurnProgress> =
        unsafe { ClassInstance::from_napi_value(owner.env(), owner.raw())? };
    let e = env(owner);
    match op.to_bytes() {
        b"heartbeatStart" => Ok(raw(
            owner,
            state.heartbeat_start(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?,
        )),
        b"heartbeatTouchVisible" => flag(
            owner,
            state.heartbeat_touch_visible(e, arg(args[0])?, arg(args[1])?, arg(args[2])?)?,
        ),
        b"heartbeatTouchActivity" => flag(
            owner,
            state.heartbeat_touch_activity(e, arg(args[0])?, arg(args[1])?, arg(args[2])?)?,
        ),
        b"heartbeatUpdatePhase" => flag(
            owner,
            state.heartbeat_update_phase(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
                arg(args[4])?,
            )?,
        ),
        b"heartbeatStop" => flag(
            owner,
            state.heartbeat_stop(e, arg(args[0])?, arg(args[1])?)?,
        ),
        b"heartbeatStatus" => Ok(raw(
            owner,
            state.heartbeat_status(e, arg(args[0])?, arg(args[1])?)?,
        )),
        b"heartbeatStopAll" => num(owner, state.heartbeat_stop_all().into()),
        b"heartbeatNextDue" => match state.heartbeat_next_due() {
            Some(value) => num(owner, value),
            None => null(owner),
        },
        b"heartbeatDue" => {
            state.heartbeat_due(e, arg(args[0])?, arg(args[1])?)?;
            undefined(owner)
        }
        b"timingBegin" => Ok(raw(
            owner,
            state.timing_begin(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?,
        )),
        b"timingMark" => Ok(raw(
            owner,
            state.timing_mark(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
                arg(args[4])?,
            )?,
        )),
        b"timingMarkFirstByte" => Ok(raw(
            owner,
            state.timing_mark_first_byte(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?,
        )),
        b"timingAbort" => Ok(raw(
            owner,
            state.timing_abort(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?,
        )),
        b"timingGet" => Ok(raw(
            owner,
            state.timing_get(e, arg(args[0])?, arg(args[1])?)?,
        )),
        b"timingField" => Ok(raw(
            owner,
            state.timing_field(e, arg(args[0])?, arg(args[1])?)?,
        )),
        b"timingDrop" => {
            state.timing_drop(e, arg(args[0])?, arg(args[1])?);
            undefined(owner)
        }
        b"timelineStart" => Ok(raw(
            owner,
            state.timeline_start(e, arg(args[0])?, arg(args[1])?, arg(args[2])?)?,
        )),
        b"timelineObserveClaude" => {
            state.timeline_observe_claude(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?;
            undefined(owner)
        }
        b"timelineObserveAdapter" => {
            state.timeline_observe_adapter(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
            )?;
            undefined(owner)
        }
        b"timelineCurrentStage" => Ok(raw(
            owner,
            state.timeline_current_stage(e, arg(args[0])?, arg(args[1])?, arg(args[2])?)?,
        )),
        b"timelineSnapshot" => Ok(raw(
            owner,
            state.timeline_snapshot(e, arg(args[0])?, arg(args[1])?, arg(args[2])?)?,
        )),
        b"timelineForget" => flag(owner, state.timeline_forget(e, arg(args[0])?)?),
        b"probeRecord" => {
            state.probe_record(
                e,
                arg(args[0])?,
                arg(args[1])?,
                arg(args[2])?,
                arg(args[3])?,
                arg(args[4])?,
            )?;
            undefined(owner)
        }
        b"probeLookup" => Ok(raw(
            owner,
            state.probe_lookup(e, arg(args[0])?, arg(args[1])?)?,
        )),
        b"probeForget" => flag(owner, state.probe_forget(e, arg(args[0])?)?),
        _ => unreachable!("unknown progress operation"),
    }
}
