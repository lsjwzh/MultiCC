//! Native credential and account query host. Never rotates credentials.
use multicc_core::provider_credentials;
use serde_json::{json, Value};
use std::time::Duration;
pub async fn read_cli(input: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "CREDENTIAL_INVALID_REQUEST")?;
    if v["platform"] == "darwin" {
        let service = v["service"].as_str().unwrap_or("Claude Code-credentials");
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("/usr/bin/security")
                .args(["find-generic-password", "-s", service, "-w"])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        if let Ok(Ok(output)) = output {
            if output.status.success() && output.stdout.len() <= 1024 * 1024 {
                let mut result =
                    provider_credentials::cli(&String::from_utf8_lossy(&output.stdout));
                if result["ok"] == true {
                    result["store"] = json!("keychain");
                    return Ok(result);
                }
            }
        }
    }
    let file = v["file"].as_str().unwrap_or("").to_owned();
    let data = tokio::task::spawn_blocking(move || {
        multicc_core::provider_store::read(std::path::Path::new(&file))
    })
    .await
    .map_err(|_| "CREDENTIAL_READ_FAILED")?;
    match data {
        Ok(Some(data)) => {
            let mut result = provider_credentials::cli(&data.to_string());
            result["store"] = json!("file");
            Ok(result)
        }
        _ => Ok(
            json!({"ok":false,"reason":"unreadable","store":if v["platform"] == "darwin" {"keychain"} else {"file"}}),
        ),
    }
}

pub async fn subscription_plan(input: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        multicc_core::account_subscription::plan(
            input["vendor"].as_str().unwrap_or(""),
            std::path::Path::new(input["authFile"].as_str().unwrap_or("")),
            input["token"].as_str().unwrap_or(""),
        )
    })
    .await
    .map_err(|_| "CREDENTIAL_READ_FAILED")?
}
pub fn subscription_result(v: &Value) -> Value {
    multicc_core::account_subscription::result(v)
}
pub async fn subscription_query(plan: Value) -> Value {
    let request = async {
        let client = crate::transport::client_for_proxy(plan["proxyUrl"].as_str())?;
        let url = plan["url"].as_str().ok_or("SUBSCRIPTION_INVALID_URL")?;
        let mut req = client.get(url);
        for (key, value) in plan["headers"]
            .as_object()
            .ok_or("SUBSCRIPTION_INVALID_HEADERS")?
        {
            req = req.header(key, value.as_str().ok_or("SUBSCRIPTION_INVALID_HEADERS")?);
        }
        let mut response = req.send().await.map_err(|_| "SUBSCRIPTION_UNAVAILABLE")?;
        let status = response.status().as_u16();
        // Refusals, including redirects, never forward credentials elsewhere.
        if !(200..300).contains(&status) {
            return Ok::<_, String>((status, Value::Null));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "SUBSCRIPTION_UNAVAILABLE")?
        {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("SUBSCRIPTION_TOO_LARGE".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = serde_json::from_slice(&bytes).map_err(|_| "SUBSCRIPTION_INVALID_JSON")?;
        Ok((status, body))
    };
    let (status, body) = tokio::time::timeout(Duration::from_secs(10), request)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or((0, Value::Null));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    subscription_result(&json!({"plan":plan,"status":status,"body":body,"now":now}))
}
