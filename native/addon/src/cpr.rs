use multicc_cpr::{plan, transport::Exchange};
use napi::{
    bindgen_prelude::{spawn, Buffer},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Result, Status,
};
use napi_derive::napi;
use std::sync::Arc;

fn error(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

#[napi]
pub fn cpr_protocol_version() -> u32 {
    1
}

// Version of the host-to-transport request lifecycle contract.
#[napi]
pub fn cpr_request_lifecycle_version() -> u32 {
    3
}

type StreamTimeoutCallback = ThreadsafeFunction<String, (), String, Status, false, true>;

// Only bounded quota metadata crosses this synchronous compatibility bridge.
#[napi]
pub fn cpr_claude_quota(input: String) -> Result<String> {
    let input = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| error("Invalid Claude quota metadata".into()))?;
    Ok(multicc_cpr::claude_quota::run(&input).to_string())
}

// 大请求的解析和序列化也离开 Node 主线程。
#[napi]
pub async fn cpr_route(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let input = multicc_core::json_lenient::from_str(&input)
            .map_err(|_| "Rust CPR 输入无效".to_owned())?;
        serde_json::to_string(&plan::route(&input)?).map_err(|_| "Rust CPR 路由序列化失败".into())
    })
    .await
    .map_err(|_| error("Rust CPR 路由任务失败".into()))?
    .map_err(error)
}
#[napi]
pub async fn cpr_prepare(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let input = multicc_core::json_lenient::from_str(&input)
            .map_err(|_| "Rust CPR 输入无效".to_owned())?;
        Ok::<_, String>(plan::prepare(input)?.to_string())
    })
    .await
    .map_err(|_| error("Rust CPR 请求准备失败".into()))?
    .map_err(error)
}
#[napi]
pub struct RustCprExchange {
    inner: Arc<Exchange>,
}

#[napi]
pub async fn cpr_create_exchange(input: String) -> Result<RustCprExchange> {
    let exchange = tokio::task::spawn_blocking(move || Exchange::new(input))
        .await
        .map_err(|_| error("Rust CPR 传输初始化失败".into()))?
        .map_err(error)?;
    Ok(RustCprExchange {
        inner: Arc::new(exchange),
    })
}
#[napi(object)]
pub struct CprChunk {
    pub data: Buffer,
    pub meta: String,
}
#[napi(object)]
pub struct CprErrorBody {
    pub data: Buffer,
    pub complete: bool,
    pub no_retry: bool,
    pub rejection: Option<String>,
}

#[napi]
impl RustCprExchange {
    #[napi]
    pub fn start_stream_watch(
        &self,
        idle_ms: u32,
        idle_remaining_ms: u32,
        deadline_remaining_ms: u32,
        progressed: bool,
        callback: StreamTimeoutCallback,
    ) -> Result<()> {
        self.inner
            .start_stream_watch(
                idle_ms.into(),
                idle_remaining_ms.into(),
                deadline_remaining_ms.into(),
                progressed,
            )
            .map_err(error)?;
        let exchange = self.inner.clone();
        spawn(async move {
            if let Some((code, progressed)) = exchange.wait_stream_timeout().await {
                let payload =
                    serde_json::json!({ "code": code, "progressed": progressed }).to_string();
                let _ = callback.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
        Ok(())
    }
    #[napi]
    pub fn stop_stream_watch(&self) {
        self.inner.stop_stream_watch();
    }
    #[napi]
    pub fn note_stream_progress(&self) -> bool {
        self.inner.note_stream_progress()
    }
    #[napi]
    pub fn stream_progressed(&self) -> bool {
        self.inner.stream_progressed()
    }
    #[napi]
    pub fn stream_timeout_code(&self) -> Option<&'static str> {
        self.inner.stream_timeout_code()
    }
    #[napi]
    pub fn finish_stream_watch(&self) -> Option<&'static str> {
        self.inner.finish_stream_watch()
    }
    #[napi]
    pub async fn open(&self) -> Result<String> {
        self.inner
            .open()
            .await
            .map(|v| v.to_string())
            .map_err(error)
    }
    #[napi]
    pub async fn read(&self) -> Result<CprChunk> {
        let chunk = self.inner.read().await.map_err(error)?;
        Ok(CprChunk {
            data: chunk.data.into(),
            meta: chunk.meta.to_string(),
        })
    }
    #[napi]
    pub async fn error_body(&self) -> Result<CprErrorBody> {
        let result = self.inner.error_body().await.map_err(error)?;
        Ok(CprErrorBody {
            data: result.data.into(),
            complete: result.complete,
            no_retry: result.no_retry,
            rejection: result.rejection.map(|value| value.to_string()),
        })
    }
    #[napi]
    pub fn abort(&self) -> Option<&'static str> {
        self.inner.abort()
    }
    #[napi]
    pub async fn close(&self) {
        self.inner.close().await;
    }
}
impl Drop for RustCprExchange {
    fn drop(&mut self) {
        self.inner.abort();
    }
}
