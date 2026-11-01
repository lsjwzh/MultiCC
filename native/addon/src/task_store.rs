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
