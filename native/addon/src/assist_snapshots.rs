//! Legacy direct Node startup has no gateway to schedule screenshot retention.
use multicc_core::assist_snapshots;
use napi::{Error, Result};
use napi_derive::napi;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::{sync::oneshot, task::JoinHandle};

#[napi]
pub struct AssistSnapshotRetention {
    worker: Mutex<Option<(oneshot::Sender<()>, JoinHandle<()>)>>,
}

#[napi]
impl AssistSnapshotRetention {
    #[napi(constructor)]
    pub fn new(root: String) -> Result<Self> {
        let root = PathBuf::from(root);
        assist_snapshots::validate_root(&root).map_err(|e| Error::from_reason(e.to_string()))?;
        let (stop, stopped) = oneshot::channel();
        let task = napi::bindgen_prelude::spawn(assist_snapshots::run(root, stopped));
        Ok(Self {
            worker: Mutex::new(Some((stop, task))),
        })
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let worker = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((stop, task)) = worker {
            let _ = stop.send(());
            task.await.map_err(|e| Error::from_reason(e.to_string()))?;
        }
        Ok(())
    }
}
