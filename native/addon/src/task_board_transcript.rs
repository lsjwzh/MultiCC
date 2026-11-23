//! Live-value adapter for the task-board transcript projections. Session
//! histories and message text stay host callbacks; this module replays the
//! exact property reads, truthiness checks, callback boundaries and exception
//! handling of the retired Node helpers.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{string::compare_units, JsString, JsValue as J},
    task_board_transcript as core,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::collections::HashMap;

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

/// JS truthiness of a number: NaN and both zeroes are falsy.
fn number_truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `history.find(candidate => candidate?.id === wanted())` with the wanted
/// value re-read per candidate, exactly like the retired comparators re-read
/// `ref.userMsgId` / `ref.assistantMsgId`.
fn find_by_id<'env>(
    history: L<'env>,
    wanted: impl Fn() -> Result<L<'env>>,
) -> Result<Option<L<'env>>> {
    let mut found: Option<L> = None;
    history.for_each(|candidate| {
        if found.is_some() || candidate.nullish()? {
            return Ok(());
        }
        let id = candidate.get(c"id")?;
        if id.equals(wanted()?)? {
            found = Some(candidate);
        }
        Ok(())
    })?;
    Ok(found)
}

/// The option fields the retired `add` closure destructured, with the
/// caller-side reads already replayed (`excerpt = ''`,
/// `fallbackCreatedAt = 0` defaults included).
struct ImportOptions<'env> {
    excerpt: L<'env>,
    canonical_body: bool,
    created_at: L<'env>,
}

/// The retired `imported` Map: insertion-ordered live entries plus a
/// message-id index for the dedupe-and-upgrade rule. Message ids are
/// `legacy:` + hex, so a lossy string key is exact.
struct Importer<'env> {
    carrier: L<'env>,
    message_text: L<'env>,
    entries: Vec<L<'env>>,
    index: HashMap<String, usize>,
}

