use multicc_core::request_watch::RequestWatch;
use napi_derive::napi;

#[napi]
pub struct RustRequestWatch {
    inner: RequestWatch,
}

impl Default for RustRequestWatch {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustRequestWatch {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: RequestWatch::default(),
        }
    }
    #[napi]
    pub fn accepts(&self, budget: f64, total: f64) -> bool {
        self.inner.accepts(budget, total)
    }
    #[napi]
    pub fn arm(&mut self, budget: f64, total: f64, connect: f64, requested: f64, now: f64) -> bool {
        self.inner.arm(budget, total, connect, requested, now)
    }
    #[napi]
    pub fn progress(&mut self) -> bool {
        self.inner.progress()
    }
    #[napi]
    pub fn finish(&mut self) -> bool {
        self.inner.finish()
    }
    #[napi]
    pub fn isolate_retry_budget(&mut self) -> bool {
        self.inner.isolate_retry_budget()
    }
    #[napi]
    pub fn armed(&self) -> bool {
        self.inner.armed()
    }
    #[napi]
    pub fn finished(&self) -> bool {
        self.inner.finished()
    }
    #[napi]
    pub fn progressed(&self) -> bool {
        self.inner.progressed()
    }
    #[napi]
    pub fn idle_ms(&self) -> f64 {
        self.inner.idle_ms()
    }
    #[napi]
    pub fn connect_ms(&self) -> f64 {
        self.inner.connect_ms()
    }
    #[napi]
    pub fn deadline_at(&self) -> Option<f64> {
        self.inner.deadline_at()
    }
}
