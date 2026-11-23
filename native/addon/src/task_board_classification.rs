//! 任务板自动分类。每个看板独立保存待回执的作业和已处理的归因，
//! 在调用宿主时释放状态借用，使同步广播、取消和 Promise 回执可以重入。
mod context;
mod prompts;
mod queue;

pub use context::{task_board_classify_goal, task_board_turn_end};
pub use prompts::{task_board_system_prompt, task_board_user_prompt};

use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as J};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cell::RefCell, collections::HashMap, ffi::CStr};

trait Properties: Sized {
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
struct Host<'a>(L<'a>);

impl<'a> Host<'a> {
    fn value(self, value: impl Into<J>) -> Result<L<'a>> {
        self.0.from_value(&value.into())
    }
    fn null(self) -> Result<L<'a>> {
        self.value(J::Null)
    }
    fn object(self, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
        let obj = self.value(J::Object(vec![]))?;
        for (key, value) in fields {
            obj.set(key, *value)?;
        }
        Ok(obj)
    }
    fn board(self) -> Result<L<'a>> {
        self.0.get(c"board")
    }
    fn tasks(self) -> Result<L<'a>> {
        self.board()?.get(c"tasks")
    }
    fn now(self) -> Result<L<'a>> {
        self.0.global()?.get(c"Date")?.invoke(c"now", &[])
    }
    fn record(self, id: L<'a>) -> Result<L<'a>> {
        self.0.get(c"records")?.invoke(c"get", &[id])
    }
    fn history(self, session: L<'a>) -> Result<L<'a>> {
        self.0
            .get(c"loadHistory")?
            .call_plain(&[session])?
            .or(|| self.value(J::Array(vec![])))
    }
    fn core(self, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.0.get(c"core")?.invoke(key, args)
    }
    fn dir(self, task: L<'a>) -> Result<L<'a>> {
        self.core(c"taskDirId", &[self.board()?, task])?
            .or(|| self.null())
    }
    fn text(self, msg: L<'a>) -> Result<L<'a>> {
        self.core(c"messageText", &[msg])?.invoke(c"trim", &[])
    }
    fn save(self) -> Result<()> {
        self.0.invoke(c"save", &[])?;
        Ok(())
    }
    fn notify(self, dir: L<'a>, task: L<'a>) -> Result<()> {
        let ids = self.value(J::Array(vec![]))?;
        ids.set_element(0, task.get(c"id")?)?;
        self.0.invoke(c"notify", &[dir, ids])?;
        Ok(())
    }
    fn error(self, reason: &str) -> Result<L<'a>> {
        self.object(&[(c"ok", self.value(false)?), (c"error", self.value(reason)?)])
    }
}

#[derive(Default)]
#[napi]
pub struct TaskBoardClassification {
    pending: RefCell<HashMap<JsString, JsString>>,
    handled: RefCell<HashMap<JsString, JsString>>,
}

#[napi]
impl TaskBoardClassification {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn settled(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
        id: Unknown<'_>,
        messages: Unknown<'_>,
        meta: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        Ok(self
            .on_settled(
                Host(L::new(&env, ports)),
                L::new(&env, session),
                L::new(&env, id),
                L::new(&env, messages),
                L::new(&env, meta),
            )?
            .raw())
    }

    #[napi]
    pub fn scan(&self, env: Env, ports: Unknown<'_>, now: Unknown<'_>) -> Result<u32> {
        self.recover(Host(L::new(&env, ports)), L::new(&env, now))
    }

    #[napi]
    pub fn archive_missing(&self, env: Env, ports: Unknown<'_>, task: Unknown<'_>) -> Result<()> {
        self.archive(Host(L::new(&env, ports)), L::new(&env, task))
            .map(|_| ())
    }

    #[napi]
    pub fn complete(
        &self,
        env: Env,
        ports: Unknown<'_>,
        id: Unknown<'_>,
        job: Unknown<'_>,
        reference: Unknown<'_>,
        result: Unknown<'_>,
    ) -> Result<()> {
        self.apply_result(
            Host(L::new(&env, ports)),
            L::new(&env, id),
            L::new(&env, job),
            L::new(&env, reference),
            L::new(&env, result),
        )
    }

    #[napi]
    pub fn rejected(
        &self,
        env: Env,
        ports: Unknown<'_>,
        id: Unknown<'_>,
        job: Unknown<'_>,
        error: Unknown<'_>,
    ) -> Result<()> {
        let host = Host(L::new(&env, ports));
        let id = L::new(&env, id);
        if self.take_job(id, L::new(&env, job))? {
            host.0.invoke(
                c"logFailure",
                &[host.value("failed")?, id, L::new(&env, error)],
            )?;
            self.fail(host, id, host.value("classification_failed")?)?;
        }
        Ok(())
    }
}
