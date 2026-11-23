//! 将回合标识按 UTF-16 原样传给后台任务，读取转录时释放宿主事件循环。
use crate::js_live::LiveValue;
use multicc_core::{js::JsString, turn_end_evidence};
use napi::{
    bindgen_prelude::{AsyncTask, Unknown},
    Env, Result, Task,
};
use napi_derive::napi;
use std::path::Path;

pub struct TurnEndEvidence {
    cli: String,
    turn: Option<JsString>,
    path: String,
}

impl Task for TurnEndEvidence {
    type Output = &'static str;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(turn_end_evidence::confirm(
            &self.cli,
            self.turn.as_ref(),
            Path::new(&self.path),
        ))
    }

    fn resolve(&mut self, _: Env, result: Self::Output) -> Result<String> {
        Ok(result.to_owned())
    }
}

#[napi]
pub fn confirm_turn_end(env: Env, input: Unknown<'_>) -> Result<AsyncTask<TurnEndEvidence>> {
    let input = LiveValue::new(&env, input);
    let cli = input
        .get(c"cli")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy();
    let turn = input.get(c"turnId")?.string()?;
    let path = input
        .get(c"transcriptPath")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy();
    Ok(AsyncTask::new(TurnEndEvidence { cli, turn, path }))
}
