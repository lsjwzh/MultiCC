//! N-API surface for task-history retention policy and deletion refusal formatting
//! (former `src/session/task-history-retention.js`).
#![cfg_attr(test, allow(dead_code))]

use crate::js_live::LiveValue as L;
use multicc_core::{
    js::JsValue as V,
    task_history_retention::{
        self as core, MessageSummary, ReferencedTask, RefusalTaskInput, TaskRefSummary, TaskSummary,
    },
};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::Cell, collections::HashMap, ptr, rc::Rc};

fn new_object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
}

fn new_array(anchor: L<'_>, len: usize) -> Result<L<'_>> {
    let mut raw = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_array_with_length(anchor.env(), len, &mut raw) })?;
    Ok(L::from_raw(anchor.env(), raw))
}

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&V::Number(length))?;
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: value.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe {
        sys::napi_define_properties(function.env(), function.raw(), 1, &descriptor)
    })?;
    Ok(function)
}

fn optional_string(value: L<'_>) -> Result<Option<String>> {
    if !value.truthy()? {
        return Ok(None);
    }
    if let Some(s) = value.string()? {
        return Ok(Some(s.to_string_lossy()));
    }
    Ok(Some(value.coerce_string()?.to_string_lossy()))
}

// WeakMap ephemeron capture so retention closures never root V8 cycles.
struct Capture {
    env: sys::napi_env,
    map: sys::napi_ref,
    key: Cell<sys::napi_ref>,
}

impl Capture {
    fn new(anchor: L<'_>) -> Result<Rc<Self>> {
        let map = anchor.global()?.get(c"WeakMap")?.construct(&[])?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(anchor.env(), map.raw(), 1, &mut reference)
        })?;
        Ok(Rc::new(Self {
            env: anchor.env(),
            map: reference,
            key: Cell::new(ptr::null_mut()),
        }))
    }

    fn map<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.map, &mut value) })?;
        Ok(L::from_raw(anchor.env(), value))
    }

    fn bind(&self, function: L<'_>, value: L<'_>) -> Result<()> {
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(self.env, function.raw(), 0, &mut reference)
        })?;
        self.key.set(reference);
        let map = self.map(function)?;
        map.get(c"set")?.call(map, &[function, value])?;
        Ok(())
    }

    fn read<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let mut key = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(self.env, self.key.get(), &mut key)
        })?;
        if key.is_null() {
            return Err(anchor.type_error("task history retention state is unavailable"));
        }
        let map = self.map(anchor)?;
        map.get(c"get")?
            .call(map, &[L::from_raw(anchor.env(), key)])
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if !self.env.is_null() {
            unsafe {
                if !self.key.get().is_null() {
                    sys::napi_delete_reference(self.env, self.key.get());
                }
                sys::napi_delete_reference(self.env, self.map);
            }
        }
    }
}

/// Snapshot of the board's task table: every task in insertion order, the
/// id-indexed lookup, and the `deletedTaskIds` list used to spot orphan stamps.
type BoardSnapshot = (Vec<TaskSummary>, HashMap<String, TaskSummary>, Vec<String>);

