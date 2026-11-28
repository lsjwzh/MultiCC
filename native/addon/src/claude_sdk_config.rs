//! Configuration identity excludes the live model and rotating local relay credentials.
//! V8 serializes the original option values to preserve JSON key order and omission rules.
use crate::{host_methods::function, js_live::spread, route_response::*};
use napi_derive::napi;

#[napi]
pub fn claude_sdk_fingerprint(
    env: Env,
    cfg: Unknown<'_>,
    route: Unknown<'_>,
    settings: Unknown<'_>,
) -> Result<String> {
    let cfg = L::new(&env, cfg);
    let route = L::new(&env, route);
    let settings = L::new(&env, settings);
    let options = spread(cfg.get(c"sdkOptions")?)?;
    options.delete(c"model")?;
    let vars = spread(settings.get(c"env")?)?;
    vars.spread_from(cfg.get(c"env")?)?;
    let keys = call(cfg.global()?.get(c"Object")?, c"keys", &[vars])?;
    call(keys, c"sort", &[])?;
    let stable = fields(cfg, &[])?;
    keys.for_each(|key| {
        let k = key.coerce_string()?.to_string_lossy();
        if (k.starts_with("ANTHROPIC_")
            || k.starts_with("CLAUDE_CODE_")
            || k.starts_with("CLAUDE_CONFIG_DIR")
            || k == "HOME")
            && !(route.truthy()?
                && matches!(
                    k.as_str(),
                    "ANTHROPIC_BASE_URL" | "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"
                ))
        {
            stable.define_key(key, vars.get_key(key)?)?;
        }
        Ok(())
    })?;
    settings.delete(c"env")?;
    let body = fields(
        cfg,
        &[
            ("cwd", cfg.get(c"cwd")?),
            ("sessionId", cfg.get(c"sessionId")?),
            ("route", route.optional(c"identity")?),
            ("env", stable),
            ("options", options),
            ("settings", settings),
        ],
    )?;
    let json = call(cfg.global()?.get(c"JSON")?, c"stringify", &[body])?
        .coerce_string()?
        .to_string_lossy();
    Ok(multicc_core::claude_lane::sdk_config_hash(&json))
}

#[napi]
pub fn claude_sdk_lane_options(
    env: Env,
    cfg: Unknown<'_>,
    started: bool,
    relay: Unknown<'_>,
    settings: Unknown<'_>,
    temp: Unknown<'_>,
) -> Result<sys::napi_value> {
    let cfg = L::new(&env, cfg);
    let temp = L::new(&env, temp);
    let input = cfg.get(c"sdkOptions")?;
    let vars = spread(cfg.get(c"env")?)?;
    vars.spread_from(L::new(&env, relay))?;
    let config = fields(
        cfg,
        &[
            ("cwd", cfg.get(c"cwd")?),
            ("env", vars),
            ("settings", L::new(&env, settings)),
            ("settingsPath", temp.get(c"path")?),
            ("includePartialMessages", flag(cfg, true)?),
            ("permissionMode", text(cfg, "bypassPermissions")?),
            ("allowDangerouslySkipPermissions", flag(cfg, true)?),
            ("sessionId", cfg.get(c"sessionId")?),
            (
                "hookCallback",
                flag(cfg, cfg.get(c"onBackgroundEvent")?.truthy()?)?,
            ),
        ],
    )?;
    if started {
        config.set(c"resume", flag(cfg, true)?)?;
    }
    for key in [c"model", c"effort", c"agent", c"maxTurns"] {
        let value = input.get(key)?;
        if value.truthy()? {
            config.set(key, value)?;
        }
    }
    let timeout = cfg.get(c"initializeTimeoutMs")?;
    if timeout.number_value()?.is_some_and(f64::is_finite) {
        config.set(c"initializeTimeoutMs", timeout)?;
    }
    if input.get(c"systemPrompt")?.truthy()? {
        config.set(c"systemPromptAppend", input.get(c"systemPrompt")?)?;
    }
    if input
        .get(c"disallowedTools")?
        .optional(c"length")?
        .truthy()?
    {
        config.set(c"disallowedTools", input.get(c"disallowedTools")?)?;
    }
    if input.get(c"routerNode")?.truthy()? && input.get(c"routerScript")?.truthy()? {
        let args = cfg.global()?.get(c"Array")?.construct(&[])?;
        args.set_element(0, input.get(c"routerScript")?)?;
        let server = fields(
            cfg,
            &[("command", input.get(c"routerNode")?), ("args", args)],
        )?;
        config.set(c"mcpServers", fields(cfg, &[("multicc_router", server)])?)?;
    }
    Ok(fields(
        cfg,
        &[
            ("config", config),
            (
                "dispose",
                function(temp, "dispose", 0, 0, |p, _| call(p, c"dispose", &[]))?,
            ),
        ],
    )?
    .raw())
}
