//! 原生入口的 panic 边界：把 panic 变成结构化错误码，避免 terminate 整个进程。
use std::panic::{catch_unwind, AssertUnwindSafe};

pub fn guard<T>(code: &'static str, f: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| Err(napi::Error::from_reason(code)))
}

// 仅测试用探针：显式打开环境变量后，固定输入触发 panic 以验证边界。
pub fn task_domain_panic_probe(input: &str) {
    if input == r#"{"op":"__panicProbe"}"#
        && std::env::var("MULTICC_TASK_DOMAIN_PANIC_PROBE").as_deref() == Ok("1")
    {
        panic!("probe");
    }
}
