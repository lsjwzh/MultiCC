//! Read-only credential interpretation. No OAuth refresh operation exists here.
use crate::{provider_store, subscription};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::path::Path;
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("").trim()
}
fn millis(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| v.timestamp_millis() as f64)
    })
}
pub fn jwt(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}
pub fn codex_subscription(auth: &Value) -> Value {
    let tokens = &auth["tokens"];
    for key in ["id_token", "access_token"] {
        let payload = jwt(text(tokens, key));
        let claims = &payload["https://api.openai.com/auth"];
        if !claims.is_object() {
            continue;
        }
        if !text(tokens, "account_id").is_empty()
            && !text(claims, "chatgpt_account_id").is_empty()
            && tokens["account_id"] != claims["chatgpt_account_id"]
        {
            continue;
        }
        if let Ok(result) = subscription::parse(
            &json!({"body":claims,"source":"login","observedAt":payload["iat"]}).to_string(),
        ) {
            let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
            if !result.is_null() {
                return result;
            }
        }
    }
    Value::Null
}
pub fn codex_auth(auth: &Value) -> Value {
    let tokens = &auth["tokens"];
    if text(tokens, "access_token").is_empty() {
        return Value::Null;
    }
    json!({"accessToken":text(tokens,"access_token"),"accountId":text(tokens,"account_id"),"subscription":codex_subscription(auth)})
}
pub fn cli(raw: &str) -> Value {
    let Ok(json) = serde_json::from_str::<Value>(raw) else {
        return json!({"ok":false,"reason":"not_json"});
    };
    let oauth = if json["claudeAiOauth"].is_object() {
        &json["claudeAiOauth"]
    } else {
        &json
    };
    if text(oauth, "accessToken").is_empty() {
        return json!({"ok":false,"reason":"access_token_missing"});
    }
    let expiry = oauth["expiresAt"]
        .as_f64()
        .or_else(|| oauth["expiresAt"].as_str()?.parse().ok());
    json!({"ok":true,"accessToken":text(oauth,"accessToken"),"refreshToken":oauth["refreshToken"].as_str().unwrap_or(""),
        "expiresAt":expiry,"subscriptionType":oauth["subscriptionType"].as_str().unwrap_or(""),
        "scopes":oauth["scopes"].as_array().map(|a| a.iter().filter(|v| v.is_string()).cloned().collect::<Vec<_>>())})
}
pub fn stored(data: &Value) -> Value {
    if data.is_null() {
        return json!({"ok":false,"reason":"credential_unreadable"});
    }
    if text(data, "access_token").is_empty() {
        return json!({"ok":false,"reason":"access_token_missing"});
    }
    json!({"ok":true,"accessToken":text(data,"access_token"),"refreshToken":text(data,"refresh_token"),
        "expiresAt":millis(&data["expired"]),"cliCopy":data["source"] == "cli-import"})
}
pub fn codex_credential(auth: &Value, now: f64) -> Value {
    if auth.is_null() {
        return json!({"ok":false,"reason":"credential_unreadable"});
    }
    let tokens = &auth["tokens"];
    let token = text(tokens, "access_token");
    let account = text(tokens, "account_id");
    if token.is_empty() {
        return json!({"ok":false,"reason":"access_token_missing"});
    }
    if account.is_empty() {
        return json!({"ok":false,"reason":"account_id_missing"});
    }
    let expiry = jwt(token)["exp"].as_f64().map(|n| n * 1000.0);
    if expiry.is_some_and(|n| n != 0.0 && n <= now) {
        return json!({"ok":false,"reason":"access_token_expired","expiresAt":expiry});
    }
    json!({"ok":true,"accessToken":token,"accountId":account,"expiresAt":expiry})
}
pub fn run(v: &Value) -> Result<Value, String> {
    let file = Path::new(v["file"].as_str().unwrap_or(""));
    Ok(match v["operation"].as_str().unwrap_or("") {
        "readStateJson" => provider_store::read(file)?.unwrap_or_else(|| json!({})),
        "readJson" => provider_store::read(file)
            .ok()
            .flatten()
            .filter(Value::is_object)
            .unwrap_or(Value::Null),
        "writeJson" | "patchJson" => {
            if !v["data"].is_object() {
                return Err("CREDENTIAL_INVALID_DATA".into());
            }
            let _guard = provider_store::lock(file)?;
            let previous = provider_store::read(file)?;
            let mut data = if v["operation"] == "patchJson" {
                let mut previous = previous.unwrap_or_else(|| json!({}));
                previous
                    .as_object_mut()
                    .ok_or("CREDENTIAL_INVALID_DATA")?
                    .extend(v["data"].as_object().unwrap().clone());
                previous
            } else {
                v["data"].clone()
            };
            if v["claude"] == true {
                data["type"] = json!("claude");
            }
            provider_store::atomic_write(file, &data)?;
            data
        }
        "codexCredential" => {
            let auth = if let Some(data) = v.get("auth") {
                data.clone()
            } else {
                provider_store::read(file)
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null)
            };
            codex_credential(&auth, v["now"].as_f64().unwrap_or(0.0))
        }
        "codexAuth" => codex_auth(
            &provider_store::read(file)
                .ok()
                .flatten()
                .unwrap_or(Value::Null),
        ),
        "codexSubscription" => codex_subscription(&v["auth"]),
        "parseCli" => cli(v["raw"].as_str().unwrap_or("")),
        "stored" => stored(&v["data"]),
        "usable" => {
            let data = &v["stored"];
            if data["ok"] != true {
                json!({"token":null,"reason":data["reason"]})
            } else if data["expiresAt"].is_null()
                || data["expiresAt"].as_f64().unwrap_or(0.0)
                    > v["now"].as_f64().unwrap_or(0.0) + v["margin"].as_f64().unwrap_or(0.0)
            {
                json!({"token":data["accessToken"]})
            } else {
                json!({"token":null,"reason":if data["cliCopy"] == true {"cli_copy_needs_login"} else {"access_token_expired"}})
            }
        }
        _ => return Err("CREDENTIAL_INVALID_OPERATION".into()),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_read_only_and_account_bound() {
        assert_eq!(cli("bad")["reason"], "not_json");
        assert_eq!(
            cli(r#"{"claudeAiOauth":{"accessToken":" a ","expiresAt":123}}"#)["accessToken"],
            "a"
        );
        assert_eq!(run(&json!({"operation":"usable","stored":{"ok":true,"accessToken":"a","expiresAt":100},"now":100,"margin":0})).unwrap()["reason"], "access_token_expired");
        let payload = URL_SAFE_NO_PAD.encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"other","current_period_end":"2030-01-01"}}"#);
        assert!(codex_subscription(
            &json!({"tokens":{"account_id":"selected","id_token":format!("t.{payload}.s")}})
        )
        .is_null());
        assert!(run(&json!({"operation":"refresh"})).is_err());
    }
}
