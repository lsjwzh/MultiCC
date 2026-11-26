//! Refresh imported records while retaining local-only credentials and tool settings.
use super::*;
use std::collections::HashMap;

fn parsed(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Value::Null => json!({}),
        other => other.clone(),
    }
}
pub fn refresh(
    mut records: Vec<Value>,
    rows: &[Value],
    port: &str,
    mut now: impl FnMut() -> i64,
) -> Result<(Vec<Value>, Value), String> {
    let mut index = HashMap::new();
    for (i, r) in records.iter().enumerate() {
        index.insert(
            (
                r["appType"].clone().to_string(),
                r["id"].clone().to_string(),
            ),
            i,
        );
    }
    let (mut imported, mut updated) = (0, 0);
    for r in rows {
        let kind = strval(&r["app_type"]);
        if !matches!(kind, "claude" | "codex") {
            continue;
        }
        let cfg = parsed(&r["settings_config"]);
        let meta = parsed(&r["meta"]);
        let entry = json!({"id":r["id"],"appType":kind,"apiFormat":settings::normalize_api_format(meta.get("apiFormat"),Some(kind)),"name":r["name"],"source":"ccswitch","settingsConfig":cfg,"importedAt":now()});
        if let Some(&i) = index.get(&(r["app_type"].to_string(), r["id"].to_string())) {
            let prev = &mut records[i];
            let env = prev["settingsConfig"]["env"].clone();
            for (k, v) in entry.as_object().expect("entry") {
                prev[k] = v.clone();
            }
            for k in ["ANTHROPIC_API_KEY", "MULTICC_TOOLS"] {
                if let Some(v) = env.get(k) {
                    if !prev["settingsConfig"].is_object() {
                        return Err("invalid provider settings".into());
                    }
                    if !prev["settingsConfig"]["env"].is_object() {
                        prev["settingsConfig"]["env"] = json!({});
                    }
                    prev["settingsConfig"]["env"][k] = v.clone();
                }
            }
            updated += 1;
        } else {
            records.push(entry);
            imported += 1;
        }
    }
    for r in &mut records {
        if r["appType"] == "codex" {
            r["settingsConfig"] = effective_codex(r, port);
        }
    }
    Ok((
        records,
        json!({"imported":imported,"updated":updated,"total":rows.len()}),
    ))
}
pub fn migrate(mut records: Vec<Value>, port: &str) -> (Vec<Value>, Value) {
    let mut updated = 0;
    for r in &mut records {
        let kind = strval(&r["appType"]);
        if !matches!(kind, "claude" | "codex") {
            continue;
        }
        let fmt = settings::normalize_api_format(r.get("apiFormat"), Some(kind));
        if r["apiFormat"] == fmt
            && !(kind == "codex" && config(r)["proxyTarget"]["mode"] == "chat-to-responses")
        {
            continue;
        }
        if kind == "codex" {
            r["settingsConfig"] = effective_codex(r, port);
        }
        r["apiFormat"] = fmt.into();
        updated += 1;
    }
    let result = json!({"updated":updated,"skipped":0,"total":records.len()});
    (records, result)
}
fn current_model(claude: bool, cfg: &Value) -> String {
    if claude {
        strval(&cfg["env"]["ANTHROPIC_MODEL"]).trim().into()
    } else {
        toml_value(cfg.get("config"), "model")
    }
}
pub fn catalog(p: &Value, input: &Value, now: f64) -> Result<Value, String> {
    let kind = strval(&p["appType"]);
    if !matches!(kind, "claude" | "codex") {
        return Err("provider not found".into());
    }
    let models: Vec<_> = settings::unique_models(
        input["models"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .into_iter()
    .filter(|m| m.encode_utf16().count() <= 160)
    .take(100)
    .collect();
    let Some(first) = models.first() else {
        return Err("relay model catalog is empty".into());
    };
    let preferred = strval(&input["preferredModel"]).trim();
    let preferred = if models.iter().any(|m| m == preferred) {
        preferred
    } else {
        first
    };
    let mut cfg = config(p);
    if !truthy(&cfg) {
        cfg = json!({});
    }
    if !cfg.is_object() {
        return Err("invalid provider settings".into());
    }
    let claude = kind == "claude";
    let current = current_model(claude, &cfg);
    let old_models: Vec<_> = cfg["modelCatalog"]["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("model").filter(|v| truthy(v)).cloned())
        .collect();
    let revision = strval(&input["revision"])
        .encode_utf16()
        .take(128)
        .collect::<Vec<_>>();
    let rev = if revision.is_empty() {
        Value::Null
    } else {
        String::from_utf16_lossy(&revision).into()
    };
    let selected = if models.contains(&current) {
        current.as_str()
    } else {
        preferred
    };
    if claude {
        if !truthy(&cfg["env"]) {
            cfg["env"] = json!({});
        }
        if !cfg["env"].is_object() {
            return Err("invalid provider environment".into());
        }
        cfg["env"]["ANTHROPIC_MODEL"] = selected.into();
    } else {
        cfg["config"] = replace_toml(strval(&cfg["config"]), "model", selected).into();
    }
    let changed = current != current_model(claude, &cfg)
        || json!(old_models) != json!(models)
        || p["relayModelCatalog"]["preferredModel"] != preferred
        || p["relayModelCatalog"]["revision"] != rev;
    cfg["modelCatalog"] =
        json!({"models":models.iter().map(|m|json!({"model":m})).collect::<Vec<_>>()});
    let timestamp = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str()?.trim().parse().ok())
            .filter(|n| *n != 0. && n.is_finite())
    };
    Ok(
        json!({"settingsConfig":cfg,"relayModelCatalog":{"version":1,"preferredModel":preferred,"models":models,"revision":rev,"syncedAt":now,"sourceGeneratedAt":timestamp(&input["sourceGeneratedAt"]),"sourceCatalogFetchedAt":timestamp(&input["sourceCatalogFetchedAt"])},"result":{"changed":changed,"model":current_model(claude,&cfg),"models":models,"preferredModel":preferred,"syncedAt":now}}),
    )
}
