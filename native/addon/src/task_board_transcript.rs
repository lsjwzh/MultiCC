//! Live-value adapter for the task-board transcript projections. Session
//! histories and message text stay host callbacks; this module replays the
//! exact property reads, truthiness checks, callback boundaries and exception
//! handling of the retired Node helpers.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as J},
    task_board_transcript as core,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// `String(value)`: the global function call, so a Symbol survives exactly
/// like the retired helper's explicit `String(...)` did (a bare ToString
/// would throw on a Symbol).
fn js_string(value: L) -> Result<JsString> {
    let text = value.global()?.get(c"String")?.call_plain(&[value])?;
    Ok(text.string()?.expect("String() returns a string"))
}

/// Strict-equality membership, the `Set#has` contract for the string ids the
/// board schema guarantees.
fn contains(values: &[L], candidate: L) -> Result<bool> {
    for value in values {
        if candidate.equals(*value)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The override array collected once as live values; the projection compares
/// against these with strict equality, just like the retired Set.
fn collect_identity_ids(ids: L) -> Result<Vec<L>> {
    let mut out: Vec<L> = Vec::new();
    ids.for_each(|value| {
        out.push(value);
        Ok(())
    })?;
    Ok(out)
}

/// Session ids in the retired helper's Set-insertion order: each member's
/// `refs` in order (truthy guard, then for-of), then the routing lookups.
/// The routing reads repeat exactly the way the retired helper's guard plus
/// Set argument read them (`member?.routing?.workerSessionId` for the check,
/// then `member.routing.workerSessionId` again for the add).
fn collect_session_ids(members: L) -> Result<Vec<L>> {
    let mut session_ids: Vec<L> = Vec::new();
    members.for_each(|member| {
        if member.nullish()? {
            return Ok(());
        }
        let refs = member.get(c"refs")?;
        if refs.truthy()? {
            refs.for_each(|reference| {
                let session_id = reference.get(c"sessionId")?;
                if session_id.truthy()? && !contains(&session_ids, session_id)? {
                    session_ids.push(session_id);
                }
                Ok(())
            })?;
        }
        let routing = member.get(c"routing")?;
        let worker = if routing.nullish()? {
            None
        } else {
            Some(routing.get(c"workerSessionId")?)
        };
        if let Some(worker) = worker {
            if worker.truthy()? {
                let again = member.get(c"routing")?.get(c"workerSessionId")?;
                if !contains(&session_ids, again)? {
                    session_ids.push(again);
                }
            }
        }
        let routing = member.get(c"routing")?;
        let mode = if routing.nullish()? {
            None
        } else {
            Some(routing.get(c"mode")?)
        };
        if let Some(mode) = mode {
            if mode.is_string("manual")? {
                let target = member.get(c"routing")?.get(c"targetSessionId")?;
                if target.truthy()? {
                    let again = member.get(c"routing")?.get(c"targetSessionId")?;
                    if !contains(&session_ids, again)? {
                        session_ids.push(again);
                    }
                }
            }
        }
        Ok(())
    })?;
    Ok(session_ids)
}

/// One projected message with its sort key. V8 reads `message.ts` per
/// comparison inside the sort; pre-reading once per entry is unobservable for
/// the plain JSON data the board stores.
struct Entry<'env> {
    session_id: L<'env>,
    message: L<'env>,
    key: f64,
}

/// The shared canonical scan: per session in collection order, load the
/// history through the host callback (an exception or a falsy result both
/// become an empty array), keep messages whose `taskId` is one of the
/// identity ids, then stable-sort by the `(ts || 0)` number key with V8's
/// NaN-maps-to-+0 comparator policy.
fn collect_entries<'env>(
    members: L<'env>,
    identity_ids: &[L<'env>],
    load_history: L<'env>,
) -> Result<Vec<Entry<'env>>> {
    let session_ids = collect_session_ids(members)?;
    let mut entries: Vec<Entry> = Vec::new();
    for session_id in session_ids {
        let loaded = load_history.catch(|| load_history.call_plain(&[session_id]))?;
        let history = match loaded {
            Some(value) if value.truthy()? => value,
            _ => members.from_value(&J::Array(vec![]))?,
        };
        history.for_each(|message| {
            let task_id = if message.nullish()? {
                None
            } else {
                Some(message.get(c"taskId")?)
            };
            let Some(task_id) = task_id else {
                return Ok(());
            };
            if !contains(identity_ids, task_id)? {
                return Ok(());
            }
            let ts = message.get(c"ts")?;
            let truthy = ts.truthy()?;
            let key = core::number_or_zero(truthy, if truthy { ts.number()? } else { 0.0 });
            entries.push(Entry {
                session_id,
                message,
                key,
            });
            Ok(())
        })?;
    }
    entries.sort_by(|left, right| core::compare_number_keys(left.key, right.key));
    Ok(entries)
}

/// Canonical `{sessionId, message}` projection across every session a task's
/// lineage touches, sorted by message timestamp.
#[napi]
pub fn task_board_canonical_messages(
    env: Env,
    members: Unknown<'_>,
    identity_ids: Unknown<'_>,
    load_history: Unknown<'_>,
) -> Result<sys::napi_value> {
    let members = L::new(&env, members);
    let identity_ids = collect_identity_ids(L::new(&env, identity_ids))?;
    let load_history = L::new(&env, load_history);
    let entries = collect_entries(members, &identity_ids, load_history)?;
    let out = members.from_value(&J::Array(vec![]))?;
    for (index, entry) in entries.iter().enumerate() {
        let projected = members.from_value(&J::Object(vec![]))?;
        projected.set(c"sessionId", entry.session_id)?;
        projected.set(c"message", entry.message)?;
        out.set_element(index as u32, projected)?;
    }
    Ok(out.raw())
}

