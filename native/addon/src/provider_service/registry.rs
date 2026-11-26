//! A store read returns the optimistic revision token, held across validation and commit.
use crate::{host_methods::method, route_response::*};
use multicc_core::{
    js::serde::from_serde,
    provider_catalog,
    provider_routing::{import, targets},
    provider_writes::{self as writes, Commit},
};
use napi_derive::napi;
use serde_json::{json, Value};
pub(super) fn data(v: L<'_>) -> Result<Value> {
    Ok(multicc_core::js::serde::to_serde(&unsafe {
        crate::js_bridge::read_value(v.env(), v.raw(), 0, &mut Vec::new())
    }?))
}
pub(super) fn live<'a>(p: L<'a>, v: &Value) -> Result<L<'a>> {
    p.from_value(&from_serde(v))
}
pub(super) fn value_string(v: L<'_>) -> Result<String> {
    Ok(v.string()?.map(|s| s.to_string_lossy()).unwrap_or_default())
}
pub(super) fn port<'a>(p: L<'a>, k: &std::ffi::CStr, a: &[L<'a>]) -> Result<L<'a>> {
    p.get(k)?.call_plain(a)
}
fn load(p: L<'_>) -> Result<L<'_>> {
    call(p.get(c"store")?, c"read", &[])
}
fn save<'a>(p: L<'a>, next: L<'a>, source: L<'a>) -> Result<()> {
    call(p.get(c"store")?, c"write", &[next, source])?;
    p.set(c"relayCache", null(p)?)
}
pub(super) fn get<'a>(p: L<'a>, kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let catalog = p.get(c"catalog")?;
    if catalog.truthy()? {
        return call(catalog, c"get", &[kind, id]);
    }
    let rows = load(p)?;
    for i in 0..(rows.get(c"length")?.number()? as u32) {
        let r = rows.element(i)?;
        if r.get(c"id")?.equals(id)? && (!kind.truthy()? || r.get(c"appType")?.equals(kind)?) {
            return Ok(r);
        }
    }
    null(p)
}
fn summarize<'a>(p: L<'a>, row: L<'a>, options: Option<L<'a>>) -> Result<L<'a>> {
    let (summary, external_models) = multicc_core::provider_catalog_snapshot::host_summary(
        &data(row)?,
        &value_string(port(p, c"getPort", &[])?)?,
    )
    .map_err(napi::Error::from_reason)?;
    let result = live(p, &summary)?;
    for key in [c"id", c"name", c"appType"] {
        result.set(key, row.get(key)?)?;
    }
    if external_models {
        let options = options.unwrap_or(p.from_value(&V::Undefined)?);
        let path = options.optional(c"codexCachePath")?;
        let models = if path.truthy()? {
            model_cache(p, path)?
        } else {
            port(
                p,
                c"accountModels",
                &[row, options.optional(c"codexModelCatalogRuntime")?],
            )?
        };
        result.set(c"modelOptions", models)?;
    }
    Ok(result)
}
fn business_error(p: L<'_>, message: String) -> napi::Error {
    (|| -> Result<L<'_>> { p.global()?.get(c"Error")?.construct(&[text(p, &message)?]) })()
        .map_or_else(|e| e, |e| e.throw_error())
}
fn list<'a>(p: L<'a>, kind: L<'a>) -> Result<L<'a>> {
    let catalog = p.get(c"catalog")?;
    let mounted = catalog.truthy()?;
    let rows = if mounted {
        call(catalog, c"list", &[kind])?
    } else {
        load(p)?
    };
    let arr = p.global()?.get(c"Array")?.construct(&[])?;
    for i in 0..(rows.get(c"length")?.number()? as u32) {
        let row = rows.element(i)?;
        if mounted || !kind.truthy()? || row.get(c"appType")?.equals(kind)? {
            call(arr, c"push", &[summarize(p, row, None)?])?;
        }
    }
    Ok(arr)
}
fn now(p: L<'_>) -> Result<f64> {
    call(p.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn relay_available<'a>(p: L<'a>, kind: L<'a>) -> Result<L<'a>> {
    let name = value_string(kind)?;
    if !matches!(name.as_str(), "claude" | "codex") {
        return flag(p, false);
    }
    let at = now(p)?;
    let mut cache = p.get(c"relayCache")?;
    if !cache.truthy()? || at - cache.get(c"at")?.number()? > 1000. {
        let result = p.catch(|| {
            let next = fields(p, &[("at", num(p, at)?)])?;
            let rows = load(p)?;
            let force = port(p, c"relayForced", &[])?.is_true()?;
            let service_port = value_string(port(p, c"getPort", &[])?)?;
            for i in 0..(rows.get(c"length")?.number()? as u32) {
                let r = rows.element(i)?;
                if !r.truthy()? || r.get(c"virtual")?.truthy()? {
                    continue;
                }
                let lane = r.get(c"appType")?;
                let key = if lane.is_string("claude")? {
                    c"claude"
                } else if lane.is_string("codex")? {
                    c"codex"
                } else {
                    continue;
                };
                if next.get(key)?.is_true()? {
                    continue;
                }
                let selected = get(p, lane, r.get(c"id")?)?;
                let catalog = p.get(c"catalog")?;
                if !selected.truthy()?
                    || (catalog.truthy()?
                        && provider_catalog::is_official(&data(selected)?).unwrap_or(false))
                {
                    continue;
                }
                if !targets::relay(&value_string(lane)?, &data(selected)?, force, &service_port)
                    .is_null()
                {
                    next.set(key, flag(p, true)?)?;
                }
            }
            Ok(next)
        })?;
        let Some(next) = result else {
            return flag(p, false);
        };
        cache = next;
        p.set(c"relayCache", cache)?;
    }
    flag(
        p,
        cache
            .get(if name == "claude" {
                c"claude"
            } else {
                c"codex"
            })?
            .is_true()?,
    )
}
#[derive(Clone, Copy, PartialEq)]
enum Op {
    Create,
    Update,
    Delete,
}
fn write<'a>(p: L<'a>, op: Op, a: &mut [L<'a>]) -> Result<L<'a>> {
    let undefined = p.from_value(&V::Undefined)?;
    let (kind, id, request) = match op {
        Op::Create => (a[0].optional(c"appType")?, port(p, c"uuid", &[])?, a[0]),
        Op::Update => (a[0], a[1], a[2]),
        Op::Delete => (a[0], a[1], undefined),
    };
    let existing = if op == Op::Update {
        get(p, kind, id)?
    } else {
        null(p)?
    };
    let rows_before = if op == Op::Delete {
        Some(load(p)?)
    } else {
        None
    };
    let catalog = p.get(c"catalog")?;
    let k = value_string(kind)?;
    let id_text = value_string(id)?;
    let mounted = catalog.truthy()?;
    let normalize = if mounted {
        Some(value_string(call(catalog, c"normalize", &[kind, id])?)?)
    } else {
        None
    };
    let official =
        |id: &str| mounted && provider_catalog::is_official_provider_id(&k, Some(&json!(id)));
    let mut facts = writes::WriteFacts {
        official_catalog_mounted: mounted,
        id_is_official: official(&id_text),
        normalized_id_is_official: normalize.as_deref().is_some_and(official),
        normalized_id: normalize,
        new_id: id_text.clone(),
        now_ms: now(p)?,
        port: value_string(port(p, c"getPort", &[])?)?,
        ..Default::default()
    };
    let input = data(request)?.as_object().cloned().unwrap_or_default();
    if op == Op::Create && mounted {
        if let Some(record) = writes::assemble_create_record(&input, &facts)
            .map_err(|error| business_error(p, error))?
        {
            facts.assembled_is_official = provider_catalog::is_official(&record)
                .map_err(|_| napi::Error::from_reason("invalid provider settings"))?;
        }
    }
    let source = match rows_before {
        Some(rows) => rows,
        None => load(p)?,
    };
    let records = data(source)?;
    let existing_data = data(existing)?;
    loop {
        let decision = match op {
            Op::Create => writes::create_provider(&records, &input, &facts),
            Op::Update => writes::update_provider(
                &records,
                &k,
                &id_text,
                &input,
                Some(&existing_data).filter(|v| !v.is_null()),
                &facts,
            ),
            Op::Delete => writes::delete_provider(&records, &k, &id_text, &facts),
        }
        .map_err(|error| business_error(p, error))?;
        match decision {
            Commit::Save { records, result } => {
                save(p, live(p, &records)?, source)?;
                return live(p, &result);
            }
            Commit::Answer { result } => return live(p, &result),
            Commit::OfficialCatalogEntry { app_type } => {
                return summarize(p, call(catalog, c"provider", &[text(p, &app_type)?])?, None)
            }
            Commit::OfficialDelete {
                app_type,
                id,
                records,
                records_changed,
            } => {
                let result = call(catalog, c"delete", &[text(p, &app_type)?, text(p, &id)?])?;
                if records_changed {
                    save(p, live(p, &records)?, source)?;
                }
                return Ok(result);
            }
            Commit::NeedsVirtualPlan => {
                if facts.virtual_plan.is_some() {
                    return Err(napi::Error::from_reason("invalid virtual provider plan"));
                }
                let mut spec = request.optional(c"virtual")?;
                if op == Op::Update && spec.undefined()? {
                    spec = existing.optional(c"virtual")?;
                }
                let input = json!({"appType":k,"id":id_text,"virtual":data(spec)?,"providers":data(list(p,undefined)?)?});
                facts.virtual_plan = Some(
                    multicc_core::virtual_provider::validate_record(&input)
                        .map_err(napi::Error::from_reason)?,
                );
            }
        }
    }
}
fn import_rows<'a>(p: L<'a>, external: Option<Vec<Value>>) -> Result<L<'a>> {
    let service_port = value_string(port(p, c"getPort", &[])?)?;
    let source = load(p)?;
    let rows = data(source)?.as_array().cloned().unwrap_or_default();
    let imported = external.is_some();
    let (next, result) = if let Some(input) = external {
        let time = now(p)? as i64;
        import::refresh(rows, &input, &service_port, || time).map_err(napi::Error::from_reason)?
    } else {
        import::migrate(rows, &service_port)
    };
    if imported || result["updated"] != 0 {
        save(p, live(p, &Value::Array(next))?, source)?;
    }
    live(p, &result)
}
fn model_cache<'a>(p: L<'a>, file: L<'a>) -> Result<L<'a>> {
    use std::{fs, path::Path, time::UNIX_EPOCH};
    let filename = value_string(file)?;
    let path = Path::new(&filename);
    let empty = || live(p, &json!([]));
    let Some(stamp) = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    else {
        return empty();
    };
    let stamp = text(p, &stamp.as_nanos().to_string())?;
    let cache = p.get(c"modelCache")?;
    if cache.truthy()? && file.equals(cache.get(c"path")?)? && stamp.equals(cache.get(c"mtime")?)? {
        return cache.get(c"models");
    }
    let Some(parsed) = fs::File::open(path)
        .ok()
        .and_then(|f| serde_json::from_reader::<_, Value>(std::io::BufReader::new(f)).ok())
    else {
        return empty();
    };
    let mut entries: Vec<_> = parsed["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["visibility"] == "list" && e["slug"].is_string())
        .collect();
    let priority = |e: &Value| {
        if e["priority"].is_null() {
            99.
        } else {
            multicc_core::js::serde::js_string_to_number(&multicc_core::js::serde::js_string(
                &e["priority"],
            ))
        }
    };
    entries.sort_by(|a, b| {
        priority(a)
            .partial_cmp(&priority(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let models = live(
        p,
        &Value::Array(entries.into_iter().map(|e| e["slug"].clone()).collect()),
    )?;
    p.set(
        c"modelCache",
        fields(p, &[("path", file), ("mtime", stamp), ("models", models)])?,
    )?;
    Ok(models)
}
fn update_catalog<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let source = load(p)?;
    let mut records = data(source)?;
    let kind = value_string(a[0])?;
    let id = value_string(a[1])?;
    let row = records
        .as_array_mut()
        .and_then(|rows| {
            rows.iter_mut()
                .find(|r| r["id"] == id && r["appType"] == kind)
        })
        .ok_or_else(|| napi::Error::from_reason("provider not found"))?;
    let (summary, _) = multicc_core::provider_catalog_snapshot::host_summary(
        row,
        &value_string(port(p, c"getPort", &[])?)?,
    )
    .map_err(napi::Error::from_reason)?;
    if !multicc_core::provider_registry::relay_route_from_base_url(summary.get("baseUrl"))
        .is_some_and(|r| r["appType"] == kind)
    {
        return Err(napi::Error::from_reason("provider is not a remote relay"));
    }
    let delta = import::catalog(row, &data(a[2])?, now(p)?).map_err(napi::Error::from_reason)?;
    row["settingsConfig"] = delta["settingsConfig"].clone();
    row["relayModelCatalog"] = delta["relayModelCatalog"].clone();
    save(p, live(p, &records)?, source)?;
    live(p, &delta["result"])
}
pub(super) fn spawn_plan<'a>(p: L<'a>, session: L<'a>) -> Result<L<'a>> {
    use multicc_core::provider_routing::spawn;
    use std::path::Path;
    let id = session.optional(c"provider")?;
    if !id.truthy()? {
        return live(
            p,
            &spawn::empty("", false, &Value::Null).map_err(napi::Error::from_reason)?,
        );
    }
    let lane = value_string(session.get(c"cli")?)?;
    let Some(pool) = spawn::lookup(&lane) else {
        return live(
            p,
            &spawn::empty("", false, &Value::Null).map_err(napi::Error::from_reason)?,
        );
    };
    let kind = if pool.is_empty() {
        p.from_value(&V::Undefined)?
    } else {
        text(p, pool)?
    };
    let record = get(p, kind, id)?;
    let row = data(record)?;
    let service_port = value_string(port(p, c"getPort", &[])?)?;
    let mut summary = Value::Null;
    if record.truthy()? {
        summary =
            if record.get(c"settingsConfig")?.truthy()? && !record.get(c"virtual")?.truthy()? {
                data(summarize(p, record, None)?)?
            } else {
                row.clone()
            };
    }
    let string_field = |key: &str| summary[key].as_str().map(str::to_owned);
    let facts = multicc_core::provider_registry::ProviderCliFacts {
        app_type: string_field("appType"),
        virtual_truthy: multicc_core::js::serde::truthy(&summary["virtual"]),
        api_format: string_field("apiFormat"),
        protocol: string_field("protocol"),
        base_url_truthy: multicc_core::js::serde::truthy(&summary["baseUrl"]),
        has_token_truthy: multicc_core::js::serde::truthy(&summary["hasToken"]),
    };
    if row.is_null()
        || !multicc_core::provider_registry::provider_supports_cli(Some(&facts), Some(&lane))
    {
        return live(
            p,
            &spawn::empty(&lane, true, &Value::Null).map_err(napi::Error::from_reason)?,
        );
    }
    if matches!(
        lane.as_str(),
        "opencode" | "zcode" | "kimi" | "dsh" | "grok"
    ) {
        let identity = session.optional(c"id")?;
        let identity = if identity.truthy()? {
            identity
        } else {
            session.optional(c"sessionId")?
        };
        let selection = json!({"id":value_string(string(fallback(identity,"".into())?)?)?,"model":data(session.optional(c"model")?)?});
        let root = value_string(p.get(c"vendorRoots")?.get_key(text(p, &lane)?)?)?;
        let mut result = super::vendor_plan(
            &lane,
            &row,
            &summary,
            &selection,
            Path::new(&root),
            p.get(c"modelLimits")?,
        )?;
        result["skipDefaultModel"] = false.into();
        result["aliasOnly"] = false.into();
        return live(p, &result);
    }
    if matches!(lane.as_str(), "claude" | "claude-exp") {
        let plan = live(p, &spawn::claude(&row))?;
        if !plan.has(c"tools")? {
            plan.set(c"tools", p.from_value(&V::Undefined)?)?
        }
        p.catch(|| port(p, c"logModels", &[id, plan]))?;
        return Ok(plan);
    }
    live(
        p,
        &spawn::codex(
            &row,
            &value_string(id)?,
            Path::new(&value_string(p.get(c"codexHomes")?)?),
            Path::new(&value_string(p.get(c"codexGlobal")?)?),
            &service_port,
        )
        .map_err(napi::Error::from_reason)?,
    )
}
#[napi]
pub fn provider_registry_service(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    type F = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
    let api = fields(p, &[])?;
    for (name, n, run) in [
        ("applyCodexProxyConfig", 2, super::proxy::codex as F),
        ("releaseCodexProxyConfig", 1, |p, a| {
            super::proxy::release(p, a[0])
        }),
        ("applyCodexLeaseEnv", 2, super::proxy::lease_env),
        ("applyClaudeProxyEnv", 2, super::proxy::claude),
        ("routingProviderView", 2, super::proxy::view),
        ("resolveSpawnEnv", 1, |p, a| spawn_plan(p, a[0])),
        ("buildChildEnv", 3, super::environment::child as F),
        ("summarize", 2, |p, a| summarize(p, a[0], Some(a[1]))),
        (
            "getProvider",
            2,
            (|p, a: &mut [L<'_>]| get(p, a[0], a[1])) as F,
        ),
        ("listProviders", 1, |p, a| list(p, a[0])),
        ("hasCliRelayProvider", 1, |p, a| relay_available(p, a[0])),
        ("createProvider", 1, |p, a| write(p, Op::Create, a)),
        ("updateProvider", 3, |p, a| write(p, Op::Update, a)),
        ("deleteProvider", 2, |p, a| write(p, Op::Delete, a)),
        ("importFromCcSwitch", 0, |p, _| {
            import_rows(
                p,
                Some(crate::cc_switch::read_rows(
                    p,
                    &value_string(port(p, c"ccPath", &[])?)?,
                )?),
            )
        }),
        ("migrateLegacyProviderProtocols", 0, |p, _| {
            import_rows(p, None)
        }),
        ("updateProviderRelayModelCatalog", 3, update_catalog),
        ("readOfficialModels", 1, |p, a| model_cache(p, a[0])),
    ] {
        api.define_key(text(p, name)?, method(&env, p, name, n, n, run)?)?;
    }
    Ok(api.raw())
}
