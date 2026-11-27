//! Compose the provider facade around one repository, registry service, and
//! official catalog. Only the router SDK, environment and OS hooks are injected.
mod facade;
mod probe;
use crate::{
    host_methods::{arg, async_result, default_object, env, function, raw},
    provider_host_values::provider_credential_value,
    provider_registry as registry, provider_service as service,
    route_response::*,
};
use napi_derive::napi;
use std::{ffi::CStr, path::Path};

fn und(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn word(p: L<'_>) -> Result<String> {
    Ok(p.coerce_string()?.to_string_lossy())
}
fn array(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(vec![]))
}
fn strings<'a>(p: L<'a>, s: impl IntoIterator<Item = impl Into<String>>) -> Result<L<'a>> {
    p.from_value(&V::Array(
        s.into_iter().map(|v| V::from(v.into())).collect(),
    ))
}
fn port<'a>(p: L<'a>, k: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
    p.get(k)?.call_plain(a)
}
fn reg<'a>(p: L<'a>, k: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(c"registry")?, k, a)
}
fn join<'a>(p: L<'a>, s: &[&str]) -> Result<L<'a>> {
    let mut path = std::path::PathBuf::new();
    for item in s {
        path.push(item);
    }
    text(p, &path.to_string_lossy())
}
fn cc_path(p: L<'_>) -> Result<L<'_>> {
    let file = p.get(c"ccDefault")?;
    if !Path::new(&word(file)?).exists() && cfg!(windows) {
        let home = p.get(c"environment")?.get(c"HOME")?;
        if home.truthy()? {
            let legacy = join(p, &[&word(home)?, ".cc-switch", "cc-switch.db"])?;
            if Path::new(&word(legacy)?).exists() {
                return Ok(legacy);
            }
        }
    }
    Ok(file)
}
fn repo(p: L<'_>) -> Result<L<'_>> {
    let mut store = p.get(c"repository")?;
    if !store.truthy()? {
        store = raw(
            p,
            crate::provider_host::provider_repository(
                env(p),
                arg(p.get(c"paths")?.get(c"providersFile")?)?,
                arg(und(p)?)?,
            )?,
        );
        p.set(c"repository", store)?;
    }
    Ok(store)
}
fn current_port(p: L<'_>) -> Result<L<'_>> {
    fallback(p.get(c"environment")?.get(c"PORT")?, "3000".into())
}
fn forced(p: L<'_>) -> Result<bool> {
    p.get(c"environment")?
        .get(c"MULTICC_CLI_RELAY_FORCE")?
        .is_string("1")
}
fn credential(v: L<'_>) -> Result<L<'_>> {
    Ok(raw(v, provider_credential_value(env(v), arg(v)?)?))
}
fn getter<'a>(obj: L<'a>, key: &str, access: L<'a>) -> Result<()> {
    call(
        obj.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            obj,
            text(obj, key)?,
            fields(obj, &[("get", access), ("enumerable", flag(obj, true)?)])?,
        ],
    )?;
    Ok(())
}
fn enable(p: L<'_>) -> Result<L<'_>> {
    if p.get(c"catalog")?.truthy()? {
        return und(p);
    }
    let paths = p.get(c"paths")?;
    let file = join(
        p,
        &[
            &word(paths.get(c"root")?)?,
            "official-provider-selection.json",
        ],
    )?;
    if !Path::new(&word(file)?).exists() {
        let defaults = call(
            p.get(c"defaults")?,
            c"getProviderDefaultsOwner",
            &[paths.get(c"providerDefaultsFile")?],
        )?;
        call(defaults, c"assertReadable", &[])?;
        let snapshot = call(defaults, c"snapshot", &[])?;
        let records = call(repo(p)?, c"read", &[])?;
        let selection = raw(
            p,
            service::provider_initial_selection(env(p), arg(records)?, arg(snapshot)?)?,
        );
        credential(fields(
            p,
            &[
                ("operation", text(p, "writeJson")?),
                ("file", file),
                ("data", selection),
            ],
        )?)?;
    }
    let acc = call(p.get(c"accounts")?, c"createOfficialAccountStore", &[])?;
    let operations = fields(
        p,
        &[
            (
                "readRecords",
                function(p, "readRecords", 0, 0, |p, _| call(repo(p)?, c"read", &[]))?,
            ),
            (
                "readSelection",
                function(file, "readSelection", 0, 0, |file, _| {
                    let v = credential(fields(
                        file,
                        &[("operation", text(file, "readStateJson")?), ("file", file)],
                    )?)?;
                    if v.truthy()? {
                        Ok(v)
                    } else {
                        fields(file, &[])
                    }
                })?,
            ),
            (
                "writeSelection",
                function(file, "writeSelection", 1, 1, |file, a| {
                    credential(fields(
                        file,
                        &[
                            ("operation", text(file, "writeJson")?),
                            ("file", file),
                            ("data", a[0]),
                        ],
                    )?)
                })?,
            ),
            (
                "listAccounts",
                function(acc, "listAccounts", 1, 1, |acc, a| {
                    call(
                        acc,
                        if a[0].is_string("codex")? {
                            c"listCodexAccounts"
                        } else {
                            c"listClaudeAccounts"
                        },
                        &[],
                    )
                })?,
            ),
            (
                "deleteAccount",
                function(acc, "deleteAccount", 2, 2, |acc, a| {
                    call(
                        acc,
                        if a[0].is_string("codex")? {
                            c"deleteCodexAccount"
                        } else {
                            c"deleteClaudeAccount"
                        },
                        &[a[1]],
                    )
                })?,
            ),
        ],
    )?;
    p.set(
        c"catalog",
        call(p.get(c"official")?, c"createOfficialCatalog", &[operations])?,
    )?;
    und(p)
}
fn owner(p: L<'_>) -> Result<L<'_>> {
    let user = word(p.get(c"home")?)?;
    let global = join(p, &[&user, ".codex"])?;
    let mut homes = Vec::new();
    for dir in [
        "codex-homes",
        "codex-attempt-homes",
        "codex-session-homes",
        "zcode-homes",
        "kimi-homes",
        "grok-homes",
    ] {
        homes.push(join(p, &[&user, ".multicc", dir])?);
    }
    let vendor = fields(
        p,
        &[("zcode", homes[3]), ("kimi", homes[4]), ("grok", homes[5])],
    )?;
    let session = call(
        p.get(c"sessionHomeApi")?,
        c"createCodexSessionHomeRuntime",
        &[fields(
            p,
            &[("sessionHomesDir", homes[2]), ("codexHomesDir", homes[0])],
        )?],
    )?;
    p.set(c"session", session)?;
    p.set(
        c"ccDefault",
        join(p, &[&user, ".cc-switch", "cc-switch.db"])?,
    )?;
    p.set(
        c"sqlite",
        raw(
            p,
            crate::cc_switch::cc_switch_database_api(
                env(p),
                arg(fields(p, &[("existsSync", p.get(c"exists")?)])?)?,
            )?,
        ),
    )?;
    p.set(c"codexGlobal", global)?;
    p.set(c"vendorRoots", vendor)?;
    p.set(c"catalog", null(p)?)?;
    let svc = fields(
        p,
        &[
            ("uuid", p.get(c"uuid")?),
            (
                "getPort",
                function(p, "getPort", 0, 0, |p, _| current_port(p))?,
            ),
            (
                "relayForced",
                function(p, "relayForced", 0, 0, |p, _| flag(p, forced(p)?))?,
            ),
            (
                "accountModels",
                function(p, "accountModels", 2, 2, |p, a| {
                    let runtime = if a[1].truthy()? {
                        a[1]
                    } else {
                        port(p, c"defaultModels", &[])?
                    };
                    let models = call(runtime, c"peekProvider", &[a[0]])?.get(c"models")?;
                    let project = function(p, "", 1, 1, |_, a| a[0].get(c"model"))?;
                    call(models, c"map", &[project])
                })?,
            ),
            ("ccPath", function(p, "ccPath", 0, 0, |p, _| cc_path(p))?),
            ("vendorRoots", vendor),
            ("modelLimits", p.get(c"modelLimits")?),
            ("codexHomes", homes[0]),
            ("codexGlobal", global),
            (
                "logModels",
                function(p, "logModels", 2, 2, |p, a| {
                    probe::log_models(p, a[0], a[1])
                })?,
            ),
            ("sdk", p.get(c"sdk")?),
            ("leases", p.global()?.get(c"WeakMap")?.construct(&[])?),
            ("attemptsDir", homes[1]),
            ("prepareHome", session.get(c"prepareCodexSessionHome")?),
            ("attemptHome", p.get(c"attemptHome")?),
        ],
    )?;
    getter(svc, "store", function(p, "", 0, 0, |p, _| repo(p))?)?;
    getter(
        svc,
        "catalog",
        function(p, "", 0, 0, |p, _| p.get(c"catalog"))?,
    )?;
    let registry = raw(p, service::provider_registry_service(env(p), arg(svc)?)?);
    svc.set(c"routeView", registry.get(c"routingProviderView")?)?;
    svc.set(c"providerLookup", registry.get(c"getProvider")?)?;
    p.set(c"registry", registry)?;
    let api = fields(p, &[])?;
    for (i, key) in [
        c"CODEX_HOMES_DIR",
        c"CODEX_ATTEMPT_HOMES_DIR",
        c"CODEX_SESSION_HOMES_DIR",
        c"ZCODE_HOMES_DIR",
        c"KIMI_HOMES_DIR",
        c"GROK_HOMES_DIR",
    ]
    .iter()
    .enumerate()
    {
        api.set(key, homes[i])?;
    }
    for key in [
        c"applyClaudeProxyEnv",
        c"applyCodexProxyConfig",
        c"applyCodexLeaseEnv",
        c"releaseCodexProxyConfig",
        c"listProviders",
        c"getProvider",
        c"routingProviderView",
        c"createProvider",
        c"updateProvider",
        c"updateProviderRelayModelCatalog",
        c"deleteProvider",
        c"importFromCcSwitch",
        c"migrateLegacyProviderProtocols",
        c"summarize",
        c"hasCliRelayProvider",
    ] {
        api.set(key, registry.get(key)?)?;
    }
    for key in [c"prepareResidentChildEnv", c"releaseResidentRoute"] {
        api.set(key, p.get(c"resident")?.get(key)?)?;
    }
    for key in [
        c"codexSessionHome",
        c"prepareCodexSessionHome",
        c"synchronizeCodexSessionRoute",
    ] {
        api.set(key, session.get(key)?)?;
    }
    api.set(
        c"materializeCodexRoutingHome",
        p.get(c"sdk")?.get(c"materializeCodexRoutingHome")?,
    )?;
    api.set(
        c"isOfficialCodexOAuthProvider",
        p.get(c"relay")?.get(c"isOfficialCodexOAuthProvider")?,
    )?;
    api.set(
        c"assertCodexProxyConfigApplied",
        p.get(c"codexHome")?.get(c"assertProxyConfigApplied")?,
    )?;
    let keys = strings(p, service::provider_anthropic_routing_keys())?;
    let all = call(keys, c"slice", &[])?;
    call(all, c"push", &[text(p, "CLAUDE_CODE_SIMPLE")?])?;
    p.set(c"claudeKeys", all)?;
    api.set(c"ANTHROPIC_ROUTING_KEYS", keys)?;
    api.set(c"CLAUDE_ROUTING_KEYS", all)?;
    api.set(c"APP_TYPES", strings(p, ["claude", "codex"])?)?;
    api.set(
        c"API_FORMATS",
        fields(
            p,
            &[
                ("ANTHROPIC", text(p, "anthropic")?),
                ("OPENAI_RESPONSES", text(p, "openai_responses")?),
            ],
        )?
        .freeze()?,
    )?;
    api.set(c"CODEX_OFFICIAL_MODELS_FALLBACK", array(p)?.freeze()?)?;
    api.set(
        c"WIRE_DEFAULT_MODEL",
        fallback(
            p.get(c"environment")?.get(c"CLAUDE_WIRE_DEFAULT_MODEL")?,
            "claude-sonnet-4-5".into(),
        )?,
    )?;
    facade::install(p, api)?;
    probe::install(p, api)?;
    let ordered = fields(p, &[])?;
    for key in [
        c"enableUnifiedOfficialProviders",
        c"normalizeOfficialProviderId",
        c"isOfficialProviderId",
        c"getOfficialAccountSelection",
        c"selectOfficialAccount",
        c"ccSwitchAvailable",
        c"getCcSwitchStatus",
        c"appTypeForCli",
        c"appTypesForCli",
        c"providerSupportsCli",
        c"normalizeApiFormat",
        c"compatibleClisForFormat",
        c"API_FORMATS",
        c"APP_TYPES",
        c"listProviders",
        c"getProvider",
        c"routingProviderView",
        c"getProviderSummary",
        c"getProviderLimitTarget",
        c"resolveAuxHttpTarget",
        c"resolveCodexDirectHttp",
        c"createProvider",
        c"updateProvider",
        c"applyProviderRelayModelCatalog",
        c"updateProviderRelayModelCatalog",
        c"deleteProvider",
        c"importFromCcSwitch",
        c"migrateLegacyProviderProtocols",
        c"resolveSpawnEnv",
        c"buildChildEnv",
        c"materializeCodexAuth",
        c"applyClaudeProxyEnv",
        c"assertClaudeProxyEnvApplied",
        c"claudeProxyEnvRequired",
        c"applyCodexProxyConfig",
        c"applyCodexLeaseEnv",
        c"assertCodexProxyConfigApplied",
        c"codexProxyConfigRequired",
        c"releaseCodexProxyConfig",
        c"prepareResidentChildEnv",
        c"releaseResidentRoute",
        c"materializeCodexRoutingHome",
        c"codexProviderProxyable",
        c"isOfficialCodexOAuthProvider",
        c"codexSessionHome",
        c"prepareCodexSessionHome",
        c"synchronizeCodexSessionRoute",
        c"resolveSessionWireModel",
        c"modelValidForProvider",
        c"readCodexOfficialModels",
        c"CODEX_OFFICIAL_MODELS_FALLBACK",
        c"summarize",
        c"getRelayImportToken",
        c"resolveCliRelayTarget",
        c"hasCliRelayProvider",
        c"getProviderUsageStats",
        c"readDailyWindows",
        c"CLAUDE_ROUTING_KEYS",
        c"ANTHROPIC_ROUTING_KEYS",
        c"CODEX_HOMES_DIR",
        c"CODEX_ATTEMPT_HOMES_DIR",
        c"CODEX_SESSION_HOMES_DIR",
        c"ZCODE_HOMES_DIR",
        c"KIMI_HOMES_DIR",
        c"GROK_HOMES_DIR",
        c"zcodeSessionHome",
        c"kimiSessionHome",
        c"grokSessionHome",
        c"buildKimiCodeRoute",
        c"buildDshRoute",
        c"buildGrokRoute",
        c"WIRE_DEFAULT_MODEL",
        c"probeRelayModels",
        c"claudeProbeRouteEnv",
    ] {
        ordered.set(key, api.get(key)?)?;
    }
    ordered.spread_from(p.get(c"settings")?)?;
    Ok(ordered)
}
#[napi]
pub fn providers_host_api(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(owner(L::new(&e, ports))?.raw())
}