impl<'env> Importer<'env> {
    /// One `add(sessionId, message, options)` call, read for read: role
    /// selection and lowercasing, the `?? excerpt` content fallback, the
    /// fresh `{content}` object for the host text callback, the empty-text
    /// skip for non-assistants, the trimmed source id, the
    /// `Number(ts) || Number(fallback) || 0` timestamp, the identity string,
    /// the digest dedupe with canonical upgrade, and the entry shape.
    fn add(&mut self, session_id: L, message: L, options: ImportOptions<'env>) -> Result<()> {
        let message_present = !message.nullish()?;
        let role_raw = if message_present {
            Some(message.get(c"role")?)
        } else {
            None
        };
        let picked = match role_raw {
            Some(value) if value.truthy()? => value,
            _ => {
                if options.canonical_body {
                    self.carrier.from_value(&J::string("user"))?
                } else {
                    self.carrier.from_value(&J::string(""))?
                }
            }
        };
        let role = js_string(picked)?.to_lowercase();
        if role != "user" && role != "assistant" {
            return Ok(());
        }
        let content_raw = if message_present {
            Some(message.get(c"content")?)
        } else {
            None
        };
        let content = match content_raw {
            Some(value) if !value.nullish()? => value,
            _ => options.excerpt,
        };
        let text_input = self.carrier.from_value(&J::Object(vec![]))?;
        text_input.set(c"content", content)?;
        let text = self.message_text.call_plain(&[text_input])?;
        if !text.truthy()? && role != "assistant" {
            return Ok(());
        }
        let id_raw = if message_present {
            Some(message.get(c"id")?)
        } else {
            None
        };
        let id_picked = match id_raw {
            Some(value) if value.truthy()? => value,
            _ => self.carrier.from_value(&J::string(""))?,
        };
        let source_message_id = js_string(id_picked)?.trim();
        let ts = if message_present {
            Some(message.get(c"ts")?)
        } else {
            None
        };
        let first = match ts {
            Some(value) => value.explicit_number()?,
            None => f64::NAN,
        };
        let created_at = if number_truthy(first) {
            first
        } else {
            let second = options.created_at.explicit_number()?;
            if number_truthy(second) {
                second
            } else {
                0.0
            }
        };
        let identity = if !source_message_id.is_empty() {
            let mut identity = session_id.coerce_string()?;
            identity.push_str("\0id:");
            identity.push(&source_message_id);
            identity
        } else {
            let mut identity = session_id.coerce_string()?;
            identity.push_unit(0);
            identity.push(&role);
            identity.push_unit(0);
            let number = self
                .carrier
                .from_value(&J::Number(created_at))?
                .coerce_string()?;
            identity.push(&number);
            identity.push_unit(0);
            identity.push(&text.coerce_string()?);
            identity
        };
        let message_id = core::legacy_message_id(&identity);
        let key = message_id.to_string_lossy();
        if let Some(position) = self.index.get(&key) {
            if options.canonical_body {
                self.entries[*position]
                    .get(c"metadata")?
                    .set(c"canonicalBody", self.carrier.from_value(&J::Bool(true))?)?;
            }
            return Ok(());
        }
        let source_session_id = if session_id.truthy()? {
            js_string(session_id)?
        } else {
            JsString::new()
        };
        let source_session_id = source_session_id.slice_units(0, source_session_id.len().min(256));
        let short_id = source_message_id.slice_units(0, source_message_id.len().min(256));
        let source_id_value = if short_id.is_empty() {
            self.carrier.from_value(&J::Null)?
        } else {
            self.carrier.from_value(&J::String(short_id))?
        };
        let mut canonical = options.canonical_body;
        if !canonical && message_present {
            canonical = message.get(c"taskStart")?.is_true()?;
        }
        let metadata = self.carrier.from_value(&J::Object(vec![]))?;
        metadata.set(
            c"sourceSessionId",
            self.carrier.from_value(&J::String(source_session_id))?,
        )?;
        metadata.set(c"sourceMessageId", source_id_value)?;
        metadata.set(
            c"canonicalBody",
            self.carrier.from_value(&J::Bool(canonical))?,
        )?;
        metadata.set(
            c"lost",
            self.carrier.from_value(&J::Bool(!message.truthy()?))?,
        )?;
        let entry = self.carrier.from_value(&J::Object(vec![]))?;
        entry.set(
            c"messageId",
            self.carrier.from_value(&J::String(message_id))?,
        )?;
        entry.set(c"role", self.carrier.from_value(&J::String(role))?)?;
        entry.set(
            c"kind",
            self.carrier.from_value(&J::string("legacy_import"))?,
        )?;
        entry.set(c"content", content)?;
        entry.set(c"metadata", metadata)?;
        entry.set(
            c"createdAt",
            self.carrier.from_value(&J::Number(created_at))?,
        )?;
        self.index.insert(key, self.entries.len());
        self.entries.push(entry);
        Ok(())
    }
}

/// The legacy-import projection consumed by the cold-start seed: canonical
/// messages first (canonicalBody from role plus taskStart), then the per-ref
/// fallback with a per-session history cache, deduped by digest and sorted
/// by `(createdAt, messageId)`. The localeCompare tie-break only ever sees
/// `legacy:` + lowercase hex, where the ICU root order and the UTF-16 code
/// unit order agree, so `compare_units` is exact.
#[napi]
pub fn task_board_legacy_import_messages(
    env: Env,
    members: Unknown<'_>,
    identity_ids: Unknown<'_>,
    task: Unknown<'_>,
    load_history: Unknown<'_>,
    message_text: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(legacy_import(
        L::new(&env, members),
        &collect_identity_ids(L::new(&env, identity_ids))?,
        L::new(&env, task),
        L::new(&env, load_history),
        L::new(&env, message_text),
    )?
    .raw())
}