fn read_board_tasks(board: L<'_>) -> Result<BoardSnapshot> {
    let tasks_obj = board.get(c"tasks")?;
    let mut all = Vec::new();
    let mut by_id = HashMap::new();
    if tasks_obj.truthy()? && !tasks_obj.nullish()? {
        let object_ctor = board.global()?.get(c"Object")?;
        let values = object_ctor
            .get(c"values")?
            .call(object_ctor, &[tasks_obj])?;
        let len = values.get(c"length")?.number()? as u32;
        all.reserve(len as usize);
        for i in 0..len {
            let task = values.element(i)?;
            if task.nullish()? {
                continue;
            }
            let id = optional_string(task.get(c"id")?)?.unwrap_or_default();
            let title = optional_string(task.get(c"title")?)?;
            let deleting = task.get(c"deleting")?.truthy()?;
            let chat_session_id = optional_string(task.get(c"chatSessionId")?)?;
            let worker_session_id =
                optional_string(task.optional(c"routing")?.optional(c"workerSessionId")?)?;
            let mut refs = Vec::new();
            let raw_refs = task.get(c"refs")?;
            if raw_refs.truthy()? && raw_refs.is_array()? {
                let rlen = raw_refs.get(c"length")?.number()? as u32;
                refs.reserve(rlen as usize);
                for j in 0..rlen {
                    let r = raw_refs.element(j)?;
                    if r.nullish()? {
                        continue;
                    }
                    refs.push(TaskRefSummary {
                        session_id: optional_string(r.get(c"sessionId")?)?,
                        user_msg_id: optional_string(r.get(c"userMsgId")?)?,
                        assistant_msg_id: optional_string(r.get(c"assistantMsgId")?)?,
                    });
                }
            }
            let summary = TaskSummary {
                id: id.clone(),
                title,
                deleting,
                chat_session_id,
                worker_session_id,
                refs,
            };
            if !id.is_empty() {
                by_id.insert(id, summary.clone());
            }
            all.push(summary);
        }
    }

    let mut deleted_ids = Vec::new();
    let raw_deleted = board.get(c"deletedTaskIds")?;
    if raw_deleted.truthy()? && raw_deleted.is_array()? {
        let dlen = raw_deleted.get(c"length")?.number()? as u32;
        deleted_ids.reserve(dlen as usize);
        for i in 0..dlen {
            if let Some(id) = optional_string(raw_deleted.element(i)?)? {
                deleted_ids.push(id);
            }
        }
    }
    Ok((all, by_id, deleted_ids))
}

fn read_messages_array(messages_val: L<'_>) -> Result<Vec<MessageSummary>> {
    let len = messages_val.get(c"length")?.number()? as u32;
    let mut out = Vec::with_capacity(len as usize);
    for i in 0..len {
        let msg = messages_val.element(i)?;
        if msg.nullish()? {
            continue;
        }
        out.push(MessageSummary {
            id: optional_string(msg.get(c"id")?)?,
            task_id: optional_string(msg.get(c"taskId")?)?,
        });
    }
    Ok(out)
}

/// Calls `loadHistory(sessionId)`, turning `ENOENT` into `Ok(None)` and
/// rethrowing any other error with its original JS exception identity.
fn load_history_or_enoent<'a>(
    load_history: L<'a>,
    session_id: L<'a>,
) -> Result<Option<Vec<MessageSummary>>> {
    match load_history.call_plain(&[session_id]) {
        Ok(messages) => Ok(Some(read_messages_array(messages)?)),
        Err(err) => {
            if let Some(exc) = load_history.exception_value()? {
                let is_enoent = !exc.nullish()? && exc.get(c"code")?.is_string("ENOENT")?;
                if is_enoent {
                    return Ok(None);
                }
                return Err(exc.throw_error());
            }
            Err(err)
        }
    }
}

fn references_to_js<'a>(anchor: L<'a>, refs: &[ReferencedTask]) -> Result<L<'a>> {
    let arr = new_array(anchor, refs.len())?;
    for (idx, item) in refs.iter().enumerate() {
        let obj = new_object(anchor)?;
        obj.set(c"id", anchor.from_value(&V::string(&item.id))?)?;
        obj.set(c"title", anchor.from_value(&V::string(&item.title))?)?;
        obj.set(c"via", anchor.from_value(&V::string(item.via))?)?;
        arr.set_element(idx as u32, obj)?;
    }
    Ok(arr)
}

fn strings_to_js<'a>(anchor: L<'a>, items: &[String]) -> Result<L<'a>> {
    let arr = new_array(anchor, items.len())?;
    for (idx, item) in items.iter().enumerate() {
        arr.set_element(idx as u32, anchor.from_value(&V::string(item))?)?;
    }
    Ok(arr)
}

#[derive(Clone, Copy)]
enum RetentionMethod {
    CanDeleteSession,
    IsMessageProtected,
    ReferencingTasks,
    SessionDeletionFacts,
}

