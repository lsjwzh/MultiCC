//! Read-only native context admission. Run database/catalog I/O on a worker.
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{fs, time::Duration};

fn number(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(0.0)
}

fn tokens(data: &Value) -> Option<Value> {
    if !data["tokens"].is_object() || !data["error"].is_null() {
        return None;
    }
    let t = &data["tokens"];
    let (input, output, reasoning, read, write) = (
        number(&t["input"]),
        number(&t["output"]),
        number(&t["reasoning"]),
        number(&t["cache"]["read"]),
        number(&t["cache"]["write"]),
    );
    // Output already includes reasoning in OpenCode's normalized token shape.
    // Some providers omit total; a zero/absent total is not a zero water level.
    let total = number(&t["total"]).max(input + output + read + write);
    if total <= 0.0 {
        return None;
    }
    Some(
        json!({"total":total,"input":input,"output":output,"reasoning":reasoning,
        "cacheRead":read,"cacheWrite":write}),
    )
}

fn model_of(data: &Value) -> Option<String> {
    let model = data["modelID"]
        .as_str()
        .or_else(|| data["model"]["modelID"].as_str())?;
    let provider = data["providerID"]
        .as_str()
        .or_else(|| data["model"]["providerID"].as_str());
    Some(match provider {
        Some(p) => format!("{p}/{model}"),
        None => model.into(),
    })
}

fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0)
}

pub fn resolve_limit(catalog: &Value, model: &str) -> Value {
    let Some(providers) = catalog.as_object() else {
        return json!({"context":128000,"output":8192,"source":"fallback"});
    };
    let mut ids = vec![model];
    if let Some((_, suffix)) = model.split_once('/') {
        ids.push(suffix);
    }
    for id in ids {
        let limits: Vec<&Value> = providers
            .values()
            .filter_map(|p| p["models"].get(id))
            .map(|m| &m["limit"])
            .collect();
        if let Some(context) = limits.iter().filter_map(|l| positive(&l["context"])).min() {
            let output = limits
                .iter()
                .filter_map(|l| positive(&l["output"]))
                .min()
                .unwrap_or(8192);
            return json!({"context":context,"output":output,"source":"models.dev"});
        }
    }
    json!({"context":128000,"output":8192,"source":"fallback"})
}

fn turn_usage(db: &Connection, sid: &str, args: &Value) -> Result<Value, String> {
    let mut statement = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC")
        .map_err(|e| e.to_string())?;
    let mut rows = statement.query([sid]).map_err(|e| e.to_string())?;
    if args["op"] == "cursor" {
        return match rows.next().map_err(|e| e.to_string())? {
            Some(row) => Ok(
                json!({"id":row.get::<_,String>(0).map_err(|e| e.to_string())?,
                "time":row.get::<_,i64>(1).map_err(|e| e.to_string())?,"sessionId":sid}),
            ),
            None => Ok(json!({"id":"","time":0,"sessionId":sid})),
        };
    }
    let cursor = &args["cursor"];
    if cursor["sessionId"] != sid || !cursor["time"].is_i64() {
        return Ok(Value::Null);
    }
    let mut sums = [0.0; 5];
    let mut latest = None;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let time: i64 = row.get(1).map_err(|e| e.to_string())?;
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        if time < cursor["time"].as_i64().unwrap_or(0)
            || (time == cursor["time"].as_i64().unwrap_or(0)
                && id.as_str() <= cursor["id"].as_str().unwrap_or(""))
        {
            break;
        }
        let text: String = row.get(2).map_err(|e| e.to_string())?;
        let Ok(data) = crate::json_lenient::from_str::<Value>(&text) else {
            continue;
        };
        if data["role"] != "assistant" {
            continue;
        }
        let Some(t) = tokens(&data) else { continue };
        for (i, key) in ["input", "output", "cacheRead", "cacheWrite", "reasoning"]
            .iter()
            .enumerate()
        {
            sums[i] += number(&t[*key]);
        }
        if latest.is_none() {
            latest = Some(t);
        }
        count += 1;
    }
    let Some(latest) = latest else {
        return Ok(Value::Null);
    };
    Ok(
        json!({"input_tokens":sums[0],"output_tokens":sums[1],"cache_read_input_tokens":sums[2],
        "cache_creation_input_tokens":sums[3],"reasoning_output_tokens":sums[4],
        "context_tokens":latest["total"],"context_input_tokens":number(&latest["input"])+number(&latest["cacheRead"])+number(&latest["cacheWrite"]),
        "context_output_tokens":latest["output"],"usage_source":"opencode_native","request_count":count}),
    )
}

