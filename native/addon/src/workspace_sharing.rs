//! Temporary N-API handle. State, passwords, scope policy and persistence are
//! owned by core; only live directory/session ports remain with the host.
use multicc_core::{
    js,
    workspace_sharing::{self as sharing, Store},
};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{path::PathBuf, sync::Arc};

// Unref the TSFN so the source control task cannot keep the Node event loop
// alive. JS passes a callback holding only a WeakRef to the live read port.
type DirectoryReader = napi::threadsafe_function::ThreadsafeFunction<
    String,
    Option<bool>,
    String,
    napi::Status,
    true,
    true,
>;
type ContextReader = napi::threadsafe_function::ThreadsafeFunction<
    String,
    Option<String>,
    String,
    napi::Status,
    true,
    true,
>;

fn parse(input: &str) -> Result<js::JsValue> {
    js::json_parse(input).map_err(|_| napi::Error::from_reason("Invalid workspace-sharing input"))
}
fn clock(now: Option<f64>) -> f64 {
    now.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0)
    })
}
#[napi]
pub struct RustWorkspaceSharing {
    inner: Arc<Store>,
    control: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for RustWorkspaceSharing {
    fn drop(&mut self) {
        if let Some(task) = self
            .control
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
    }
}
#[napi]
impl RustWorkspaceSharing {
    #[napi(constructor)]
    pub fn new(shares_file: String, external_file: Option<String>) -> Result<Self> {
        Ok(Self {
            control: std::sync::Mutex::new(None),
            inner: Arc::new(
                match external_file {
                    Some(file) => Store::open(PathBuf::from(shares_file), PathBuf::from(file)),
                    None => Store::open_source(PathBuf::from(shares_file)),
                }
                .map_err(|_| napi::Error::from_reason("Workspace-sharing state unavailable"))?,
            ),
        })
    }
    #[napi]
    pub fn connect_gateway(
        &self,
        port: u32,
        capability: String,
        directory_reader: DirectoryReader,
        context_reader: ContextReader,
        auth: Option<&crate::auth_security::RustAuthSecurity>,
    ) -> Result<()> {
        if port == 0
            || port > 65535
            || capability.len() != 43
            || self
                .control
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        {
            return Err(napi::Error::from_reason(
                "invalid workspace control bootstrap",
            ));
        }
        let reader = Arc::new(directory_reader);
        let context = Arc::new(context_reader);
        let auth = auth.map(|a| a.shared_state()).transpose()?;
        *self.control.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(napi::bindgen_prelude::spawn(sharing::control::serve(
                Arc::clone(&self.inner),
                port as u16,
                capability,
                move |id| {
                    let reader = Arc::clone(&reader);
                    async move { reader.call_async(Ok(id)).await.ok().flatten() }
                },
                move |request| {
                    let context = Arc::clone(&context);
                    async move { context.call_async(Ok(request)).await.ok().flatten() }
                },
                auth,
            )));
        Ok(())
    }
    #[napi]
    pub fn query(&self, operation: String, input: String, now: Option<f64>) -> Result<String> {
        Ok(sharing::reply(self.inner.query(
            &operation,
            &parse(&input)?,
            clock(now),
        )))
    }
    /// Library compatibility adapter; production import HTTP runs the same
    /// native workflow directly from the source control task.
    #[napi]
    pub async fn import_share(
        &self,
        input: String,
        directory: DirectoryReader,
        context: ContextReader,
        now: Option<f64>,
    ) -> Result<String> {
        let directory = Arc::new(directory);
        let context = Arc::new(context);
        Ok(sharing::reply(
            sharing::source::import(
                Arc::clone(&self.inner),
                parse(&input)?,
                &move |id| {
                    let port = Arc::clone(&directory);
                    async move { port.call_async(Ok(id)).await.ok().flatten() }
                },
                &move |request| {
                    let port = Arc::clone(&context);
                    async move { port.call_async(Ok(request)).await.ok().flatten() }
                },
                now,
            )
            .await,
        ))
    }
    #[napi]
    pub fn run(
        &self,
        operation: String,
        input: String,
        now: Option<f64>,
    ) -> AsyncTask<SharingTask> {
        AsyncTask::new(SharingTask {
            inner: self.inner.clone(),
            operation,
            input,
            now,
        })
    }
}
pub struct SharingTask {
    inner: Arc<Store>,
    operation: String,
    input: String,
    now: Option<f64>,
}
impl Task for SharingTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let input = parse(&self.input)?;
        let now = clock(self.now);
        Ok(sharing::reply(self.inner.mutate(
            &self.operation,
            &input,
            now,
        )))
    }
    fn resolve(&mut self, _env: Env, result: String) -> Result<String> {
        Ok(result)
    }
}
#[napi]
pub fn workspace_sharing_parse(kind: String, input: String) -> Result<String> {
    let value = parse(&input)?;
    let result = match kind.as_str() {
        "url" => sharing::remote::normalize_url(&value),
        "blockedAddress" => Ok(sharing::remote::blocked_address(&value).into()),
        "payload" => sharing::validate_payload(&value),
        "password" => sharing::password(&value).map(|v| js::JsValue::string(&v)),
        _ => return Err(napi::Error::from_reason("Invalid workspace-sharing parser")),
    };
    Ok(sharing::reply(result))
}

/// Buffered library adapter used by isolated differential tests. Production
/// external-workspace HTTP and streaming bodies are hosted by the gateway.
#[napi(object)]
pub struct WorkspaceRemoteResponse {
    pub metadata: String,
    pub body: napi::bindgen_prelude::Buffer,
}
#[napi]
pub struct RustExternalWorkspaces {
    inner: Arc<sharing::external::Runtime>,
}
#[napi]
impl RustExternalWorkspaces {
    #[napi(constructor)]
    pub fn new(file: String) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(
                sharing::external::Runtime::open(PathBuf::from(file)).map_err(|_| {
                    napi::Error::from_reason("External workspace state unavailable")
                })?,
            ),
        })
    }
    #[napi]
    pub fn query(&self, operation: String, input: String, now: Option<f64>) -> Result<String> {
        Ok(sharing::reply(self.inner.query(
            &operation,
            &parse(&input)?,
            clock(now),
        )))
    }
    #[napi]
    pub async fn run(
        &self,
        operation: String,
        input: String,
        body: Option<napi::bindgen_prelude::Buffer>,
        now: Option<f64>,
        timeout: Option<f64>,
    ) -> Result<WorkspaceRemoteResponse> {
        let result = self
            .inner
            .operate(
                &operation,
                parse(&input)?,
                body.map(|b| b.to_vec()),
                None,
                now,
                timeout.unwrap_or(sharing::DEFAULT_TIMEOUT_MS as f64),
            )
            .await;
        let (value, body) = match result {
            Ok(r) => (Ok(r.value), r.bytes),
            Err(e) => (Err(e), vec![]),
        };
        Ok(WorkspaceRemoteResponse {
            metadata: sharing::reply(value),
            body: body.into(),
        })
    }
}