fn bind_retention_method<'a>(
    env: &'a Env,
    anchor: L<'a>,
    name: &str,
    length: f64,
    method: RetentionMethod,
    ports: L<'a>,
) -> Result<L<'a>> {
    let capture = Capture::new(anchor)?;
    let retained = Rc::clone(&capture);
    let func =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let arg = |idx| -> Result<L<'_>> {
                if idx < ctx.length() {
                    Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(idx)?))
                } else {
                    Ok(absent)
                }
            };
            let ports = retained.read(absent)?;
            let get_board = ports.get(c"getBoard")?;
            let get_record = ports.get(c"getRecord")?;
            let load_history = ports.get(c"loadHistory")?;
            let session_id_val = arg(0)?;
            let session_id = optional_string(session_id_val)?.unwrap_or_default();

            let result = match method {
                RetentionMethod::IsMessageProtected => {
                    let msg_val = arg(1)?;
                    let msg = MessageSummary {
                        id: optional_string(msg_val.get(c"id")?)?,
                        task_id: optional_string(msg_val.get(c"taskId")?)?,
                    };
                    let board = get_board.call_plain(&[])?;
                    let (all_tasks, by_id, deleted_ids) = read_board_tasks(board)?;
                    let protected = core::is_message_protected(
                        &session_id,
                        &msg,
                        &by_id,
                        &all_tasks,
                        &deleted_ids,
                    );
                    absent.from_value(&V::Bool(protected))?
                }
                RetentionMethod::CanDeleteSession => {
                    let record = get_record.call_plain(&[session_id_val])?;
                    if !record.nullish()? && record.get(c"taskExecutionSlot")?.is_true()? {
                        absent.from_value(&V::Bool(true))?
                    } else {
                        let board = get_board.call_plain(&[])?;
                        let (all_tasks, _, _) = read_board_tasks(board)?;
                        let active = core::active_tasks(&all_tasks);
                        if active
                            .iter()
                            .any(|t| core::has_session_link(t, &session_id))
                        {
                            absent.from_value(&V::Bool(false))?
                        } else {
                            match load_history_or_enoent(load_history, session_id_val)? {
                                None => absent.from_value(&V::Bool(true))?,
                                Some(messages) => {
                                    let ids: std::collections::HashSet<&str> =
                                        active.iter().map(|t| t.id.as_str()).collect();
                                    let referenced = messages.iter().any(|m| {
                                        m.task_id.as_deref().is_some_and(|tid| ids.contains(tid))
                                    });
                                    absent.from_value(&V::Bool(!referenced))?
                                }
                            }
                        }
                    }
                }
                RetentionMethod::ReferencingTasks => {
                    let messages =
                        load_history_or_enoent(load_history, session_id_val)?.unwrap_or_default();
                    let board = get_board.call_plain(&[])?;
                    let (all_tasks, _, _) = read_board_tasks(board)?;
                    let refs = core::collect_references(&session_id, &all_tasks, &messages);
                    references_to_js(absent, &refs)?
                }
                RetentionMethod::SessionDeletionFacts => {
                    let record = get_record.call_plain(&[session_id_val])?;
                    let execution_slot =
                        !record.nullish()? && record.get(c"taskExecutionSlot")?.is_true()?;
                    let facts = if execution_slot {
                        core::compute_session_deletion_facts(&session_id, true, &[], &[])
                    } else {
                        let board = get_board.call_plain(&[])?;
                        let (all_tasks, _, _) = read_board_tasks(board)?;
                        let messages = load_history_or_enoent(load_history, session_id_val)?
                            .unwrap_or_default();
                        core::compute_session_deletion_facts(
                            &session_id,
                            false,
                            &all_tasks,
                            &messages,
                        )
                    };
                    let out = new_object(absent)?;
                    out.set(
                        c"executionSlot",
                        absent.from_value(&V::Bool(facts.execution_slot))?,
                    )?;
                    out.set(
                        c"sessionLinks",
                        strings_to_js(absent, &facts.session_links)?,
                    )?;
                    out.set(
                        c"routingLinks",
                        strings_to_js(absent, &facts.routing_links)?,
                    )?;
                    out.set(
                        c"messageLinks",
                        strings_to_js(absent, &facts.message_links)?,
                    )?;
                    out.set(c"references", references_to_js(absent, &facts.references)?)?;
                    out
                }
            };
            Ok(result.raw())
        })?;
    let wrapped = arity(L::new(env, func.into_unknown(env)?), length)?;
    capture.bind(wrapped, ports)?;
    Ok(wrapped)
}

