mod progress;
use crate::guard::guard;
use crate::js_live::LiveValue;
use multicc_core::{
    js::{self, JsValue as V},
    task_shell::reference::{SnapshotPairTracker, SNAPSHOT_BYTES, SNAPSHOT_FIELDS},
    task_store::TaskStore,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::sync::{Mutex, MutexGuard};
// 持锁区 panic 毒化后取回内部状态，并回滚可能遗留的事务。
fn lock_store(inner: &Mutex<TaskStore>) -> MutexGuard<'_, TaskStore> {
    match inner.lock() {
        Ok(store) => store,
        Err(poisoned) => {
            let mut store = poisoned.into_inner();
            store.recover_after_panic();
            inner.clear_poison();
            store
        }
    }
}
#[napi]
pub struct RustTaskStore {
    inner: Mutex<TaskStore>,
}
#[napi]
impl RustTaskStore {
    #[napi(constructor)]
    pub fn new(file: String) -> Result<Self> {
        guard("TASK_STORE_PANIC", || {
            Ok(Self {
                inner: Mutex::new(TaskStore::open(&file).map_err(napi::Error::from_reason)?),
            })
        })
    }
    #[napi]
    pub fn run(&self, input: String) -> Result<String> {
        guard("TASK_STORE_PANIC", || {
            lock_store(&self.inner)
                .run(&input)
                .map_err(napi::Error::from_reason)
        })
    }
}
#[napi]
pub fn task_store_protocol_version() -> u32 {
    1
}
// 启动闸门：打开前只读探测是否需要迁移；需要时由 migrateTaskStore 单独打开、迁移并立刻
// 关闭连接（返回迁移报告），之后正式打开的就是新版本库。
#[napi]
pub fn task_store_migration_pending(file: String) -> bool {
    multicc_core::task_store::migration_pending(&file)
}
#[napi]
pub fn migrate_task_store(file: String) -> Result<String> {
    guard("TASK_STORE_PANIC", || {
        let mut store = TaskStore::open(&file).map_err(napi::Error::from_reason)?;
        store
            .run(r#"{"op":"migration"}"#)
            .map_err(napi::Error::from_reason)
    })
}

#[napi]
pub fn task_shell_reference(op: String, raw: String) -> Result<String> {
    multicc_core::task_shell::reference::request(&op, &raw).map_err(napi::Error::from_reason)
}

fn snapshot_value(value: LiveValue<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
}

pub(crate) fn snapshot_live<'a>(
    task: LiveValue<'a>,
    history: LiveValue<'a>,
    active_turn: LiveValue<'a>,
    budget: usize,
) -> Result<LiveValue<'a>> {
    if !history.is_array()? {
        return Err(napi::Error::from_reason(
            "task reference history must be an array",
        ));
    }
    let len = history.get(c"length")?.number()? as u32;
    let mut tracker = SnapshotPairTracker::new(
        snapshot_value(task)?,
        Some(snapshot_value(active_turn)?),
        budget,
    );
    let env = history.env();
    for index in 0..len {
        // 阶段 1 仅读标量元信息，不碰 content / tools，防止大历史正文跨 N-API 拷贝。
        let mut scope = std::ptr::null_mut();
        napi::check_status!(unsafe { sys::napi_open_handle_scope(env, &mut scope) })?;
        let result = (|| -> Result<()> {
            let row = history.element(index)?;
            if !row.truthy()? {
                return Ok(());
            }
            let task = snapshot_value(row.get(c"taskId")?)?;
            let role = snapshot_value(row.get(c"role")?)?;
            let turn = snapshot_value(row.get(c"turnId")?)?;
            let unfinished = row.get(c"_interim")?.truthy()?
                || row.get(c"partial")?.truthy()?
                || row.get(c"cancelled")?.truthy()?
                || row.get(c"error")?.truthy()?;
            tracker.push_meta(index as usize, &task, &role, &turn, unfinished);
            Ok(())
        })();
        napi::check_status!(unsafe { sys::napi_close_handle_scope(env, scope) })?;
        result?;
    }
    let output = tracker.finish_from_pairs(|index| -> Result<V> {
        // 阶段 2 仅从尾部配对倒序按需读取能装进预算的那几条记录的正文。
        let mut scope = std::ptr::null_mut();
        napi::check_status!(unsafe { sys::napi_open_handle_scope(env, &mut scope) })?;
        let result = (|| -> Result<V> {
            let row = history.element(index as u32)?;
            let mut fields = Vec::new();
            for key in SNAPSHOT_FIELDS {
                let value = row.get_key(row.from_value(&V::from(key))?)?;
                if !value.undefined()? {
                    fields.push((key, snapshot_value(value)?));
                }
            }
            Ok(V::object(fields))
        })();
        napi::check_status!(unsafe { sys::napi_close_handle_scope(env, scope) })?;
        result
    })?;
    history.from_value(&output)
}

