use super::*;

fn unknown(v: L<'_>) -> Unknown<'_> {
    unsafe { Unknown::from_raw_unchecked(v.env(), v.raw()) }
}

#[napi]
pub fn chat_open_socket(
    env: Env,
    ports: Unknown<'_>,
    ws: Unknown<'_>,
    req: Unknown<'_>,
    url: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let ws = L::new(&env, ws);
    let url = L::new(&env, url);
    let query = url.get(c"searchParams")?;
    let s = fallback(
        call(query, c"get", &[text(p, "session")?])?,
        "_default".into(),
    )?;
    let shell = call(query, c"get", &[text(p, "shell")?])?;
    let close = |frame: L<'_>| -> Result<sys::napi_value> {
        plain(p, c"sendWs", &[ws, frame])?;
        call(ws, c"close", &[])?;
        Ok(fields(p, &[("closed", flag(p, true)?)])?.raw())
    };
    if shell.truthy()? {
        let denied = if ws.get(c"_sharePerm")?.truthy()? {
            Some(text(
                p,
                "Shell history is unavailable through a session share",
            )?)
        } else {
            match call(
                p.get(c"taskContextHost")?,
                c"taskShellChatScope",
                &[shell, s],
            ) {
                Ok(_) => None,
                Err(err) => Some(if let Some(value) = p.exception_value()? {
                    read(value, c"message")?
                } else {
                    text(p, &err.reason)?
                }),
            }
        };
        if let Some(message) = denied {
            return close(fields(
                p,
                &[
                    ("type", text(p, "error")?),
                    ("code", text(p, "shell_scope_denied")?),
                    ("error", message),
                ],
            )?);
        }
    }
    let record = call(p.get(c"persistedSessions")?, c"get", &[s])?;
    let is_internal = crate::public_session_access::session_is_internal_execution_slot(
        Env::from_raw(p.env()),
        Some(unknown(record)),
    )?;
    let kind = record.optional(c"kind")?;
    let invalid = p.get(c"invalidSessions")?;
    let reason = if call(invalid, c"has", &[s])?.truthy()? {
        string(call(invalid, c"get", &[s])?)?
    } else {
        null(p)?
    };
    let error = L::from_raw(
        p.env(),
        crate::chat_ws_control::chat_ws_open_error(
            Env::from_raw(p.env()),
            s.coerce_string()?.to_string_lossy(),
            record.truthy()?,
            is_internal,
            unknown(kind),
            unknown(reason),
        )?,
    );
    if error.truthy()? {
        return close(error);
    }
    let get_experimental = p.get(c"getExperimentalTuiChatRuntime")?;
    let experimental = if get_experimental.nullish()? {
        null(p)?
    } else {
        get_experimental.call_plain(&[])?
    };
    if record.get(c"experimentalMode")?.truthy()? && experimental.truthy()? {
        let result = call(experimental, c"handleWs", &[ws, L::new(&env, req), url])?;
        return Ok(fields(p, &[("closed", flag(p, true)?), ("result", result)])?.raw());
    }
    let cli = fallback(record.get(c"cli")?, "claude".into())?;
    let cwd = plain(p, c"cwdForSession", &[record])?;
    let mut cs = call(p.get(c"chatSessions")?, c"get", &[s])?;
    if !cs.truthy()? {
        if cli.is_string("claude")? && !record.get(c"cliSessionId")?.truthy()? {
            record.assign(c"cliSessionId", plain(p, c"randomUUID", &[])?)?;
            plain(
                p,
                c"savePersistedSessionsBestEffort",
                &[text(p, "websocket.chat-session-id-allocate")?],
            )?;
        }
        let history = plain(p, c"viewChatHistory", &[s])?;
        cs = L::from_raw(
            p.env(),
            chat_restore_live_session(
                Env::from_raw(p.env()),
                unknown(p),
                unknown(s),
                unknown(cli),
                unknown(cwd),
                unknown(history),
            )?,
        );
    }
    Ok(fields(
        p,
        &[
            ("sessionName", s),
            ("shellId", shell),
            ("persisted", record),
            ("cs", cs),
        ],
    )?
    .raw())
}

