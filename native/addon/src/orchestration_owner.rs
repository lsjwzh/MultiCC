//! Experimental N-API bridge to the isolated Rust orchestration owner.
//! Production continues to use the existing store until integration is proved.
use crate::guard::guard;
use crate::orchestration_store::{read, write};
use multicc_core::js::from_serde;
use multicc_core::orchestration_owner::{OwnerClient, OWNER_PROTOCOL_VERSION};
use multicc_core::orchestration_retention::{MaintenanceGuard, RetentionPolicy};
use napi::{
    bindgen_prelude::{AsyncTask, Buffer, Unknown},
    sys, Env, Result, ScopedTask,
};
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::SystemTime;

// The former in-process API has no fixed payload cap. The streaming transport
// preserves that contract; owner allocations grow only with bytes received.
const EXPERIMENTAL_MAX_FRAME: u64 = u64::MAX;

type SharedOwner = Arc<Mutex<OwnerClient>>;
#[derive(PartialEq, Eq)]
struct BinaryIdentity {
    path: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
struct PoolEntry {
    binary: BinaryIdentity,
    owner: Weak<Mutex<OwnerClient>>,
}
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, PoolEntry>>> = OnceLock::new();

fn lock(inner: &Mutex<OwnerClient>) -> MutexGuard<'_, OwnerClient> {
    match inner.lock() {
        Ok(owner) => owner,
        Err(poisoned) => {
            let mut owner = poisoned.into_inner();
            // A panic may have interrupted any session's command. Never keep
            // serving a potentially half-observed transaction after poisoning.
            owner.abort();
            inner.clear_poison();
            owner
        }
    }
}

struct OwnerSession {
    owner: SharedOwner,
    id: u64,
    closed: AtomicBool,
}
impl OwnerSession {
    fn open(file: &str, binary: &str, open: &Value) -> Result<Self> {
        let path = Path::new(file);
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| {
                napi::Error::from_reason(format!("ORCHESTRATION_SQLITE_ERROR:{error}"))
            })?;
        }
        let key = MaintenanceGuard::lock_path(path).map_err(|error| {
            napi::Error::from_reason(format!("ORCHESTRATION_SQLITE_ERROR:{error}"))
        })?;
        let binary = Path::new(binary);
        if !binary.is_absolute() {
            return Err(napi::Error::from_reason(
                "ORCHESTRATION_SQLITE_ERROR:owner executable path must be absolute",
            ));
        }
        let binary = std::fs::canonicalize(binary).map_err(|error| {
            napi::Error::from_reason(format!(
                "ORCHESTRATION_SQLITE_ERROR:owner executable unavailable: {error}"
            ))
        })?;
        let metadata = std::fs::metadata(&binary).map_err(|error| {
            napi::Error::from_reason(format!(
                "ORCHESTRATION_SQLITE_ERROR:owner executable unavailable: {error}"
            ))
        })?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let identity = BinaryIdentity {
            path: binary.clone(),
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        };
        let pool = OWNERS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut entries = pool.lock().map_err(|_| {
            napi::Error::from_reason("ORCHESTRATION_SQLITE_ERROR:owner registry is unavailable")
        })?;
        entries.retain(|_, entry| entry.owner.strong_count() > 0);
        if let Some(entry) = entries.get(&key) {
            if let Some(owner) = entry.owner.upgrade() {
                let mut client = lock(&owner);
                if !client.is_failed() {
                    if entry.binary != identity {
                        return Err(napi::Error::from_reason(
                            "ORCHESTRATION_SQLITE_ERROR:owner executable mismatch",
                        ));
                    }
                    let id = client
                        .open_session(open)
                        .map_err(napi::Error::from_reason)?;
                    drop(client);
                    return Ok(Self {
                        owner,
                        id,
                        closed: AtomicBool::new(false),
                    });
                }
            }
        }
        let owner = Arc::new(Mutex::new(
            OwnerClient::spawn(&binary, open, EXPERIMENTAL_MAX_FRAME)
                .map_err(napi::Error::from_reason)?,
        ));
        entries.insert(
            key,
            PoolEntry {
                binary: identity,
                owner: Arc::downgrade(&owner),
            },
        );
        Ok(Self {
            owner,
            id: 1,
            closed: AtomicBool::new(false),
        })
    }
    fn request(&self, op: &str, input: &Value) -> std::result::Result<Value, String> {
        let mut owner = lock(&self.owner);
        if op == "close" {
            if self.closed.swap(true, Ordering::SeqCst) {
                return Ok(Value::Null);
            }
        } else if self.closed.load(Ordering::SeqCst) {
            return Err("ORCHESTRATION_SQLITE_ERROR:owner session is closed".into());
        }
        owner.request_for(self.id, op, input)
    }
}
impl Drop for OwnerSession {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = lock(&self.owner).request_for(self.id, "close", &json!({}));
        }
    }
}

