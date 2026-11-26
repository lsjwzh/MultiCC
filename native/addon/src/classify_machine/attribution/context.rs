use super::*;

pub(in crate::classify_machine) fn conversation<'a>(
    p: L<'a>,
    name: L<'a>,
    reply: L<'a>,
) -> Result<L<'a>> {
    let history = host(p, c"viewChatHistory", &[name])?;
    let keep = cb(p, 1, |p, a| {
        flag(p, !system_message(&trimmed(a[0].optional(c"content")?)?))
    })?;
    let rows = call(history, c"filter", &[keep])?;
    host(p, c"buildTaskAttributionConversation", &[rows, reply])
}
pub(super) fn ids(tasks: L<'_>) -> Result<L<'_>> {
    call(tasks, c"map", &[cb(tasks, 1, |_, a| a[0].get(c"taskId"))?])
}
fn directory_rows(p: L<'_>) -> Result<L<'_>> {
    let get = p.get(c"getDirectories")?;
    if !is_fn(get)? {
        return array(p);
    }
    let raw = get.call_plain(&[])?;
    if raw.is_array()? {
        return Ok(raw);
    }
    let rows = array(p)?;
    if raw.truthy()? && is_fn(raw.get(c"values")?)? {
        call(raw, c"values", &[])?.for_each(|r| {
            call(rows, c"push", &[r])?;
            Ok(())
        })?;
    }
    Ok(rows)
}
pub(super) fn directories<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let name = s.get(c"name")?;
    let dirs = match directory_rows(p) {
        Ok(v) => v,
        Err(e) => {
            log_message(s, "directory_list_failed", cause(p, e)?, &[])?;
            array(p)?
        }
    };
    let mut current = opt(row(p, name)?.optional(c"dirId")?)?;
    if id.truthy()? {
        let found = p.catch(|| {
            let board = call(host(p, c"getTaskBoardRuntime", &[])?, c"getBoard", &[])?;
            let tasks = board.optional(c"tasks")?;
            if tasks.nullish()? {
                return null(p);
            }
            tasks.get_key(id)?.optional(c"dirId")
        })?;
        if let Some(v) = found {
            if v.truthy()? {
                current = v;
            }
        }
    }
    let all = call(
        dirs,
        c"map",
        &[cb(p, 1, |_, a| {
            string(fallback(a[0].optional(c"id")?, "".into())?)
        })?],
    )?;
    let allowed = call(all, c"filter", &[p.global()?.get(c"Boolean")?])?;
    fields(
        s,
        &[
            ("directories", dirs),
            ("currentDirId", current),
            ("allowedDirIds", allowed),
        ],
    )
}
fn message_hits<'a>(p: L<'a>, id: L<'a>, user: L<'a>, reply: L<'a>) -> Result<L<'a>> {
    let get = p.get(c"getMessageSearch")?;
    let search = if is_fn(get)? {
        get.call_plain(&[])?
    } else {
        null(p)?
    };
    let query = host(
        p,
        c"attributionQueryText",
        &[fields(p, &[("userText", user), ("replyText", reply)])?],
    )?;
    if !search.truthy()? || !query.truthy()? || !is_fn(search.get(c"findMessages")?)? {
        return array(p);
    }
    let found = (|| {
        let exclude = array(p)?;
        if id.truthy()? {
            call(exclude, c"push", &[string(id)?])?;
        }
        call(
            search,
            c"findMessages",
            &[fields(
                p,
                &[
                    ("text", query),
                    ("limit", num(p, 12.)?),
                    ("excludeRefIds", exclude),
                ],
            )?],
        )
    })();
    match found {
        Ok(v) => Ok(v),
        Err(e) => {
            let err = cause(p, e)?;
            write_log(
                p,
                c"warn",
                "message_search_failed",
                fields(p, &[("sessionId", id), ("error", err.get(c"message")?)])?,
            )?;
            array(p)
        }
    }
}
pub(super) fn related<'a>(
    p: L<'a>,
    name: L<'a>,
    user: L<'a>,
    reply: L<'a>,
    recent: L<'a>,
) -> Result<L<'a>> {
    let exclude = ids(recent)?;
    let board = p.catch(|| {
        let b = host(p, c"getTaskBoardRuntime", &[])?;
        if is_fn(b.optional(c"getBoard")?)? {
            call(b, c"getBoard", &[])
        } else {
            Ok(b)
        }
    })?;
    let Some(board) = board else { return array(p) };
    let hits = message_hits(p, name, user, reply)?;
    host(
        p,
        c"retrieveRelatedTasks",
        &[
            board,
            fields(
                p,
                &[
                    ("userText", user),
                    ("replyText", reply),
                    ("excludeTaskIds", exclude),
                    ("messageHits", hits),
                ],
            )?,
        ],
    )
}
// Freeze prompt inputs on the request. A later turn can replace the live
// session, directory or transcript while the queue is awaiting its verdict.
pub(super) fn prompts<'a>(
    s: L<'a>,
    directory: L<'a>,
    recent: L<'a>,
    related: L<'a>,
    reply: L<'a>,
    first: bool,
    scan: bool,
) -> Result<()> {
    let p = s.get(c"p")?;
    let name = s.get(c"name")?;
    let options = fields(
        s,
        &[
            ("recentTasks", recent),
            ("relatedTasks", related),
            ("currentTaskId", s.get(c"taskId")?),
            ("provisionalTaskId", s.get(c"provisional")?),
        ],
    )?;
    if !scan {
        options.set(c"identityLocked", s.get(c"identityLocked")?)?;
    }
    field_names(options, directory, &[c"directories", c"currentDirId"])?;
    options.set(c"firstTurn", flag(p, first)?)?;
    s.set(c"recent", recent)?;
    s.set(c"related", related)?;
    s.set(c"directory", directory)?;
    s.set(c"firstTurn", flag(p, first)?)?;
    s.set(
        c"systemPrompt",
        host(p, c"buildTaskAttributionSystemPrompt", &[options])?,
    )?;
    s.set(c"prompt", conversation(p, name, reply)?)?;
    s.set(c"anchorMessageId", transcript::anchor(p, name)?)?;
    s.set(c"started", now(p)?)?;
    Ok(())
}
pub(super) fn parse<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let tasks = array(s)?;
    for key in [c"recent", c"related"] {
        s.get(key)?.for_each(|r| {
            call(tasks, c"push", &[r])?;
            Ok(())
        })?;
    }
    let options = fields(
        s,
        &[
            ("fallbackTaskId", s.get(c"taskId")?),
            ("allowedTaskIds", ids(tasks)?),
        ],
    )?;
    field_names(
        options,
        s.get(c"directory")?,
        &[c"allowedDirIds", c"currentDirId"],
    )?;
    options.set(c"firstTurn", s.get(c"firstTurn")?)?;
    host(p, c"parseTaskAttribution", &[value.get(c"text")?, options])
}
pub(super) fn record<'a>(s: L<'a>, body: L<'a>) -> Result<()> {
    let p = s.get(c"p")?;
    let result = (|| {
        call(
            host(p, c"getAuxRunLog", &[])?,
            c"record",
            &[s.get(c"name")?, body],
        )
    })();
    if let Err(e) = result {
        log_message(s, "aux_run_record_failed", cause(p, e)?, &[])?;
    }
    Ok(())
}
