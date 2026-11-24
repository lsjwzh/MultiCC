//! 运行真实的 HTTP 下载、缓存替换和启动参数适配，不用访问 GitHub。
use axum::{http::StatusCode, routing::get, Router};
use multicc_core::{agy_stream, cli_capability, effort_catalog};
use multicc_gateway::{effort_catalog_update::refresh, outbound::Outbound};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;
use url::Url;

#[tokio::test]
async fn downloads_newer_rules_keeps_last_good_on_failure_and_recovers_offline() {
    let root = std::env::temp_dir().join(format!("multicc-effort-update-{}", std::process::id()));
    let file = root.join("cache/cli-efforts.json");
    let bundled = effort_catalog::snapshot();
    let revision = bundled.revision;
    let mut data = serde_json::to_value(&*bundled).unwrap();
    let model = "gemini-4-argon";
    assert!(!cli_capability::supports_effort("agy", model, "xhigh"));
    data["revision"] = json!(revision + 1);
    data["efforts"]["agy"]["modelLevels"][model] = json!(["", "high", "xhigh"]);
    data["efforts"]["future-cli"] =
        json!({"label": "Effort", "levels": ["high"], "default": "high"});
    let body = Arc::new(Mutex::new((StatusCode::OK, data.to_string())));
    let response = body.clone();
    let router = Router::new().route(
        "/cli_efforts.json",
        get(move || {
            let response = response.clone();
            async move { response.lock().unwrap().clone() }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/cli_efforts.json",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = Outbound::from_process();
    refresh(&client, file.clone(), url.clone()).await.unwrap();
    let args = agy_stream::build_invocation(&agy_stream::InvocationInput {
        model: Some(model.into()),
        effort: Some("xhigh".into()),
        ..Default::default()
    })
    .args;
    assert!(args.windows(2).any(|args| args == ["--effort", "xhigh"]));
    let persisted = fs::read(&file).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&persisted).unwrap(), data);
    assert!(cli_capability::effort_of("future-cli").is_none());
    // 无效模型档位、未来格式、损坏 JSON、以及网络失败均不能破坏有效缓存。
    let mut invalid = data.clone();
    invalid["revision"] = json!(revision + 2);
    invalid["efforts"]["agy"]["modelLevels"][model] = json!(["missing"]);
    let mut future = data.clone();
    future["schemaVersion"] = json!(2);
    for bad in [
        invalid.to_string(),
        future.to_string(),
        "{".into(),
        " ".repeat(effort_catalog::MAX_BYTES + 1),
    ] {
        *body.lock().unwrap() = (StatusCode::OK, bad);
        assert!(refresh(&client, file.clone(), url.clone()).await.is_err());
        assert_eq!(fs::read(&file).unwrap(), persisted);
    }
    *body.lock().unwrap() = (StatusCode::OK, serde_json::to_string(&*bundled).unwrap());
    refresh(&client, file.clone(), url.clone()).await.unwrap();
    *body.lock().unwrap() = (StatusCode::NOT_FOUND, String::new());
    assert!(refresh(&client, file.clone(), url.clone()).await.is_err());
    server.abort();
    let _ = server.await;
    assert!(refresh(&client, file.clone(), url).await.is_err());
    assert_eq!(fs::read(&file).unwrap(), persisted);
    assert_eq!(effort_catalog::snapshot().revision, revision + 1);
    fs::remove_dir_all(root).unwrap();
}
