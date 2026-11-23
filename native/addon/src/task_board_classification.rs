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

use crate::task_board_host::{Host, Properties};

impl<'a> Host<'a> {
    fn history(self, session: L<'a>) -> Result<L<'a>> {
        self.0
            .get(c"loadHistory")?
            .call_plain(&[session])?
            .or(|| self.value(J::Array(vec![])))
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
