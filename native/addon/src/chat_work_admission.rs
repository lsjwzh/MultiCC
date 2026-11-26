//! 兼容宿主的会话消息入队。调度器与唤醒操作可以返回 Promise，
//! 原生策略按调用时的会话状态选择宿主，保留拒绝原因和原错误对象。
use crate::{host_methods::method, js_live::invoke, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

fn optional_port<'a>(ports: L<'a>, key: &CStr) -> Result<L<'a>> {
    let port = ports.get(key)?;
    if port.nullish()? {
        Ok(port)
    } else {
        port.call_plain(&[])
    }
}

fn warn<'a>(ports: L<'a>, session: L<'a>, code: Option<L<'a>>) -> Result<()> {
    let logger = ports.get(c"logger")?;
    let warning = logger.get(c"warn")?;
    if !warning.nullish()? {
        let context = fields(session, &[("sessionId", session)])?;
        let event = if let Some(code) = code {
            context.set(c"code", code)?;
            "chat_workspace_restore_failed"
        } else {
            "chat_admit_scheduler_not_ready"
        };
        warning.call(logger, &[text(session, event)?, context])?;
    }
    Ok(())
}

fn notify<'a>(ports: L<'a>, session: L<'a>, code: &str, message: &str) -> Result<()> {
    ports.catch(|| {
        let frame = fields(
            session,
            &[
                ("type", text(session, "error")?),
                ("error", text(session, message)?),
                ("code", text(session, code)?),
            ],
        )?;
        ports.get(c"chatBroadcast")?.call_plain(&[session, frame])
    })?;
    Ok(())
}

#[napi]
pub fn chat_work_admission(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let start = method(&env, ports, "start", 3, 3, |p, a| {
        let host = p.get(c"taskContextHost")?;
        let guard = host.optional(c"guardAdmission")?;
        if !guard.nullish()? {
            let verdict = guard.call(host, a)?;
            if verdict.optional(c"ok")?.is_false()? {
                let frame = fields(p, &[("type", text(p, "error")?)])?;
                frame.spread_from(verdict)?;
                frame.define_key(text(p, "error")?, verdict.get(c"code")?)?;
                p.get(c"chatBroadcast")?.call_plain(&[a[0], frame])?;
                return fields(p, &[("blocked", verdict)]);
            }
        }
        let wake = optional_port(p, c"getSessionHibernation")?;
        let record = call(p.get(c"persistedSessions")?, c"get", &[a[0]])?;
        fields(
            p,
            &[
                ("wake", wake),
                (
                    "taskBound",
                    flag(p, record.optional(c"taskBoundTaskId")?.truthy()?)?,
                ),
            ],
        )
    })?;
    let admit = method(&env, ports, "admit", 3, 3, |p, a| {
        let experimental = optional_port(p, c"getExperimentalTuiChatRuntime")?;
        if !experimental.nullish()? {
            let owns = experimental.get(c"owns")?;
            let record = call(p.get(c"persistedSessions")?, c"get", &[a[0]])?;
            if invoke(experimental, owns, &[record], "experimentalRuntime.owns")?.truthy()? {
                return call(experimental, c"admit", a);
            }
        }
        let get = p.get(c"getSessionWorkHost")?;
        if get.call_plain(&[])?.truthy()? {
            call(get.call_plain(&[])?, c"admit", a)
        } else {
            null(p)
        }
    })?;
    let dispatch = method(&env, ports, "dispatch", 3, 3, |p, a| {
        let state = a[0];
        let wake = state.get(c"wake")?;
        if state.get(c"taskBound")?.is_true()?
            && wake.truthy()?
            && !optional_port(p, c"getWorkspaceAdmission")?.truthy()?
        {
            call(wake, c"admit", &[a[1], a[2]])
        } else {
            a[2].call_plain(&[])
        }
    })?;
    let failed = method(&env, ports, "failed", 3, 3, |p, a| {
        if a[0].get(c"taskBound")?.is_true()?
            && a[2]
                .optional(c"code")?
                .is_string("SESSION_PERSISTENCE_FAILED")?
        {
            warn(p, a[1], Some(a[2].get(c"code")?))?;
            notify(
                p,
                a[1],
                "workspace_restore_failed",
                "会话工作区状态无法安全保存，消息未被接收；请稍后重试。",
            )?;
        }
        Err(a[2].throw_error())
    })?;
    let finish = method(&env, ports, "finish", 2, 2, |p, a| {
        let admitted = a[1];
        if admitted.optional(c"workspaceUnavailable")?.truthy()? {
            warn(p, a[0], Some(admitted.get(c"code")?))?;
            notify(
                p,
                a[0],
                "workspace_restore_failed",
                "会话工作区恢复失败，消息未被接收；已保留休眠数据，请稍后重试。",
            )?;
        }
        if !admitted.truthy()? || admitted.get(c"code")?.is_string("scheduler_not_ready")? {
            warn(p, a[0], None)?;
            notify(
                p,
                a[0],
                "scheduler_not_ready",
                "会话调度器尚未就绪，消息未被接收；请稍后重试。",
            )?;
        }
        if admitted.truthy()? {
            Ok(admitted)
        } else {
            fields(
                p,
                &[
                    ("ok", flag(p, false)?),
                    ("code", text(p, "scheduler_not_ready")?),
                ],
            )
        }
    })?;
    Ok(fields(
        ports,
        &[
            ("start", start),
            ("admit", admit),
            ("dispatch", dispatch),
            ("failed", failed),
            ("finish", finish),
        ],
    )?
    .raw())
}