fn replay_background<'a>(p: L<'a>, ws: L<'a>, s: L<'a>) -> Result<()> {
    let active = call(
        plain(p, c"getBackgroundTaskRuntime", &[])?,
        c"listActiveBackgroundTasks",
        &[s],
    )?;
    plain(
        p,
        c"sendWs",
        &[
            ws,
            fields(
                p,
                &[("type", text(p, "background_tasks")?), ("tasks", active)],
            )?,
        ],
    )?;
    if !active.get(c"length")?.is_number(0.0)? {
        return Ok(());
    }
    let journal = p.get(c"turnEventJournal")?;
    if !journal.truthy()? || journal.get(c"readAll")?.kind()? != sys::ValueType::napi_function {
        return Ok(());
    }
    let cutoff = call(p.global()?.get(c"Date")?, c"now", &[])?.number()? - 15.0 * 60.0 * 1000.0;
    plain(p, c"deriveOpenTasks", &[call(journal, c"readAll", &[s])?])?.for_each(|task| {
        let time = task.get(c"lastTs")?.number_value()?;
        if !time.is_some_and(|n| n.is_finite() && n >= cutoff) {
            return Ok(());
        }
        let mut summary = multicc_core::js::JsString::from("重启前运行中 · 已随服务重启中断");
        if task.get(c"description")?.truthy()? {
            summary.push_str("：");
            summary.push(&task.get(c"description")?.coerce_string()?);
        }
        let frame = fields(
            p,
            &[
                ("type", text(p, "monitor_done")?),
                ("task_id", task.get(c"task_id")?),
                ("status", text(p, "interrupted")?),
                ("summary", p.from_value(&V::String(summary))?),
                ("background", flag(p, true)?),
                ("replayed", flag(p, true)?),
            ],
        )?;
        plain(p, c"sendWs", &[ws, frame])?;
        Ok(())
    })
}

#[napi]
pub fn chat_replay_socket(
    env: Env,
    ports: Unknown<'_>,
    ws: Unknown<'_>,
    connection: Unknown<'_>,
    gate: Unknown<'_>,
    url: Unknown<'_>,
) -> Result<()> {
    let p = L::new(&env, ports);
    let ws = L::new(&env, ws);
    let c = L::new(&env, connection);
    let s = c.get(c"sessionName")?;
    let cs = c.get(c"cs")?;
    let shell = c.get(c"shellId")?;
    let record = c.get(c"persisted")?;
    let frame = L::from_raw(
        p.env(),
        chat_socket_init_frame(
            Env::from_raw(p.env()),
            unknown(p),
            unknown(s),
            unknown(cs),
            unknown(record),
            gate,
        )?,
    );
    plain(p, c"sendWs", &[ws, frame])?;
    let scope = call(
        L::new(&env, url).get(c"searchParams")?,
        c"get",
        &[text(p, "historyScope")?],
    )?;
    let opts = fields(
        p,
        &[
            ("limit", p.get(c"historyPage")?),
            ("includeHidden", flag(p, scope.is_string("archive")?)?),
        ],
    )?;
    let canonical = if shell.truthy()? {
        opts.assign(c"activeSessionId", s)?;
        call(
            p.get(c"taskContextHost")?,
            c"taskShellChatHistory",
            &[shell, opts],
        )?
    } else {
        call(
            plain(p, c"getChatHistoryRuntime", &[])?,
            c"paginate",
            &[s, opts],
        )?
    };
    let messages = canonical.get(c"messages")?;
    let messages = if shell.truthy()? {
        messages
    } else {
        plain(p, c"buildReplayMessages", &[messages, cs])?
    };
    let page = plain(
        p,
        c"fitHistoryFrame",
        &[messages, canonical.get(c"hasMore")?],
    )?;
    let usage = plain(p, c"getTokenUsage", &[])?;
    let summary = if record.get(c"cli")?.is_string("codex")? {
        plain(
            p,
            c"summarizeHistoryUsage",
            &[plain(p, c"viewChatHistory", &[s])?],
        )?
    } else {
        fallback(usage.get_key(s)?, V::Null)?
    };
    chat_apply_connect_replay(
        Env::from_raw(p.env()),
        unknown(p),
        unknown(ws),
        unknown(s),
        unknown(cs),
        unknown(page),
        unknown(summary),
    )?;
    p.catch(|| replay_background(p, ws, s))?;
    Ok(())
}
