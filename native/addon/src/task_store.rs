use crate::guard::guard;
use multicc_core::task_store::TaskStore;
use napi::Result;
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
