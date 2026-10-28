//! 在临时后台页面观察网站自己的请求；不接受脚本、请求体、Cookie 或任意 CDP。
use serde_json::{json, Value};
use std::{collections::HashMap, time::{Duration, Instant}};
type Result<T> = std::result::Result<T, String>;
const ERROR: &str = "页面观察未完成";

pub fn origins(v: &Value) -> Result<Vec<String>> {
    let a = v.as_array().filter(|a| !a.is_empty() && a.len() <= 12).ok_or(ERROR)?;
    a.iter().map(|v| {
        let s = v.as_str().ok_or(ERROR)?;
        let u = url::Url::parse(s).map_err(|_| ERROR)?;
        if u.scheme() != "https" || u.origin().ascii_serialization() != s || u.port().is_some()
            || !u.username().is_empty() || u.password().is_some()
            || u.host_str().is_none_or(|h| !h.contains('.') || h.parse::<std::net::IpAddr>().is_ok()) {
            return Err(ERROR.into());
        }
        Ok(s.to_string())
    }).collect()
}
fn rules(v: &Value) -> Result<Vec<Value>> {
    let a = v.as_array().filter(|a| a.len() <= 8).ok_or(ERROR)?;
    let mut ids = std::collections::HashSet::new();
    for r in a {
        let id = r["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 64).ok_or(ERROR)?;
        let path = r["path"].as_str().filter(|s| s.starts_with('/') && !s.starts_with("//") && !s.contains(['?', '#', '\\']) && s.len() <= 200).ok_or(ERROR)?;
        if !ids.insert(id) || path.contains("..") { return Err(ERROR.into()); }
        for f in r["fields"].as_array().filter(|a| a.len() <= 32).ok_or(ERROR)? {
            let p = f.as_str().filter(|p| p.starts_with('/') && p.len() <= 160).ok_or(ERROR)?;
            let lower = p.to_lowercase();
            if ["password", "token", "cookie", "secret", "authorization", "credential", "session", "email", "phone"].iter().any(|k| lower.contains(k)) {
                return Err("不允许读取凭据或联系方式字段".into());
            }
        }
    }
    Ok(a.clone())
}
fn project(value: &Value, rule: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for p in rule["fields"].as_array().unwrap() {
        let p = p.as_str().unwrap();
        if let Some(v) = value.pointer(p) {
            // 只取明确命名的单值；禁止返回整份资料、数组、对象或超长正文。
            if v.is_boolean() || v.is_number() || v.is_null() || v.as_str().is_some_and(|s| s.chars().count() <= 200 && !s.chars().any(char::is_control)) {
                // 宿主会经过 JavaScript JSON；大整数先转字符串，避免店铺编号被舍入。
                let safe = if v.as_u64().is_some_and(|n|n>9_007_199_254_740_991) || v.as_i64().is_some_and(|n|n < -9_007_199_254_740_991) {json!(v.to_string())} else {v.clone()};
                fields.insert(p.to_string(), safe);
            }
        }
    }
    Value::Object(fields)
}
pub fn inspect<F>(url: &str, allowed: &[String], spec: &Value, deadline: Instant, cdp: &mut F) -> Result<(String, Value)>
where F: FnMut(&str, Value, Option<&str>, Instant) -> Result<Value> {
    let spec = rules(spec)?;
    let created = cdp("Target.createTarget", json!({"url":"about:blank","background":true}), None, deadline)?;
    let target = created["targetId"].as_str().ok_or(ERROR)?.to_owned();
    let result = (|| {
        let attached = cdp("Target.attachToTarget", json!({"targetId":target,"flatten":true}), None, deadline)?;
        let session = attached["sessionId"].as_str().ok_or(ERROR)?;
        let capture = (|| {
            cdp("Network.enable", json!({"maxTotalBufferSize":2097152,"maxResourceBufferSize":1048576}), Some(session), deadline)?;
            cdp("_read_events", json!({}), None, deadline)?;
            let until = deadline.checked_sub(Duration::from_millis(2000)).ok_or(ERROR)?;
            cdp("Page.navigate", json!({"url":url}), Some(session), until)?;
            let mut pending = HashMap::<String, Value>::new();
            let mut metadata = HashMap::<String, Value>::new();
            let mut results = serde_json::Map::new();
            while Instant::now() < until {
                cdp("Target.getTargetInfo", json!({"targetId":target}), None, until)?;
                let events = cdp("_read_events", json!({}), None, until)?;
                for e in events.as_array().ok_or(ERROR)? {
                    if e["sessionId"] != session { continue; }
                    let rid = e["requestId"].as_str().ok_or(ERROR)?;
                    match e["method"].as_str() {
                        Some("Network.requestWillBeSent") => { if metadata.len() < 256 { metadata.insert(rid.into(), e["metadata"].clone()); } },
                        Some("Network.responseReceived") => {
                            let Ok(u) = url::Url::parse(e["url"].as_str().unwrap_or("")) else {continue};
                            if allowed.contains(&u.origin().ascii_serialization()) && spec.iter().any(|r| r["path"] == u.path()) && pending.len() < 64 {
                                let mut item = e.clone(); item["path"] = json!(u.path()); pending.insert(rid.into(), item);
                            }
                        },
                        Some("Network.loadingFinished") => {
                            let Some(e) = pending.remove(rid) else {continue};
                            let rule = spec.iter().find(|r| r["path"] == e["path"]).ok_or(ERROR)?;
                            let body = cdp("Network.getResponseBody", json!({"requestId":rid}), Some(session), until);
                            let mut item = json!({"httpStatus":e["status"],"fields":{},"metadata":metadata.get(rid),"bodyState":"unavailable"});
                            if let Ok(body) = body { if body["base64Encoded"] == false {
                                if let Some(s) = body["body"].as_str().filter(|s| s.len() <= 1048576) {
                                    if let Ok(v) = serde_json::from_str::<Value>(s) { item["fields"] = project(&v,rule); item["bodyState"] = json!("json"); }
                                }
                            }}
                            results.insert(rule["id"].as_str().unwrap().into(),item);
                        },
                        _ => {}
                    }
                }
                // 页面还有加载/跳转时间；身份接口已得到时，等待至少两秒供正文稳定。
                std::thread::sleep(Duration::from_millis(80));
            }
            Ok(Value::Object(results))
        })();
        let _ = cdp("Target.detachFromTarget",json!({"sessionId":session}),None,deadline);
        capture
    })();
    match result {
        Ok(results) => Ok((target,results)),
        Err(e) => { let _ = cdp("Target.closeTarget",json!({"targetId":target}),None,deadline); Err(e) }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn scope_and_projection_never_return_whole_objects() {
        assert!(origins(&json!(["https://127.0.0.1"])).is_err());
        assert!(origins(&json!(["https://site.example/path"])).is_err());
        assert!(rules(&json!([{"id":"x","path":"/profile","fields":["/data/token"]}])).is_err());
        let r=json!({"id":"x","path":"/profile","fields":["/data/id","/data","/success"]});
        assert_eq!(project(&json!({"data":{"id":"123","password":"never"},"success":true}),&r),json!({"/data/id":"123","/success":true}));
        assert_eq!(project(&json!({"data":{"id":7498765432109876543_u64}}),&r)["/data/id"],"7498765432109876543");
    }
}
