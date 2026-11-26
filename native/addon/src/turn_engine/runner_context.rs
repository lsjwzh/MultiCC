//! 聊天进程与常驻流共用回合和宿主端口的借用视图。
use crate::{host_methods::method, route_response::*};
use std::ffi::CStr;
#[derive(Clone, Copy)]
pub(super) struct RunnerContext<'a> {
    pub(super) state: L<'a>,
    pub(super) ports: L<'a>,
    pub(super) session: L<'a>,
    pub(super) cs: L<'a>,
    pub(super) record: L<'a>,
    pub(super) provider: L<'a>,
    pub(super) turn: L<'a>,
    pub(super) invocation: L<'a>,
}
impl<'a> RunnerContext<'a> {
    pub(super) fn load(state: L<'a>) -> Result<Self> {
        Ok(Self {
            state,
            ports: state.get(c"ports")?,
            session: state.get(c"session")?,
            cs: state.get(c"cs")?,
            record: state.get(c"record")?,
            provider: state.get(c"provider")?,
            turn: state.get(c"turn")?,
            invocation: state.get(c"invocation")?,
        })
    }
    pub(super) fn port(&self, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(key)?.call_plain(args)
    }
    pub(super) fn service(&self, key: &CStr, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        call(self.ports.get(key)?, op, args)
    }
    pub(super) fn workspace(&self) -> Result<L<'a>> {
        let getter = self.ports.get(c"getWorkspaceAdmission")?;
        if getter.nullish()? {
            undefined(self.state)
        } else {
            getter.call_plain(&[])
        }
    }
    pub(super) fn workspace_optional(&self, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        let ws = self.workspace()?;
        let f = ws.optional(op)?;
        if f.nullish()? {
            undefined(self.state)
        } else {
            f.call(ws, args)
        }
    }
    pub(super) fn base_url(&self) -> Result<L<'a>> {
        join(
            self.state,
            &[
                text(self.state, "http://127.0.0.1:")?,
                self.port(c"getPort", &[])?,
            ],
        )
    }
    pub(super) fn log(&self, level: &CStr, event: &str, detail: &[(&str, L<'a>)]) -> Result<L<'a>> {
        self.service(
            c"logger",
            level,
            &[text(self.state, event)?, fields(self.state, detail)?],
        )
    }
    pub(super) fn console(&self, items: &[L<'a>]) -> Result<L<'a>> {
        call(
            self.state.global()?.get(c"console")?,
            c"log",
            &[join(self.state, items)?],
        )
    }
    pub(super) fn callback(
        &self,
        name: &'static str,
        count: usize,
        run: impl for<'b> Fn(RunnerContext<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
    ) -> Result<L<'a>> {
        let env = Env::from_raw(self.state.env());
        let f = method(&env, self.state, name, count, count, move |s, a| {
            run(RunnerContext::load(s)?, a)
        })?;
        Ok(L::from_raw(self.state.env(), f.raw()))
    }
}
pub(super) fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
pub(super) fn join<'a>(s: L<'a>, items: &[L<'a>]) -> Result<L<'a>> {
    let mut text = multicc_core::js::JsString::new();
    for item in items {
        text.push(&item.coerce_string()?);
    }
    s.from_value(&V::String(text))
}
pub(super) fn caught<'a, T>(
    s: L<'a>,
    f: impl FnOnce() -> Result<T>,
    recover: impl FnOnce(L<'a>) -> Result<T>,
) -> Result<T> {
    match f() {
        Ok(v) => Ok(v),
        Err(e) => match s.exception_value()? {
            Some(thrown) => recover(thrown),
            None => Err(e),
        },
    }
}