#[napi]
pub fn task_shell_snapshot(
    env: Env,
    task: Unknown<'_>,
    history: Unknown<'_>,
    active_turn: Unknown<'_>,
    max_bytes: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw_budget = js::js_to_number(&snapshot_value(LiveValue::new(&env, max_bytes))?);
    let budget = if raw_budget.is_finite() && raw_budget >= 0.0 {
        raw_budget.min(usize::MAX as f64) as usize
    } else {
        SNAPSHOT_BYTES
    };
    Ok(snapshot_live(
        LiveValue::new(&env, task),
        LiveValue::new(&env, history),
        LiveValue::new(&env, active_turn),
        budget,
    )?
    .raw())
}

#[napi]
pub fn task_shell_input(
    env: Env,
    raw: Unknown<'_>,
    internal_dispatch: bool,
) -> Result<sys::napi_value> {
    let live = LiveValue::new(&env, raw);
    let input = unsafe { crate::js_bridge::read_value(env.raw(), live.raw(), 0, &mut Vec::new())? };
    let payload = multicc_core::task_shell::chat::normalize_http(&input, internal_dispatch)
        .map_err(|error| {
            napi::Error::from_reason(format!(
                "TASK_RULE:{}",
                serde_json::json!({"code":error.code,"message":error.message,"status":400})
            ))
        })?;
    unsafe { crate::js_bridge::write_value(env.raw(), &payload) }
}

#[napi]
pub fn task_shell_reference_value(
    env: Env,
    op: String,
    value: Unknown<'_>,
    id: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::route_response::{call, fields, string, text};
    use napi::bindgen_prelude::FromNapiValue;
    let v = LiveValue::new(&env, value);
    let input = match op.as_str() {
        "verify" => fields(v, &[("snapshot", v), ("id", LiveValue::new(&env, id))])?,
        "estimate" => {
            if v.nullish()? {
                text(v, "")?
            } else {
                string(v)?
            }
        }
        _ => v,
    };
    let json = v.global()?.get(c"JSON")?;
    let wire = call(json, c"stringify", &[input])?;
    let wire = unsafe { String::from_napi_value(env.raw(), wire.raw()) }?;
    let answer = task_shell_reference(op, wire)?;
    Ok(call(json, c"parse", &[text(v, &answer)?])?.raw())
}

#[napi]
pub fn task_shell_context_api(e: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::{
        host_methods::{arg, default_object, env, function, raw},
        js_iteration::read,
        route_response::{fields, null, num, text},
    };
    let anchor = LiveValue::new(&e, anchor);
    let api = fields(anchor, &[])?;
    for (name, op, count) in [
        ("hash", "hash", 1),
        ("estimateTokens", "estimate", 1),
        ("renderSnapshots", "render", 1),
        ("renderLazyContextPrompt", "lazy-prompt", 1),
        ("verifySnapshot", "verify", 2),
    ] {
        api.set_key(
            text(anchor, name)?,
            function(anchor, name, count, 2, move |s, a| {
                Ok(raw(
                    s,
                    task_shell_reference_value(env(s), op.to_owned(), arg(a[0])?, arg(a[1])?)?,
                ))
            })?,
        )?;
    }
    api.set(
        c"snapshotHistory",
        function(anchor, "snapshotHistory", 2, 3, |s, a| {
            let options = default_object(a[2])?;
            let active = read(options, c"activeTurnId")?;
            let max = read(options, c"maxBytes")?;
            Ok(raw(
                s,
                task_shell_snapshot(
                    env(s),
                    arg(a[0])?,
                    arg(a[1])?,
                    arg(if active.undefined()? {
                        null(s)?
                    } else {
                        active
                    })?,
                    arg(if max.undefined()? {
                        num(s, 12000.)?
                    } else {
                        max
                    })?,
                )?,
            ))
        })?,
    )?;
    Ok(api.raw())
}
