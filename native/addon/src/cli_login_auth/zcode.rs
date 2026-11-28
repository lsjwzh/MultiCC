use super::*;

const MESSAGE:&str = "ZCode 原生连接尚未配置。请选择一个 MultiCC Provider，或在 Provider 设置中完成 ZCode Coding Plan 登录 / API Key 配置。";

fn load<'a>(p: L<'a>, path: &CStr) -> Result<L<'a>> {
    let Ok(bytes) = fs::read(filename(p.get(path)?)?) else {
        return null(p);
    };
    Ok(
        p.catch(|| json_call(p, c"parse", text(p, &String::from_utf8_lossy(&bytes))?))?
            .unwrap_or(null(p)?),
    )
}
fn write<'a>(p: L<'a>, file: L<'a>, v: L<'a>) -> Result<()> {
    let body = call(
        p.global()?.get(c"JSON")?,
        c"stringify",
        &[v, null(p)?, num(p, 2.)?],
    )?;
    crate::runtime_security::atomic(
        p,
        file,
        &fold_string(body)?,
        0o600,
        0o700,
        p.get(c"reportFailure")?,
    )
}
fn urls(p: L<'_>) -> Result<L<'_>> {
    p.get(c"PROVIDER_BASE_URLS")
}
fn models(p: L<'_>) -> Result<L<'_>> {
    p.get(c"PROVIDER_MODELS")
}
fn detect(p: L<'_>) -> Result<L<'_>> {
    let cfg = load(p, c"DESKTOP_CONFIG_PATH")?;
    let out = fields(p, &[])?;
    let providers = cfg.optional(c"provider")?;
    if !providers.truthy()? {
        return Ok(out);
    }
    for (key, id) in [(c"builtin:zai", c"zai"), (c"builtin:bigmodel", c"bigmodel")] {
        let opts = providers.get(key)?.optional(c"options")?;
        if !opts.truthy()? {
            continue;
        }
        let api_key = trimmed(opts.get(c"apiKey")?)?;
        if !api_key.truthy()? {
            continue;
        }
        let url = opts.get(c"baseURL")?;
        let base = trimmed(if url.truthy()? {
            url
        } else {
            urls(p)?.get(id)?
        })?;
        out.set(id, fields(p, &[("apiKey", api_key), ("baseURL", base)])?)?;
    }
    Ok(out)
}
fn config<'a>(p: L<'a>, id: L<'a>, key: L<'a>, url: L<'a>) -> Result<L<'a>> {
    let prior = load(p, c"CLI_CONFIG_PATH")?.optional(c"model")?;
    let prefix = call(string(id)?, c"concat", &[text(p, "/")?])?;
    let model = if prior.truthy()? && call(prior, c"startsWith", &[prefix])?.truthy()? {
        prior
    } else {
        call(prefix, c"concat", &[text(p, "glm-5.2")?])?
    };
    let mut allowed = models(p)?.get_key(id)?;
    if !allowed.truthy()? {
        allowed = fields(
            p,
            &[("glm-5.2", fields(p, &[("id", text(p, "glm-5.2")?)])?)],
        )?;
    }
    let opts = fields(p, &[("baseURL", url), ("apiKey", key)])?;
    let record = fields(
        p,
        &[
            ("kind", text(p, "anthropic")?),
            ("options", opts),
            ("models", allowed),
        ],
    )?;
    let provider = fields(p, &[])?;
    provider.define_key(id, record)?;
    fields(p, &[("model", model), ("provider", provider)])
}
fn write_config<'a>(p: L<'a>, value: L<'a>) -> Result<()> {
    let file = p.get(c"CLI_CONFIG_PATH")?;
    let dir = call(p.get(c"path")?, c"dirname", &[file])?;
    if !filename(dir)?.exists() {
        mkdir(p, dir, true)?;
    }
    write(p, file, value)
}
fn rules(p: L<'_>) -> Result<L<'_>> {
    let r = p
        .optional(c"config")?
        .optional(c"providerConfigRules")?
        .optional(c"providerRules")?;
    if r.is_array()? {
        Ok(r)
    } else {
        array(p)
    }
}
fn personal(p: L<'_>) -> Result<L<'_>> {
    let cfg = load(p, c"PERSONAL_PROVIDER_CONFIG_PATH")?;
    let mut found = null(p)?;
    rules(cfg)?.for_each_while(|r| {
        let cfg = r.optional(c"config")?;
        if !cfg.truthy()? || r.get(c"enabled")?.is_false()? {
            return Ok(true);
        }
        let access = cfg.get(c"access")?;
        let key = access.optional(c"apiKey")?;
        if !(key.string()?.is_some() && trimmed(key)?.truthy()?)
            && !access.optional(c"type")?.is_string("zhipu-account")?
        {
            return Ok(true);
        }
        let api = cfg.get(c"api")?;
        found = fields(
            p,
            &[
                ("configured", flag(p, true)?),
                ("provider", r.get(c"providerId")?),
                ("hasKey", flag(p, true)?),
                ("source", text(p, "provider_config")?),
                ("kind", fallback(api.optional(c"type")?, V::Null)?),
                ("baseURL", fallback(api.optional(c"baseUrl")?, "".into())?),
                ("model", null(p)?),
            ],
        )?;
        Ok(false)
    })?;
    Ok(found)
}
fn write_personal<'a>(p: L<'a>, id: L<'a>, key: L<'a>, url: L<'a>) -> Result<()> {
    let old = load(p, c"PERSONAL_PROVIDER_CONFIG_PATH")?;
    let base = if object(old)? && old.optional(c"config")?.truthy()? {
        spread(old)?
    } else {
        json_call(
            p,
            c"parse",
            text(
                p,
                r#"{"schemaVersion":1,"config":{"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}"#,
            )?,
        )?
    };
    let template = if id.is_string("zai")? {
        text(p, "zai-api")?
    } else {
        text(p, "bigmodel-api")?
    };
    let access = fields(p, &[("type", text(p, "api-key")?), ("apiKey", key)])?;
    let cfg = fields(
        p,
        &[("group", text(p, "standard-personal")?), ("access", access)],
    )?;
    if url.truthy()? && !url.equals(urls(p)?.get_key(id)?)? {
        cfg.set(
            c"api",
            fields(
                p,
                &[("type", text(p, "anthropic-messages")?), ("baseUrl", url)],
            )?,
        )?;
    }
    let all = array(p)?;
    all.set_element(
        0,
        fields(
            p,
            &[
                ("providerId", template),
                ("templateId", template),
                ("config", cfg),
            ],
        )?,
    )?;
    rules(base)?.for_each(|item| {
        if item.truthy()? && !item.get(c"providerId")?.equals(template)? {
            call(all, c"push", &[item])?;
        }
        Ok(())
    })?;
    let config = spread(base.get(c"config")?)?;
    let ruleconf = spread(config.get(c"providerConfigRules")?)?;
    ruleconf.set(c"providerRules", all)?;
    config.set(c"providerConfigRules", ruleconf)?;
    base.set(c"config", config)?;
    let file = p.get(c"PERSONAL_PROVIDER_CONFIG_PATH")?;
    mkdir(p, call(p.get(c"path")?, c"dirname", &[file])?, true)?;
    write(p, file, base)
}
fn sync<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let detected = detect(p)?;
    let id = keys(detected)?.element(0)?;
    if id.undefined()? {
        return fields(
            p,
            &[
                ("synced", flag(p, false)?),
                ("reason", text(p, "no_desktop_key")?),
            ],
        );
    }
    let v = detected.get_key(id)?;
    write_config(p, config(p, id, v.get(c"apiKey")?, v.get(c"baseURL")?)?)?;
    fields(
        p,
        &[
            ("synced", flag(p, true)?),
            ("provider", id),
            ("hadKey", flag(p, true)?),
        ],
    )
}
fn none<'a>(p: L<'a>, source: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("configured", flag(p, false)?),
            ("provider", null(p)?),
            ("hasKey", flag(p, false)?),
            ("source", text(p, source)?),
        ],
    )
}
fn status(p: L<'_>) -> Result<L<'_>> {
    let cfg = load(p, c"CLI_CONFIG_PATH")?;
    let providers = cfg.optional(c"provider")?;
    if !providers.truthy()? {
        let v = personal(p)?;
        return if v.truthy()? { Ok(v) } else { none(p, "none") };
    }
    let model = cfg.get(c"model")?;
    let ids = keys(providers)?;
    if model.string()?.is_some() {
        let index = call(model, c"indexOf", &[text(p, "/")?])?.number()?;
        if index > 0. {
            call(
                ids,
                c"unshift",
                &[call(model, c"slice", &[num(p, 0.)?, num(p, index)?])?],
            )?;
        }
    }
    let seen = p.global()?.get(c"Set")?.construct(&[])?;
    let mut result = null(p)?;
    ids.for_each_while(|id| {
        if !id.truthy()? || call(seen, c"has", &[id])?.truthy()? {
            return Ok(true);
        }
        call(seen, c"add", &[id])?;
        let provider = providers.get_key(id)?;
        let opts = provider.optional(c"options")?;
        if !opts.truthy()? || !trimmed(opts.get(c"apiKey")?)?.truthy()? {
            return Ok(true);
        }
        let base = opts.get(c"baseURL")?;
        result = fields(
            p,
            &[
                ("configured", flag(p, true)?),
                ("provider", id),
                ("hasKey", flag(p, true)?),
                ("source", text(p, "cli_config")?),
                ("kind", fallback(provider.get(c"kind")?, V::Null)?),
                (
                    "baseURL",
                    if base.truthy()? {
                        base
                    } else {
                        nonempty(p, urls(p)?.get_key(id)?)?
                    },
                ),
                ("model", fallback(model, V::Null)?),
            ],
        )?;
        Ok(false)
    })?;
    if result.truthy()? {
        return Ok(result);
    }
    let personal = personal(p)?;
    if personal.truthy()? {
        return Ok(personal);
    }
    let id = keys(detect(p)?)?.element(0)?;
    if id.undefined()? {
        return none(p, "none");
    }
    let result = none(p, "desktop_available")?;
    result.set(c"desktopProvider", id)?;
    Ok(result)
}
fn set_key<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = a[0];
    let default = urls(p)?.get_key(string(id)?)?;
    if !default.truthy()? {
        return Err(error_value(p, r#"providerId must be "zai" or "bigmodel""#)?.throw_error());
    }
    let key = trimmed(a[1])?;
    if !key.truthy()? {
        return Err(error_value(p, "apiKey is required")?.throw_error());
    }
    let url = default_object(a[2])?.get(c"baseURL")?;
    write_config(
        p,
        config(p, id, key, if url.truthy()? { url } else { default })?,
    )?;
    write_personal(p, id, key, url)?;
    fields(p, &[("ok", flag(p, true)?), ("provider", id)])
}
fn engine(p: L<'_>) -> Result<L<'_>> {
    fallback(
        process_env(p)?.get(c"ZCODE_ENGINE")?,
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs".into(),
    )
}
fn available(p: L<'_>) -> Result<L<'_>> {
    let fs = p.get(c"fs")?;
    flag(
        p,
        p.catch(|| {
            call(
                fs,
                c"accessSync",
                &[engine(p)?, fs.get(c"constants")?.get(c"R_OK")?],
            )
        })?
        .is_some(),
    )
}
fn spawn_login<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let cmd = engine(p)?;
    let e = spread(raw(
        p,
        crate::zcode_engine::zcode_engine_env(
            env(p),
            arg(cmd)?,
            arg(process_env(p)?)?,
            arg(p.get(c"path")?)?,
        )?,
    ))?;
    e.delete(c"ZCODE_DATA_BASE_DIR")?;
    e.delete(c"ZCODE_SETTINGS")?;
    let args = array(p)?;
    args.set_element(0, cmd)?;
    args.set_element(1, text(p, "login")?)?;
    let opts = fields(
        p,
        &[
            ("stdio", text(p, "ignore")?),
            ("env", e),
            ("detached", flag(p, false)?),
        ],
    )?;
    p.get(c"spawn")?
        .call_plain(&[p.get(c"process")?.get(c"execPath")?, args, opts])
}
fn ensure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = a[0].optional(c"provider")?;
    if id.truthy()? {
        return admitted(p, id, text(p, "multicc_provider")?);
    }
    let st = status(p)?;
    if st.get(c"configured")?.truthy()? {
        return admitted(p, st.get(c"provider")?, st.get(c"source")?);
    }
    denied(p, MESSAGE, ("desktopLoginAvailable", available(p)?))
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let owner = spread(p)?;
    let home = p.get(c"homedir")?.call_plain(&[])?;
    for (k, s) in [
        (c"DESKTOP_CONFIG_PATH", ".zcode/v2/config.json"),
        (c"CREDENTIALS_PATH", ".zcode/v2/credentials.json"),
        (c"CLI_CONFIG_PATH", ".zcode/cli/config.json"),
        (
            c"PERSONAL_PROVIDER_CONFIG_PATH",
            ".zcode/v2/provider_config.json",
        ),
    ] {
        owner.set(k, join(p, home, s)?)?;
    }
    owner.set(
        c"PROVIDER_BASE_URLS",
        fields(
            p,
            &[
                ("zai", text(p, "https://api.z.ai/api/anthropic")?),
                (
                    "bigmodel",
                    text(p, "https://open.bigmodel.cn/api/anthropic")?,
                ),
            ],
        )?,
    )?;
    let supported = fields(p, &[])?;
    for id in [c"zai", c"bigmodel"] {
        let list = fields(p, &[])?;
        for name in ["glm-5.3", "glm-5.2", "glm-5-turbo"] {
            list.define_key(text(p, name)?, fields(p, &[("id", text(p, name)?)])?)?;
        }
        supported.set(id, list)?;
    }
    owner.set(c"PROVIDER_MODELS", supported)?;
    let api = defaulted_methods(
        owner,
        &[
            ("detectDesktopApiKeys", 0, 0, |p, _| detect(p)),
            ("readCliConfig", 0, 0, |p, _| load(p, c"CLI_CONFIG_PATH")),
            ("writeCliConfig", 1, 1, |p, a| {
                write_config(p, a[0])?;
                undef(p)
            }),
            ("syncDesktopKeyToCli", 0, 0, sync),
            ("getZcodeAuthStatus", 0, 0, |p, _| status(p)),
            ("setZcodeApiKey", 2, 3, set_key),
            ("isZcodeLoginAvailable", 0, 0, |p, _| available(p)),
            ("spawnZcodeLogin", 0, 0, spawn_login),
            ("ensureZcodeAuth", 1, 1, ensure),
        ],
    )?;
    for k in [
        c"DESKTOP_CONFIG_PATH",
        c"CREDENTIALS_PATH",
        c"CLI_CONFIG_PATH",
        c"PERSONAL_PROVIDER_CONFIG_PATH",
        c"PROVIDER_BASE_URLS",
        c"PROVIDER_MODELS",
    ] {
        api.set(k, owner.get(k)?)?;
    }
    Ok(api)
}
