use multicc_cpr::{plan, transport::Exchange};
use napi::{bindgen_prelude::Buffer, Result};
use napi_derive::napi;
use std::sync::Arc;

fn error(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

#[napi]
pub fn cpr_protocol_version() -> u32 {
    1
}

// Only bounded quota metadata crosses this synchronous compatibility bridge.
#[napi]
pub fn cpr_claude_quota(input: String) -> Result<String> {
    let input =
        serde_json::from_str(&input).map_err(|_| error("Invalid Claude quota metadata".into()))?;
    Ok(multicc_cpr::claude_quota::run(&input).to_string())
}

#[napi]
pub fn cpr_backend_settings(input: String) -> Result<String> {
    let input = serde_json::from_str(&input).map_err(|_| error("CPR 设置输入无效".into()))?;
    Ok(multicc_cpr::settings::plan(&input).to_string())
}

// 大请求的解析和序列化也离开 Node 主线程。
#[napi]
pub async fn cpr_route(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let input = serde_json::from_str(&input).map_err(|_| "Rust CPR 输入无效".to_owned())?;
        serde_json::to_string(&plan::route(&input)?).map_err(|_| "Rust CPR 路由序列化失败".into())
    })
    .await
    .map_err(|_| error("Rust CPR 路由任务失败".into()))?
    .map_err(error)
}
#[napi]
pub async fn cpr_prepare(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let input = serde_json::from_str(&input).map_err(|_| "Rust CPR 输入无效".to_owned())?;
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
}

#[napi]
impl RustCprExchange {
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
        })
    }
    #[napi]
    pub fn abort(&self) {
        self.inner.cancel.cancel();
    }
    #[napi]
    pub async fn close(&self) {
        self.inner.close().await;
    }
}
impl Drop for RustCprExchange {
    fn drop(&mut self) {
        self.inner.cancel.cancel();
    }
}
