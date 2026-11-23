//! 任务板原生适配器共用的宿主对象和活值操作。
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as J};
use napi::Result;
use std::ffi::CStr;

pub(crate) trait Properties: Sized {
    fn invoke(self, key: &CStr, args: &[Self]) -> Result<Self>;
    fn or(self, fallback: impl FnOnce() -> Result<Self>) -> Result<Self>;
    fn length(self) -> Result<u32>;
}

impl Properties for L<'_> {
    fn invoke(self, key: &CStr, args: &[Self]) -> Result<Self> {
        self.get(key)?.call(self, args)
    }
    fn or(self, fallback: impl FnOnce() -> Result<Self>) -> Result<Self> {
        if self.truthy()? {
            Ok(self)
        } else {
            fallback()
        }
    }
    fn length(self) -> Result<u32> {
        Ok(self.get(c"length")?.number()? as u32)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Host<'a>(pub(crate) L<'a>);

impl<'a> Host<'a> {
    pub(crate) fn value(self, value: impl Into<J>) -> Result<L<'a>> {
        self.0.from_value(&value.into())
    }
    pub(crate) fn null(self) -> Result<L<'a>> {
        self.value(J::Null)
    }
    pub(crate) fn object(self, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
        let obj = self.value(J::Object(vec![]))?;
        for (key, value) in fields {
            obj.set(key, *value)?;
        }
        Ok(obj)
    }
    pub(crate) fn board(self) -> Result<L<'a>> {
        self.0.get(c"board")
    }
    pub(crate) fn tasks(self) -> Result<L<'a>> {
        self.board()?.get(c"tasks")
    }
    pub(crate) fn now(self) -> Result<L<'a>> {
        self.0.global()?.get(c"Date")?.invoke(c"now", &[])
    }
    pub(crate) fn record(self, id: L<'a>) -> Result<L<'a>> {
        self.0.get(c"records")?.invoke(c"get", &[id])
    }
    pub(crate) fn core(self, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.0.get(c"core")?.invoke(key, args)
    }
}

pub(crate) fn concat<'a>(host: Host<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut text = JsString::new();
    for part in parts {
        text.push(&part.coerce_string()?);
    }
    host.value(J::String(text))
}

pub(crate) fn js_string(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}

pub(crate) fn refusal<'a>(host: Host<'a>, code: &str) -> Result<L<'a>> {
    host.object(&[(c"ok", host.value(false)?), (c"code", host.value(code)?)])
}