pub(crate) fn legacy_import<'a>(
    members: L<'a>,
    identity_ids: &[L<'a>],
    task: L<'a>,
    load_history: L<'a>,
    message_text: L<'a>,
) -> Result<L<'a>> {
    let mut importer = Importer {
        carrier: members,
        message_text,
        entries: Vec::new(),
        index: HashMap::new(),
    };
    let default_excerpt = members.from_value(&J::string(""))?;
    let default_created = members.from_value(&J::Number(0.0))?;
    let entries = collect_entries(members, identity_ids, load_history)?;
    for entry in &entries {
        let canonical_body = if entry.message.nullish()? {
            false
        } else if entry.message.get(c"role")?.is_string("user")? {
            entry.message.get(c"taskStart")?.is_true()?
        } else {
            false
        };
        importer.add(
            entry.session_id,
            entry.message,
            ImportOptions {
                excerpt: default_excerpt,
                canonical_body,
                created_at: default_created,
            },
        )?;
    }
    // Per-session history cache, keyed like the retired Map by the session id
    // string; non-string ids simply reload (the board schema guarantees
    // strings).
    let mut cache: HashMap<String, L> = HashMap::new();
    let refs = task.get(c"refs")?;
    if refs.truthy()? {
        refs.for_each(|reference| {
            let session_id = reference.get(c"sessionId")?;
            let cache_key = session_id.string()?.map(|key| key.to_string_lossy());
            let cached = cache_key.as_ref().and_then(|key| cache.get(key)).copied();
            let history = match cached {
                Some(value) => value,
                None => {
                    let loaded = load_history.catch(|| load_history.call_plain(&[session_id]))?;
                    let value = match loaded {
                        Some(value) if value.truthy()? => value,
                        _ => members.from_value(&J::Array(vec![]))?,
                    };
                    if let Some(key) = cache_key {
                        cache.insert(key, value);
                    }
                    value
                }
            };
            let user_msg_id = reference.get(c"userMsgId")?;
            let user = if user_msg_id.truthy()? {
                find_by_id(history, || reference.get(c"userMsgId"))?
            } else {
                None
            };
            let assistant_msg_id = reference.get(c"assistantMsgId")?;
            let assistant = if assistant_msg_id.truthy()? {
                find_by_id(history, || reference.get(c"assistantMsgId"))?
            } else {
                None
            };
            if let Some(user) = user {
                importer.add(
                    reference.get(c"sessionId")?,
                    user,
                    ImportOptions {
                        excerpt: default_excerpt,
                        canonical_body: true,
                        created_at: default_created,
                    },
                )?;
            } else {
                let excerpt = reference.get(c"excerpt")?;
                if excerpt.truthy()? {
                    importer.add(
                        reference.get(c"sessionId")?,
                        members.from_value(&J::Null)?,
                        ImportOptions {
                            excerpt: reference.get(c"excerpt")?,
                            canonical_body: true,
                            created_at: reference.get(c"ts")?,
                        },
                    )?;
                }
            }
            if let Some(assistant) = assistant {
                importer.add(
                    reference.get(c"sessionId")?,
                    assistant,
                    ImportOptions {
                        excerpt: default_excerpt,
                        canonical_body: false,
                        created_at: default_created,
                    },
                )?;
            }
            Ok(())
        })?;
    }
    let mut projected: Vec<(f64, JsString, L)> = Vec::with_capacity(importer.entries.len());
    for entry in &importer.entries {
        let created = entry.get(c"createdAt")?.number()?;
        let id = entry
            .get(c"messageId")?
            .string()?
            .expect("import entries carry a string id");
        projected.push((created, id, *entry));
    }
    projected.sort_by(|left, right| {
        core::compare_number_keys(left.0, right.0).then_with(|| compare_units(&left.1, &right.1))
    });
    let out = members.from_value(&J::Array(vec![]))?;
    for (index, (_, _, entry)) in projected.iter().enumerate() {
        out.set_element(index as u32, *entry)?;
    }
    Ok(out)
}

/// `messages.map(message => ({id, role, ts, text}))`: Array#map reads the
/// length once and then each index; every text goes through the host
/// callback with a fresh `{content}` object.
#[napi]
pub fn task_board_context_messages(
    env: Env,
    messages: Unknown<'_>,
    message_text: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(context_messages(L::new(&env, messages), L::new(&env, message_text))?.raw())
}

pub(crate) fn context_messages<'a>(messages: L<'a>, message_text: L<'a>) -> Result<L<'a>> {
    let count = messages.get(c"length")?.number()?.max(0.0) as u32;
    let out = messages.from_value(&J::Array(vec![]))?;
    for index in 0..count {
        let message = messages.element(index)?;
        let id = message.get(c"messageId")?;
        let role = message.get(c"role")?;
        let ts = message.get(c"createdAt")?;
        let text_input = messages.from_value(&J::Object(vec![]))?;
        text_input.set(c"content", message.get(c"content")?)?;
        let text = message_text.call_plain(&[text_input])?;
        let projected = messages.from_value(&J::Object(vec![]))?;
        projected.set(c"id", id)?;
        projected.set(c"role", role)?;
        projected.set(c"ts", ts)?;
        projected.set(c"text", text)?;
        out.set_element(index, projected)?;
    }
    Ok(out)
}
