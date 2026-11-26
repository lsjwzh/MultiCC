//! Preserve live environment values (including undefined and symbols) at the Node spawn port.
use crate::route_response::*;
use multicc_core::codex_provider_home::official_env_key;

pub(super) const ROUTING: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
];
pub(super) fn child<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let [base, session, extra] = [args[0], args[1], args[2]];
    let env = fields(p, &[])?;
    env.spread_from(base)?;
    let lane = session.optional(c"cli")?;
    let claude = lane.is_string("claude")? || lane.is_string("claude-exp")?;
    let reflect = p.global()?.get(c"Reflect")?;
    if claude || (lane.is_string("zcode")? && session.get(c"provider")?.truthy()?) {
        for key in ROUTING.iter().copied().chain(["CLAUDE_CODE_SIMPLE"]) {
            call(reflect, c"deleteProperty", &[env, text(p, key)?])?;
        }
    }
    if lane.is_string("opencode")? {
        env.delete(c"OPENCODE_CONFIG_CONTENT")?;
    }
    let plan = super::registry::spawn_plan(p, session)?;
    let object = p.global()?.get(c"Object")?;
    call(object, c"assign", &[env, extra, plan.get(c"env")?])?;
    if claude && env.get(c"CLAUDE_CODE_MAX_RETRIES")?.undefined()? {
        env.set(c"CLAUDE_CODE_MAX_RETRIES", text(p, "3")?)?;
    }
    if plan.get(c"codexOfficialRelay")?.truthy()? {
        strip_official(env)?;
    }
    let result = fields(p, &[("env", env)])?;
    for key in [
        "skipDefaultModel",
        "aliasOnly",
        "providerModel",
        "providerModels",
        "qualifiedModel",
        "providerName",
        "codexHome",
        "zcodeHome",
        "kimiHome",
        "tools",
    ] {
        let key = text(p, key)?;
        let mut v = plan.get_key(key)?;
        if key.is_string("qualifiedModel")? && !v.truthy()? {
            v = null(p)?
        }
        result.define_key(key, v)?;
    }
    Ok(result)
}

pub(super) fn strip_official(env: L<'_>) -> Result<()> {
    let object = env.global()?.get(c"Object")?;
    let reflect = env.global()?.get(c"Reflect")?;
    let keys = call(object, c"keys", &[env])?;
    for i in 0..keys.get(c"length")?.number()? as u32 {
        let key = keys.element(i)?;
        if official_env_key(&key.coerce_string()?.to_string_lossy()) {
            call(reflect, c"deleteProperty", &[env, key])?;
        }
    }
    Ok(())
}
