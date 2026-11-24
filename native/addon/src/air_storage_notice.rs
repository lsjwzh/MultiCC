//! Public homepage diagnostics and the short-lived notice for a failed write.
use crate::{js_live::LiveValue as L, task_read_model::AirSummaryIssue};
use multicc_core::{air_routes::summary_issue, js::JsValue as J};
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;

const NOTICE_LIFETIME_MS: f64 = 300_000.0;

// Read lazily. A wrapper can expose a cause through a getter, include a cycle,
// or throw. Even the fifth miss reads its cause before the depth check.
fn recognized(mut cause: L<'_>, fields: L<'_>) -> Result<Option<(&'static str, &'static str)>> {
    for _ in 0..5 {
        if !cause.truthy()? {
            break;
        }
        let pair = fields.call_plain(&[cause])?;
        let code = pair.element(0)?.coerce_string()?.to_string_lossy();
        let message = pair.element(1)?.coerce_string()?.to_string_lossy();
        if let Some(issue) = summary_issue(&code, &message) {
            return Ok(Some(issue));
        }
        cause = cause.get(c"cause")?;
    }
    Ok(None)
}

#[napi]
pub fn air_describe_issue(
    env: Env,
    error: Unknown<'_>,
    fields: Unknown<'_>,
) -> Result<AirSummaryIssue> {
    let (code, message) = recognized(L::new(&env, error), L::new(&env, fields))?.unwrap_or((
        "air_refresh_failed",
        "首页摘要更新失败。请查看服务日志中的 air_sync_refresh_failed 记录。",
    ));
    Ok(AirSummaryIssue {
        code: code.into(),
        message: message.into(),
    })
}

#[napi]
pub fn air_record_storage_notice(
    env: Env,
    error: Unknown<'_>,
    fields: Unknown<'_>,
    remember: Unknown<'_>,
    publish: Unknown<'_>,
) -> Result<bool> {
    let error = L::new(&env, error);
    let Some((code @ ("ENOSPC" | "SQLITE_FULL"), message)) = error
        .catch(|| recognized(error, L::new(&env, fields)))?
        .flatten()
    else {
        return Ok(false);
    };

    let notice = error.from_value(&J::object(vec![
        ("code", J::string(code)),
        (
            "message",
            J::string(&format!("最近一次数据写入失败。{message}")),
        ),
    ]))?;
    let date = error.global()?.get(c"Date")?;
    notice.set(c"at", date.get(c"now")?.call(date, &[])?)?;
    L::new(&env, remember)
        .call_plain(&[notice, error.from_value(&J::Number(NOTICE_LIFETIME_MS))?])?;
    let publish = L::new(&env, publish);
    if !publish.nullish()? {
        publish.call_plain(&[])?;
    }
    Ok(true)
}
