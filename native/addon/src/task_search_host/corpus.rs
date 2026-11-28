use super::*;
use multicc_core::js::string::JsString;

fn clean(v: L<'_>) -> Result<JsString> {
    Ok(string(fallback(v, "".into())?)?.coerce_string()?.trim())
}

pub(super) fn search_fields<'a>(board: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let title = clean(task.optional(c"title")?)?;
    let module_id = task.optional(c"moduleId")?;
    let modules = if module_id.truthy()? {
        board.optional(c"modules")?
    } else {
        undef(board)?
    };
    let module = if modules.nullish()? {
        undef(board)?
    } else {
        modules.get_key(module_id)?.optional(c"name")?
    };
    let mut areas = Vec::new();
    let tags = task.optional(c"areas")?;
    if tags.is_array()? {
        tags.for_each(|tag| {
            let value = clean(tag)?;
            if !value.is_empty() {
                areas.push(value);
            }
            Ok(())
        })?;
    }
    let mut body = Vec::new();
    for key in [c"description", c"acceptanceCriteria"] {
        let value = clean(task.optional(key)?)?;
        if !value.is_empty() {
            body.push(value);
        }
    }
    let refs = task.optional(c"refs")?;
    if refs.is_array()? {
        refs.for_each(|r| {
            let value = clean(r.optional(c"excerpt")?)?;
            if !value.is_empty() {
                body.push(value);
            }
            Ok(())
        })?;
    }
    fields(
        board,
        &[
            ("title", board.from_value(&V::String(title))?),
            ("module", string(fallback(module, "".into())?)?),
            (
                "areas",
                board.from_value(&V::String(JsString::join(&areas, &" ".into())))?,
            ),
            (
                "body",
                board.from_value(&V::String(JsString::join(&body, &"\n".into())))?,
            ),
        ],
    )
}

fn directory(task: L<'_>) -> Result<L<'_>> {
    if let Some(dir) = task.get(c"dirId")?.string()? {
        let dir = dir.trim();
        if !dir.is_empty() {
            return task.from_value(&V::String(dir));
        }
    }
    let refs = task.get(c"refs")?;
    let mut dir = null(task)?;
    if refs.is_array()? {
        refs.for_each_while(|r| {
            let id = r.optional(c"dirId")?;
            if id.truthy()? {
                dir = id;
                return Ok(false);
            }
            Ok(true)
        })?;
    }
    Ok(dir)
}

fn stamp(task: L<'_>) -> Result<f64> {
    for key in [c"updatedAt", c"createdAt"] {
        let n = task.get(key)?.explicit_number()?;
        if n != 0.0 && !n.is_nan() {
            return Ok(n);
        }
    }
    Ok(0.)
}

pub(super) fn string_list(v: L<'_>, empty_is_null: bool) -> Result<L<'_>> {
    if !v.is_array()? || (empty_is_null && size(v)? == 0) {
        return null(v);
    }
    call(v, c"map", &[v.global()?.get(c"String")?])
}

pub(super) fn prepare<'a>(board: L<'a>, options: L<'a>, synchronous: bool) -> Result<L<'a>> {
    let tasks = board.optional(c"tasks")?;
    let tasks = if synchronous
        && (tasks.kind()? == sys::ValueType::napi_object
            || tasks.kind()? == sys::ValueType::napi_null)
    {
        tasks
    } else if synchronous {
        fields(board, &[])?
    } else {
        fallback(tasks, V::Object(Default::default()))?
    };
    let values = call(board.global()?.get(c"Object")?, c"values", &[tasks])?;
    let deleted = board.optional(c"deletedTaskIds")?;
    let ctor = board.global()?.get(c"Set")?;
    let deleted = if deleted.is_array()? {
        ctor.construct(&[deleted])?
    } else {
        ctor.construct(&[])?
    };
    let statuses = string_list(options.get(c"statuses")?, true)?;
    let statuses = if statuses.nullish()? {
        statuses
    } else {
        ctor.construct(&[statuses])?
    };
    let docs = map(board)?;
    let rows = array(board)?;
    values.for_each(|task| {
        if !task.truthy()? {
            return Ok(());
        }
        let id = task.get(c"id")?;
        if id.kind()? != sys::ValueType::napi_string
            || !id.truthy()?
            || call(deleted, c"has", &[id])?.truthy()?
            || task.get(c"mergedInto")?.truthy()?
            || task.get(c"deleting")?.truthy()?
        {
            return Ok(());
        }
        let status = task.get(c"status")?;
        if !statuses.nullish()?
            && !call(
                statuses,
                c"has",
                &[string(fallback(status, "active".into())?)?],
            )?
            .truthy()?
        {
            return Ok(());
        }
        if !synchronous && call(docs, c"has", &[id])?.truthy()? {
            return Err(napi::Error::from_reason("duplicate_search_document_id"));
        }
        let corpus = search_fields(board, task)?;
        let row = fields(
            board,
            &[
                ("taskId", id),
                ("title", corpus.get(c"title")?),
                ("dirId", directory(task)?),
                (
                    "status",
                    if status.kind()? == sys::ValueType::napi_string {
                        status
                    } else {
                        text(task, "active")?
                    },
                ),
                ("updatedAt", num(board, stamp(task)?)?),
                ("fields", corpus),
            ],
        )?;
        if !synchronous {
            call(docs, c"set", &[id, row])?;
        }
        push(rows, row)
    })?;
    fields(board, &[("rows", rows), ("docs", docs), ("tasks", tasks)])
}

pub(super) fn payload<'a>(p: L<'a>, rows: L<'a>, synchronous: bool) -> Result<L<'a>> {
    let list = array(p)?;
    // Sync term statistics only need a distinct id. Keep JS keys (including
    // unpaired surrogates) and non-string legacy directory refs in the live Map.
    let ids = if synchronous { Some(map(p)?) } else { None };
    rows.for_each(|row| {
        let corpus = row.get(c"fields")?;
        let normalized = array(p)?;
        for name in NAMES {
            push(
                normalized,
                crate::search_tokens::normalized(corpus.get(name)?, false)?,
            )?;
        }
        let doc = if let Some(ids) = ids {
            let id = row.get(c"taskId")?;
            let mut canonical = call(ids, c"get", &[id])?;
            if canonical.undefined()? {
                canonical = string(ids.get(c"size")?)?;
                call(ids, c"set", &[id, canonical])?;
            }
            fields(
                p,
                &[
                    ("taskId", canonical),
                    ("dirId", null(p)?),
                    ("status", text(p, "")?),
                ],
            )?
        } else {
            pick(row, &[c"taskId", c"dirId", c"status"])?
        };
        doc.set(c"fields", normalized)?;
        push(list, doc)
    })?;
    json_call(p, c"stringify", list)
}