pub fn read(input: &str) -> Result<String, String> {
    let args: Value = crate::json_lenient::from_str(input).map_err(|e| e.to_string())?;
    let sid = args["sessionId"].as_str().unwrap_or("").trim();
    if sid.is_empty() {
        return Ok(json!({"found":false,"reason":"no-native-session"}).to_string());
    }
    let db = match Connection::open_with_flags(
        args["dbPath"].as_str().unwrap_or(""),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(db) => db,
        Err(_) => return Ok(json!({"found":false,"reason":"db-unavailable"}).to_string()),
    };
    db.busy_timeout(Duration::from_millis(250))
        .map_err(|e| e.to_string())?;
    if args["op"] == "cursor" || args["op"] == "turn_usage" {
        return turn_usage(&db, sid, &args).map(|v| v.to_string());
    }
    let mut statement = db.prepare(
        "SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 512"
    ).map_err(|e| e.to_string())?;
    let mut rows = statement.query([sid]).map_err(|e| e.to_string())?;
    let mut usage = None;
    let mut native_model = None;
    let mut overflow = None;
    let mut seen = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        seen = true;
        let text: String = row.get(0).map_err(|e| e.to_string())?;
        let Ok(data) = crate::json_lenient::from_str::<Value>(&text) else {
            continue;
        };
        if native_model.is_none() {
            native_model = model_of(&data);
        }
        if data["role"] != "assistant" {
            continue;
        }
        if overflow.is_none() {
            overflow = crate::provider_error::diagnose(
                "opencode",
                crate::provider_error::Origin::NativeHistory,
                &data["error"],
            )
            .filter(|failure| failure.should_rotate_context());
        }
        if let Some(measured) = tokens(&data) {
            usage = Some(measured);
            break; // Older overflow/usage cannot override a newer successful measurement.
        }
    }
    if !seen {
        return Ok(json!({"found":false,"reason":"session-not-found"}).to_string());
    }
    if usage.is_none() && overflow.is_none() {
        return Ok(json!({"found":false,"reason":"usage-missing"}).to_string());
    }
    let configured_model = args["modelId"].as_str().unwrap_or("").trim();
    let model = if configured_model.is_empty() {
        native_model.as_deref().unwrap_or("")
    } else {
        configured_model
    };
    let catalog: Value = fs::read_to_string(args["cachePath"].as_str().unwrap_or(""))
        .ok()
        .and_then(|s| crate::json_lenient::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let limit = resolve_limit(&catalog, model);
    let threshold = args["threshold"]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(0.85)
        .clamp(0.5, 0.95);
    let ratio = usage
        .as_ref()
        .map(|t| number(&t["total"]) / number(&limit["context"]));
    let would_rotate = overflow.is_some()
        || (limit["source"] == "models.dev" && ratio.is_some_and(|r| r >= threshold));
    Ok(
        json!({"found":true,"sessionId":sid,"modelId":model,"tokens":usage,"limit":limit,
        "usageKnown":usage.is_some(),"overflow":overflow.is_some(),
        "threshold":threshold,"ratio":ratio.map(|r| (r*1000.0).round()/1000.0),
        "wouldRotate":would_rotate})
        .to_string(),
    )
}

pub fn plan(input: &str) -> Result<String, String> {
    let args: Value = crate::json_lenient::from_str(input).map_err(|e| e.to_string())?;
    let record = &args["record"];
    let skip = |reason: &str| json!({"action":"skipped","reason":reason}).to_string();
    if record["kind"].as_str().is_some_and(|k| k != "chat") {
        return Ok(skip("not_chat_session"));
    }
    let sid = record["_streamSessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| record["cliSessionId"].as_str().filter(|s| !s.is_empty()));
    let Some(sid) = sid else {
        return Ok(skip("no_native_session"));
    };
    // A pending handoff to an EXISTING native target is not a fresh context.
    // The host will preserve that checkpoint when it replaces the full target.
    let usage = &args["usage"];
    if usage["found"] != true {
        return Ok(skip(
            usage["reason"].as_str().unwrap_or("usage_unavailable"),
        ));
    }
    let overflow = usage["overflow"] == true;
    let reason = if overflow {
        "native_context_overflow"
    } else if usage["limit"]["source"] != "models.dev" {
        "limit_unknown"
    } else if usage["wouldRotate"] != true {
        "below_threshold"
    } else {
        "context_water_level_exceeded"
    };
    let rotate = matches!(
        reason,
        "native_context_overflow" | "context_water_level_exceeded"
    );
    let message = if overflow {
        "OpenCode 原生会话已报告上下文超限，本轮自动切换到新的原生会话并附带交接摘要；完整对话历史保留不变。".to_string()
    } else {
        format!("OpenCode 原生上下文水位已达 {:.0}%，本轮自动切换到新的原生会话并附带交接摘要；完整对话历史保留不变。", number(&usage["ratio"])*100.0)
    };
    Ok(json!({"action":if rotate {"rotate"} else {"skipped"},"reason":reason,
        "cliSessionId":sid,"tokensTotal":usage["tokens"]["total"],"contextLimit":usage["limit"]["context"],
        "limitSource":usage["limit"]["source"],"threshold":usage["threshold"],"ratio":usage["ratio"],
        "message":message}).to_string())
}