/// The task body projection: the earliest `role === 'user' &&
/// taskStart === true` canonical message, then a planned record's trimmed
/// description, then the first resolvable legacy ref, then an empty body.
#[napi]
pub fn task_board_canonical_task_body(
    env: Env,
    members: Unknown<'_>,
    identity_ids: Unknown<'_>,
    task: Unknown<'_>,
    load_history: Unknown<'_>,
    message_text: Unknown<'_>,
) -> Result<sys::napi_value> {
    let members = L::new(&env, members);
    let identity_ids = collect_identity_ids(L::new(&env, identity_ids))?;
    let task = L::new(&env, task);
    let load_history = L::new(&env, load_history);
    let message_text = L::new(&env, message_text);
    let null = members.from_value(&J::Null)?;
    let entries = collect_entries(members, &identity_ids, load_history)?;
    for entry in &entries {
        if !entry.message.get(c"role")?.is_string("user")? {
            continue;
        }
        if !entry.message.get(c"taskStart")?.is_true()? {
            continue;
        }
        let task_text = entry.message.get(c"taskText")?;
        let text = if task_text.truthy()? {
            js_string(task_text)?
        } else {
            js_string(message_text.call_plain(&[entry.message])?)?
        };
        let id = entry.message.get(c"id")?;
        let message_id = if id.truthy()? { id } else { null };
        let out = members.from_value(&J::Object(vec![]))?;
        out.set(c"text", members.from_value(&J::String(text))?)?;
        out.set(c"messageId", message_id)?;
        out.set(c"sessionId", entry.session_id)?;
        out.set(c"legacy", members.from_value(&J::Bool(false))?)?;
        return Ok(out.raw());
    }
    if task.get(c"recordType")?.is_string("planned")? {
        let description = task.get(c"description")?;
        let picked = if description.truthy()? {
            description
        } else {
            let title = task.get(c"title")?;
            if title.truthy()? {
                title
            } else {
                members.from_value(&J::string(""))?
            }
        };
        let text = js_string(picked)?.trim();
        if !text.is_empty() {
            let session_id = task.get(c"chatSessionId")?;
            let session_id = if session_id.truthy()? {
                session_id
            } else {
                null
            };
            let out = members.from_value(&J::Object(vec![]))?;
            out.set(c"text", members.from_value(&J::String(text))?)?;
            out.set(c"messageId", null)?;
            out.set(c"sessionId", session_id)?;
            out.set(c"legacy", members.from_value(&J::Bool(false))?)?;
            return Ok(out.raw());
        }
    }
    // Old cards predate taskId metadata; their ref remains a read-only
    // fallback. The per-ref early exit is preserved: later histories load
    // only while every earlier ref missed.
    let refs = task.get(c"refs")?;
    if refs.truthy()? {
        let mut found: Option<sys::napi_value> = None;
        refs.for_each(|reference| {
            if found.is_some() {
                return Ok(());
            }
            let session_id = reference.get(c"sessionId")?;
            let loaded = load_history.catch(|| load_history.call_plain(&[session_id]))?;
            let history = match loaded {
                Some(value) if value.truthy()? => value,
                _ => reference.from_value(&J::Array(vec![]))?,
            };
            let user_msg_id = reference.get(c"userMsgId")?;
            if !user_msg_id.truthy()? {
                return Ok(());
            }
            let mut matched: Option<L> = None;
            history.for_each(|candidate| {
                if matched.is_some() {
                    return Ok(());
                }
                if candidate.nullish()? {
                    return Ok(());
                }
                let id = candidate.get(c"id")?;
                // The retired comparator re-read `ref.userMsgId` for every
                // candidate (`candidate?.id === ref.userMsgId`).
                if id.equals(reference.get(c"userMsgId")?)? {
                    matched = Some(candidate);
                }
                Ok(())
            })?;
            let Some(message) = matched else {
                return Ok(());
            };
            let text = message_text.call_plain(&[message])?;
            let id = message.get(c"id")?;
            let message_id = if id.truthy()? {
                id
            } else {
                reference.from_value(&J::Null)?
            };
            let out = reference.from_value(&J::Object(vec![]))?;
            out.set(c"text", text)?;
            out.set(c"messageId", message_id)?;
            out.set(c"sessionId", reference.get(c"sessionId")?)?;
            out.set(c"legacy", reference.from_value(&J::Bool(true))?)?;
            found = Some(out.raw());
            Ok(())
        })?;
        if let Some(raw) = found {
            return Ok(raw);
        }
    }
    let out = members.from_value(&J::Object(vec![]))?;
    out.set(c"text", members.from_value(&J::string(""))?)?;
    out.set(c"messageId", null)?;
    out.set(c"sessionId", null)?;
    out.set(c"legacy", members.from_value(&J::Bool(true))?)?;
    Ok(out.raw())
}

/// `tsk-` plus the first 32 hex characters of
/// sha256(`${source}\0${requestKey}`); both sides take the template's
/// ToString coercion, so a Symbol throws exactly like the retired helper.
#[napi]
pub fn task_board_stable_task_id(
    env: Env,
    source: Unknown<'_>,
    request_key: Unknown<'_>,
) -> Result<sys::napi_value> {
    let carrier = L::new(&env, source);
    let source = carrier.coerce_string()?;
    let request_key = L::new(&env, request_key).coerce_string()?;
    Ok(carrier
        .from_value(&J::String(core::stable_task_id(&source, &request_key)))?
        .raw())
}