fn create_retention_live<'a>(env: &'a Env, deps: L<'a>) -> Result<L<'a>> {
    if deps.nullish()? {
        return Err(deps.type_error("Cannot destructure property 'getBoard' of nullish"));
    }
    let ports = new_object(deps)?;
    ports.set(c"getBoard", deps.get(c"getBoard")?)?;
    ports.set(c"getRecord", deps.get(c"getRecord")?)?;
    ports.set(c"loadHistory", deps.get(c"loadHistory")?)?;

    let service = new_object(deps)?;
    service.set(
        c"canDeleteSession",
        bind_retention_method(
            env,
            deps,
            "canDeleteSession",
            1.0,
            RetentionMethod::CanDeleteSession,
            ports,
        )?,
    )?;
    service.set(
        c"isMessageProtected",
        bind_retention_method(
            env,
            deps,
            "isMessageProtected",
            2.0,
            RetentionMethod::IsMessageProtected,
            ports,
        )?,
    )?;
    service.set(
        c"referencingTasks",
        bind_retention_method(
            env,
            deps,
            "referencingTasks",
            1.0,
            RetentionMethod::ReferencingTasks,
            ports,
        )?,
    )?;
    service.set(
        c"sessionDeletionFacts",
        bind_retention_method(
            env,
            deps,
            "sessionDeletionFacts",
            1.0,
            RetentionMethod::SessionDeletionFacts,
            ports,
        )?,
    )?;
    service.freeze()
}

fn task_history_refusal_live<'a>(error_val: L<'a>) -> Result<L<'a>> {
    let err = if error_val.undefined()? {
        new_object(error_val)?
    } else if error_val.kind()? == sys::ValueType::napi_null {
        return Err(error_val.type_error("Cannot read properties of null (reading 'tasks')"));
    } else {
        error_val
    };
    let raw_tasks = err.get(c"tasks")?;
    let tasks_arr = if raw_tasks.is_array()? {
        raw_tasks
    } else {
        new_array(err, 0)?
    };
    let len = tasks_arr.get(c"length")?.number()? as u32;
    let mut parsed_tasks = Vec::with_capacity(len as usize);
    let mut task_ids: Vec<L<'_>> = Vec::with_capacity(len as usize);
    for i in 0..len {
        let item = tasks_arr.element(i)?;
        if item.nullish()? || !item.truthy()? {
            continue;
        }
        let id_val = item.get(c"id")?;
        if id_val.truthy()? {
            task_ids.push(id_val);
        }
        parsed_tasks.push(RefusalTaskInput {
            id: optional_string(id_val)?,
            title: optional_string(item.get(c"title")?)?,
            via: optional_string(item.get(c"via")?)?,
        });
    }

    let code_val = err.get(c"code")?;
    let code = if code_val.truthy()? {
        code_val
    } else {
        err.from_value(&V::string(core::DEFAULT_REFUSAL_CODE))?
    };

    let task_ids_js = new_array(err, task_ids.len())?;
    for (idx, id_val) in task_ids.into_iter().enumerate() {
        task_ids_js.set_element(idx as u32, id_val)?;
    }

    let reasons = new_array(err, 1)?;
    reasons.set_element(0, err.from_value(&V::string(core::REFUSAL_REASON))?)?;

    let message = core::format_refusal_message(&parsed_tasks);

    let out = new_object(err)?;
    out.set(c"ok", err.from_value(&V::Bool(false))?)?;
    out.set(c"code", code)?;
    out.set(c"blocked", err.from_value(&V::Bool(true))?)?;
    out.set(c"reasons", reasons)?;
    out.set(c"tasks", tasks_arr)?;
    out.set(c"taskIds", task_ids_js)?;
    out.set(c"error", err.from_value(&V::string(&message))?)?;
    Ok(out)
}

#[napi]
pub fn create_task_history_retention(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(create_retention_live(&env, L::new(&env, deps))?.raw())
}

#[napi]
pub fn task_history_refusal(env: Env, error: Option<Unknown<'_>>) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let err_val = error.map_or(absent, |v| L::new(&env, v));
    Ok(task_history_refusal_live(err_val)?.raw())
}

#[napi]
pub fn task_history_retention_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = new_object(anchor)?;
    let create_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createTaskHistoryRetention",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let deps = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(create_retention_live(ctx.env, deps)?.raw())
        },
    )?;
    let refusal_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "taskHistoryRefusal",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let err = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(task_history_refusal_live(err)?.raw())
        },
    )?;
    api.set(
        c"createTaskHistoryRetention",
        arity(L::new(&env, create_fn.into_unknown(&env)?), 1.0)?,
    )?;
    api.set(
        c"taskHistoryRefusal",
        arity(L::new(&env, refusal_fn.into_unknown(&env)?), 0.0)?,
    )?;
    Ok(api.raw())
}
