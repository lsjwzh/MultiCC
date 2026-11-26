//! Snapshot one factory's host dependencies. No session state is copied.
use super::*;
use std::ffi::CStr;

pub(super) fn prepare<'a>(env: &'a Env, deps: L<'a>, host: L<'a>) -> Result<L<'a>> {
    let deps = if deps.truthy()? {
        deps
    } else {
        fields(host, &[])?
    };
    // Destructure the host before validating, including accessors on imported hosts.
    let p = fields(host, &[])?;
    for key in [
        c"persistedSessions",
        c"chatSessions",
        c"getSessionSummaries",
        c"logger",
        c"getAuxQueue",
        c"getSessionWorkHost",
        c"getLivenessRuntime",
        c"getTaskContextHost",
        c"getTaskBoardRuntime",
        c"getUserInputSignalHost",
        c"getApiErrorHost",
        c"getWaitInjector",
        c"setTaskState",
        c"getTaskState",
        c"appendClassifyHistory",
        c"setSessionSummary",
        c"setSessionStatus",
        c"chatBroadcast",
        c"workspaceBroadcast",
        c"terminalBroadcast",
        c"triggerPush",
        c"evaluateTurnApiError",
        c"turnHasSideEffects",
        c"retryNotice",
        c"loadChatHistory",
        c"viewChatHistory",
        c"appendChatMessage",
        c"annotateChatTurn",
        c"getAuxRunLog",
        c"getMessageSearch",
        c"hasBackgroundPending",
        c"writeTaskMemoryCandidate",
        c"getDirectories",
        c"getUnattendedHost",
    ] {
        let v = deps.get(key)?;
        let v = if !v.undefined()? {
            v
        } else {
            match key.to_bytes() {
                b"viewChatHistory" => p.get(c"loadChatHistory")?,
                b"annotateChatTurn" => method(env, p, "annotateChatTurn", 0, 0, |p, _| array(p))?,
                b"getAuxRunLog" => {
                    let record = method(env, p, "record", 0, 0, |p, _| null(p))?;
                    method(env, record, "getAuxRunLog", 0, 0, |record, _| {
                        fields(record, &[("record", record)])
                    })?
                }
                b"hasBackgroundPending" => {
                    method(env, p, "hasBackgroundPending", 0, 0, |p, _| flag(p, false))?
                }
                b"getUnattendedHost" => method(env, p, "getUnattendedHost", 0, 0, |p, _| null(p))?,
                b"getMessageSearch" | b"writeTaskMemoryCandidate" | b"getDirectories" => null(p)?,
                _ => v,
            }
        };
        p.set(key, v)?;
    }
    let required = |key: &CStr, prop: &CStr, msg: &str| -> Result<()> {
        let value = p.get(key)?;
        if !value.truthy()? || value.get(prop)?.kind()? != sys::ValueType::napi_function {
            return Err(p.type_error(&format!("[classify-state-machine] {msg}")));
        }
        Ok(())
    };
    required(
        c"persistedSessions",
        c"get",
        "persistedSessions map is required",
    )?;
    required(c"chatSessions", c"get", "chatSessions map is required")?;
    required(c"logger", c"info", "logger.info is required")?;
    for key in [
        c"getAuxQueue",
        c"getSessionWorkHost",
        c"getLivenessRuntime",
        c"getTaskContextHost",
        c"getTaskBoardRuntime",
        c"getUserInputSignalHost",
        c"getApiErrorHost",
        c"getWaitInjector",
        c"setTaskState",
        c"getTaskState",
        c"appendClassifyHistory",
        c"setSessionSummary",
        c"setSessionStatus",
        c"chatBroadcast",
        c"workspaceBroadcast",
        c"terminalBroadcast",
        c"triggerPush",
        c"evaluateTurnApiError",
        c"turnHasSideEffects",
        c"retryNotice",
        c"loadChatHistory",
        c"appendChatMessage",
        c"getSessionSummaries",
    ] {
        if p.get(key)?.kind()? != sys::ValueType::napi_function {
            return Err(p.type_error(&format!(
                "[classify-state-machine] {} must be a function",
                key.to_string_lossy()
            )));
        }
    }
    let catalog = multicc_core::classify_vocab::catalog_value();
    for (name, field) in [
        (c"display", "classifyDisplay"),
        (c"phaseLabels", "phaseLabels"),
    ] {
        p.set(
            name,
            p.from_value(&multicc_core::js::from_serde(&catalog[field]))?,
        )?;
    }
    for key in [c"crypto", c"shortCodes"] {
        p.set(key, host.get(key)?)?;
    }
    let attribution = host.get(c"attribution")?;
    for key in [
        c"attributionQueryText",
        c"buildTaskAttributionConversation",
        c"buildTaskAttributionSystemPrompt",
        c"parseTaskAttribution",
        c"recentTaskContext",
        c"retrieveRelatedTasks",
    ] {
        p.set(key, attribution.get(key)?)?;
    }
    Ok(p)
}
