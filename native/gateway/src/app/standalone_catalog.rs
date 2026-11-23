//! Disk-backed facts for the standalone provider picker and Aux configuration.
use super::{
    express::{self, RequestCtx},
    providers::catalog_view,
    App,
};
use axum::{body::Body, http::Response};
use multicc_core::{
    js, provider_catalog_snapshot, provider_defaults_store::ProviderDefaultsStore,
    provider_limit_store, provider_store, quota_bar_view, quota_guard, subscription_cache,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

fn key(p: &Value) -> String {
    format!(
        "{}:{}",
        p["appType"].as_str().unwrap_or_default(),
        p["id"].as_str().unwrap_or_default()
    )
}
fn quota(root: &Path, now: i64) -> (Value, Value) {
    let db = root.join("provider-limit-cache.db");
    let legacy = root.join("provider-limit-cache.json");
    let limits = if db.exists() {
        provider_limit_store::Store::open_existing(&db).ok()
    } else if legacy.exists() {
        provider_limit_store::Store::open(&db, Some(&legacy), now as f64)
            .ok()
            .map(|(store, _)| store)
    } else {
        None
    };
    let limits = limits
        .and_then(|s| s.snapshot().ok())
        .map(|s| js::to_serde(&s)["entries"].clone())
        .unwrap_or_else(|| json!({}));
    let subscriptions = if db.is_file() {
        subscription_cache::access(&db.to_string_lossy(), r#"{"operation":"read"}"#)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Value::Null
    };
    (limits, subscriptions)
}

fn cli_available(name: &str, override_keys: &[&str]) -> bool {
    let command = override_keys
        .iter()
        .find_map(|k| std::env::var_os(k).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| format!("{name}{}", std::env::consts::EXE_SUFFIX).into());
    let runnable = |p: &Path| {
        let Ok(meta) = p.metadata() else { return false };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.is_file() && meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            meta.is_file()
        }
    };
    let cmd = Path::new(&command);
    if cmd.components().count() > 1 {
        return runnable(cmd);
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|p| runnable(&p.join(cmd)))
}

fn aux(root: &Path, mut groups: Value, facts: &Value) -> Value {
    let file = root.join("aux-config.json");
    let raw = provider_store::read(&file).ok().flatten();
    let cfg = raw.as_ref().unwrap_or(&Value::Null);
    let protocol = cfg["protocol"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(if cfg["cli"] == "codex" {
            "openai"
        } else {
            "anthropic"
        });
    let model = cfg
        .get("model")
        .filter(|v| js::serde::truthy(v))
        .map(js::serde::js_string);
    let mut result = json!({"protocol":if protocol.eq_ignore_ascii_case("openai"){"openai"}else{"anthropic"},
        "providerId":cfg.get("providerId").filter(|v|js::serde::truthy(v)), "model":model.as_deref().map(js::js_trim).filter(|s|!s.is_empty())});
    if raw.is_some() && cfg != &result {
        let _ = provider_store::atomic_write(&file, &result);
    }
    for (protocol, kind) in [("anthropic", "claude"), ("openai", "codex")] {
        for p in groups[protocol].as_array_mut().into_iter().flatten() {
            let mut limit = catalog_view::limit(
                facts,
                &format!("{kind}:{}", p["id"].as_str().unwrap_or_default()),
            );
            if let Some(obj) = limit.as_object_mut() {
                obj.shift_remove("bar");
            }
            p["limit"] = limit;
        }
    }
    result["cliAvailability"] = json!({"claude":cli_available("claude",&["MULTICC_CLAUDE_BIN"]),"codex":cli_available("codex",&["CODEX_BIN","CODEX_CMD"])});
    result["protocols"] = json!([{"id":"anthropic","name":"Anthropic Messages"},{"id":"openai","name":"OpenAI Responses / Chat Completions"}]);
    result["providersByProtocol"] = groups;
    result
}

fn read(app: &App, filter: Option<(&str, &str)>) -> Result<Value, &'static str> {
    let root = &app.data_root;
    let home = &app.home_dir;
    let catalog = provider_catalog_snapshot::read(root, home)?;
    let now = chrono::Utc::now().timestamp_millis();
    let (limits, subscriptions) = quota(root, now);
    let mut facts = json!({"subscriptions":subscriptions,"limits":limits,"limitBars":{},"nowMs":now,"limitCacheStaleMs":600000});
    let Some((kind, cli)) = filter else {
        if let Ok(ms) = std::env::var("MULTICC_LIMIT_CACHE_STALE_MS")
            .unwrap_or_default()
            .parse::<i64>()
        {
            if ms != 0 {
                facts["limitCacheStaleMs"] = ms.into();
            }
        }
        return Ok(aux(root, catalog.aux, &facts));
    };
    let cc = home.join(".cc-switch/cc-switch.db");
    let found = cc.exists();
    facts["ccSwitchStatus"] = json!({"available":found,"dbFound":found,"dbPath":cc,"reason":(!found).then_some("database-not-found"),
        "message":if found {String::new()}else{format!("CC-Switch database was not found at {}.",cc.display())}});
    let mut defaults =
        js::to_serde(&ProviderDefaultsStore::open(root.join("provider-defaults.json")).snapshot());
    for k in ["claude", "codex"] {
        defaults[k] =
            multicc_core::provider_catalog::normalize_default(root, home, k, &defaults[k])?;
    }
    facts["defaults"] = defaults;
    facts["stats"] = super::provider_catalog_stats::read(root, &catalog.providers);
    if catalog.providers.iter().any(|p| p["virtual"].is_object()) {
        let env: serde_json::Map<String, Value> = std::env::vars()
            .filter(|(k, _)| k.starts_with("MULTICC_QUOTA_GUARD"))
            .map(|(k, v)| (k, v.into()))
            .collect();
        let config = quota_guard::Guard::new(Some(root.join("quota-guard.json")))
            .config(&js::from_serde(&env.into()), now as f64);
        let mut candidates = catalog.providers.clone();
        for p in &mut candidates {
            let active = quota_guard::applies_to(&js::from_serde(&p["id"]), &config);
            let verdict =
                quota_guard::guard_verdict(&js::from_serde(&limits[key(p)]), &config, now as f64);
            p["virtualGateAllowed"] = json!(
                p["egressIpAllowlist"].as_array().is_none_or(Vec::is_empty)
                    && !(active && js::to_serde(&verdict)["blocked"] == true)
            );
        }
        for p in catalog
            .providers
            .iter()
            .filter(|p| p["virtual"].is_object())
        {
            facts["virtualInputs"][key(p)] = json!({"providerId":p["id"],"appType":p["appType"],"virtual":p["virtual"],
                "providers":candidates,"limits":limits,"subscriptions":subscriptions,"excluded":[],"now":now});
        }
    }
    for (k, entry) in limits.as_object().into_iter().flatten() {
        let mut entry = entry.clone();
        entry["stale"] = json!(entry["fetchedAt"]
            .as_i64()
            .is_some_and(|at| now - at > 600000));
        facts["limitBars"][k] = js::to_serde(&quota_bar_view::provider_limit(
            &js::from_serde(&entry),
            now as f64,
        ));
    }
    facts["providers"] = catalog
        .providers
        .into_iter()
        .filter(|p| !matches!(kind, "claude" | "codex") || p["appType"] == kind)
        .collect();
    Ok(catalog_view::project(&facts, cli))
}

pub(super) async fn handle(
    app: &Arc<App>,
    ctx: &RequestCtx,
    filter: Option<(String, String)>,
) -> Response<Body> {
    let app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        read(&app, filter.as_ref().map(|(a, c)| (a.as_str(), c.as_str())))
    })
    .await;
    match result {
        Ok(Ok(value)) => express::json(ctx, 200, &value, &[]),
        _ => express::error(ctx, 500, "provider catalog unavailable"),
    }
}
