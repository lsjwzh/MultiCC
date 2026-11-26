//! Goal prechecks are interactive consumers of the same durable Aux queue.
use super::App;
use multicc_core::{
    goal_precheck,
    js::{serde::js_string, JsString},
    orchestration_routes::Route,
    provider_store,
    session_git::parse_int10,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

fn labels() -> Value {
    Value::Object(
        goal_precheck::DIMENSIONS
            .into_iter()
            .map(|(key, label)| (key.to_owned(), Value::from(label)))
            .collect(),
    )
}
fn score(v: &Value, default: i64) -> i64 {
    parse_int10(&js_string(v)).unwrap_or(default).clamp(0, 100)
}
fn normalize(cfg: &Value) -> Value {
    let mut dim = labels();
    for (key, v) in dim.as_object_mut().unwrap() {
        *v = cfg["dimensions"][key].as_bool().unwrap_or(true).into();
    }
    json!({"dimensions":dim,"minScore":score(&cfg["minScore"],60)})
}
fn verdict(text: &str) -> Value {
    let parsed = serde_json::from_str::<Value>(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str(text.get(start..=end)?).ok()
    });
    let Some(p) = parsed.filter(|p| p.is_object() || p.is_array()) else {
        return json!({"verdict":"needs_work","score":0,"issues":["辅助 AI 未能给出可解析的结果，请人工确认或直接发送"],"questions":[],"criteria":[],"revised":"","raw":text});
    };
    let ok = p["verdict"] == "ok";
    let strings = |k: &str| {
        p[k].as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    };
    json!({"verdict":if ok{"ok"}else{"needs_work"},"score":score(&p["score"],if ok{80}else{40}),"issues":strings("issues"),"questions":strings("questions"),"criteria":strings("criteria"),"revised":p["revised"].as_str().unwrap_or("").trim()})
}
pub(super) async fn handle(
    app: &Arc<App>,
    route: Route,
    body: &Value,
) -> Result<(u16, Value), String> {
    let file = app.data_root.join("goal-config.json");
    if route == Route::SettingsGoalPost {
        let cfg = normalize(body);
        let saved = cfg.clone();
        tokio::task::spawn_blocking(move || provider_store::atomic_write(&file, &saved))
            .await
            .map_err(|e| e.to_string())??;
        let mut result = cfg;
        result["ok"] = true.into();
        return Ok((200, result));
    }
    let mut cfg = tokio::task::spawn_blocking(move || {
        normalize(
            &provider_store::read(&file)
                .ok()
                .flatten()
                .unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let timeout = std::env::var("AUX_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n != 0)
        .unwrap_or(90000)
        .max(10000);
    let wait = std::env::var("GOAL_PRECHECK_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n != 0)
        .unwrap_or(timeout.saturating_mul(2).max(30000))
        .max(1000);
    let labels = labels();
    if route == Route::SettingsGoalGet {
        cfg["dimensionLabels"] = labels;
        cfg["precheckWaitMs"] = wait.into();
        return Ok((200, cfg));
    }
    let task = body["task"].as_str().unwrap_or("").trim();
    if task.is_empty() {
        return Ok((400, json!({"error":"task required"})));
    }
    let dimensions = if body["dimensions"].is_object() {
        normalize(body)["dimensions"].clone()
    } else {
        cfg["dimensions"].clone()
    };
    let mut enabled = labels
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| dimensions[*k] == true)
        .map(|(_, v)| v)
        .collect::<Vec<_>>();
    if enabled.is_empty() {
        enabled.extend(labels.as_object().unwrap().values());
    }
    let criteria = enabled
        .into_iter()
        .map(|label| JsString::from(label.as_str().unwrap_or("")))
        .collect::<Vec<_>>();
    let prompt = goal_precheck::build_prompt(&criteria, &JsString::from(task)).to_string_lossy();
    let job = json!({"type":"goal_check","prompt":prompt,"meta":{"taskLen":task.encode_utf16().count(),"timeout":timeout}});
    let min = score(&body["minScore"], cfg["minScore"].as_i64().unwrap_or(60));
    let result = tokio::time::timeout(
        Duration::from_millis(wait),
        app.aux_jobs
            .get()
            .ok_or("Aux queue unavailable")?
            .submit(&job, true),
    )
    .await;
    let response = match result {
        Err(_) => {
            json!({"ok":false,"code":"AUX_TIMEOUT","error":format!("预检超时（辅助模型 {} 秒内未返回）。请检查辅助模型的可用性与配额，或直接「用原文发送」。",(wait+500)/1000)})
        }
        Ok(r) => {
            let answer = r?;
            if answer["ok"] != true {
                json!({"ok":false,"error":answer["error"]})
            } else {
                let mut v = verdict(answer["result"].as_str().unwrap_or(""));
                let actual = v["score"].as_i64().unwrap_or(0);
                if v["verdict"] == "ok" && actual < min {
                    v["verdict"] = "needs_work".into();
                    v["issues"]
                        .as_array_mut()
                        .unwrap()
                        .insert(0, format!("符合度 {actual} 低于设定阈值 {min}").into());
                }
                v["ok"] = true.into();
                v["dimensions"] = dimensions;
                v["minScore"] = min.into();
                v
            }
        }
    };
    Ok((200, response))
}