fn policy(options: Value) -> Result<RetentionPolicy> {
    let result = if options.get("env").is_some() {
        let mut value = serde_json::to_value(
            RetentionPolicy::from_env_values(&options["env"]).map_err(napi::Error::from_reason)?,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        if let Some(overrides) = options["policy"].as_object() {
            for (key, item) in overrides {
                value[key] = item.clone();
            }
        }
        serde_json::from_value(value)
    } else {
        serde_json::from_value(options)
    };
    result.map_err(|error| napi::Error::from_reason(format!("{error}")))
}

#[napi]
pub struct RustIsolatedOrchestrationStore {
    inner: Arc<OwnerSession>,
}

#[napi]
impl RustIsolatedOrchestrationStore {
    #[napi(getter)]
    pub fn owner_process_id(&self) -> u32 {
        lock(&self.inner.owner).process_id()
    }

    #[napi(constructor)]
    pub fn new(
        env: Env,
        file: String,
        legacy_file: Option<String>,
        now: f64,
        options: Unknown<'_>,
        owner_binary: String,
    ) -> Result<Self> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            let options = policy(read(env, options, "open")?)?;
            let open = json!({"version": OWNER_PROTOCOL_VERSION, "file": file, "legacyFile": legacy_file,
                    "now": now as i64, "policy": options});
            let owner = OwnerSession::open(&file, &owner_binary, &open)?;
            Ok(Self {
                inner: Arc::new(owner),
            })
        })
    }

    #[napi]
    pub fn request(&self, env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            let input = read(env, input, &op)?;
            let result = self
                .inner
                .request(&op, &input)
                .map_err(napi::Error::from_reason)?;
            write(env, &result)
        })
    }

    #[napi]
    pub fn request_async(
        &self,
        env: Env,
        op: String,
        input: Unknown<'_>,
    ) -> Result<AsyncTask<OwnerRequest>> {
        Ok(AsyncTask::new(OwnerRequest {
            inner: Arc::clone(&self.inner),
            input: read(env, input, &op)?,
            op,
            spec: None,
            admission: false,
        }))
    }

    #[napi]
    pub fn request_admission_async(
        &self,
        env: Env,
        op: String,
        input: Unknown<'_>,
        spec: Buffer,
    ) -> Result<AsyncTask<OwnerRequest>> {
        if op != "operationAdmitPlan" && op != "operationAdmit" {
            return Err(napi::Error::from_reason(
                "ORCHESTRATION_SQLITE_ERROR:invalid admission operation",
            ));
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(spec.len()).map_err(|_| {
            napi::Error::from_reason("ORCHESTRATION_SQLITE_ERROR:unable to allocate admission spec")
        })?;
        bytes.extend_from_slice(&spec);
        Ok(AsyncTask::new(OwnerRequest {
            inner: Arc::clone(&self.inner),
            input: read(env, input, &op)?,
            op,
            spec: Some(bytes),
            admission: true,
        }))
    }
}

pub struct OwnerRequest {
    inner: Arc<OwnerSession>,
    op: String,
    input: Value,
    spec: Option<Vec<u8>>,
    admission: bool,
}
impl<'task> ScopedTask<'task> for OwnerRequest {
    type Output = Value;
    type JsValue = Unknown<'task>;
    fn compute(&mut self) -> Result<Value> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            if let Some(bytes) = self.spec.take() {
                let spec = match String::from_utf8(bytes) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = self.inner.request("end", &json!({}));
                        return Err(napi::Error::from_reason(
                            "ORCHESTRATION_SQLITE_ERROR:invalid admission spec UTF-8",
                        ));
                    }
                };
                self.input["specJson"] = Value::String(spec);
            }
            self.inner
                .request(&self.op, &self.input)
                .map_err(napi::Error::from_reason)
        })
    }
    fn resolve(&mut self, env: &'task Env, mut value: Value) -> Result<Unknown<'task>> {
        let body = if self.admission {
            value
                .as_object_mut()
                .and_then(|object| object.remove("resultJson"))
        } else {
            None
        };
        let raw = unsafe { crate::js_bridge::write_value(env.raw(), &from_serde(&value)) }?;
        if let Some(Value::String(body)) = body {
            let mut buffer = std::ptr::null_mut();
            napi::check_status!(unsafe {
                sys::napi_create_buffer_copy(
                    env.raw(),
                    body.len(),
                    body.as_ptr().cast(),
                    std::ptr::null_mut(),
                    &mut buffer,
                )
            })?;
            napi::check_status!(unsafe {
                sys::napi_set_named_property(env.raw(), raw, c"resultBuffer".as_ptr(), buffer)
            })?;
        }
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
    }
}
