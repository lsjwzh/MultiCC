use multicc_core::model_stream_progress::ModelStreamProgress;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi]
pub struct RustModelStreamProgress {
    inner: ModelStreamProgress,
}
impl Default for RustModelStreamProgress {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustModelStreamProgress {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ModelStreamProgress::default(),
        }
    }
    #[napi]
    pub fn feed(&mut self, bytes: Buffer) -> bool {
        self.inner.feed_bytes(bytes.as_ref())
    }
    #[napi]
    pub fn feed_text(&mut self, text: String) -> bool {
        self.inner.feed_text(&text)
    }
}
