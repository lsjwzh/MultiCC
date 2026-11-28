use crate::{
    codex_adapter::{concat, or, push},
    host_api::*,
};

fn count(value: L<'_>) -> Result<L<'_>> {
    let n = value.explicit_number()?;
    num(
        value,
        if n.is_finite() && n > 0.0 {
            n.round()
        } else {
            0.0
        },
    )
}
pub(super) fn tokens(value: L<'_>) -> Result<L<'_>> {
    let u = if value.truthy()? && object(value)? {
        value
    } else {
        fields(value, &[])?
    };
    // Read and coerce one field at a time: coercion may throw or mutate the next.
    let input = count(u.get(c"inputTokens")?)?;
    let output = count(u.get(c"outputTokens")?)?;
    let read = count(u.get(c"cacheReadTokens")?)?;
    let write = count(u.get(c"cacheWriteTokens")?)?;
    fields(
        value,
        &[
            ("input", input),
            ("output", output),
            ("cache", fields(value, &[("read", read), ("write", write)])?),
        ],
    )
}
pub(super) fn runtime<'a>(config: L<'a>, model_ref: L<'a>) -> Result<L<'a>> {
    if !config.truthy()? || !object(config)? || config.is_array()? {
        return null(config);
    }
    let raw = if config.get(c"model")?.kind()? == sys::ValueType::napi_string
        && call(config.get(c"model")?, c"includes", &[text(config, "/")?])?.truthy()?
    {
        call(config.get(c"model")?, c"split", &[text(config, "/")?])?
    } else {
        null(config)?
    };
    let provider_id = or(
        if model_ref.truthy()? {
            model_ref.get(c"providerId")?
        } else {
            model_ref
        },
        || {
            if raw.truthy()? {
                raw.element(0)
            } else {
                Ok(raw)
            }
        },
    )?;
    let model_id = or(
        if model_ref.truthy()? {
            model_ref.get(c"modelId")?
        } else {
            model_ref
        },
        || {
            if raw.truthy()? {
                call(
                    call(raw, c"slice", &[num(config, 1.0)?])?,
                    c"join",
                    &[text(config, "/")?],
                )
            } else {
                Ok(raw)
            }
        },
    )?;
    if !provider_id.truthy()? || !model_id.truthy()? {
        return null(config);
    }
    let provider = if config.get(c"provider")?.truthy()? && object(config.get(c"provider")?)? {
        config.get(c"provider")?.get_key(provider_id)?
    } else {
        null(config)?
    };
    if !provider.truthy()? || !object(provider)? {
        return null(config);
    }
    let options = if provider.get(c"options")?.truthy()? && object(provider.get(c"options")?)? {
        provider.get(c"options")?
    } else {
        fields(config, &[])?
    };
    let declared = array(config)?;
    if provider.get(c"models")?.truthy()? && object(provider.get(c"models")?)? {
        call(
            config.global()?.get(c"Object")?,
            c"keys",
            &[provider.get(c"models")?],
        )?
        .for_each(|key| {
            if key.truthy()? {
                push(declared, &[key])?;
            }
            Ok(())
        })?;
    }
    let models = array(config)?;
    if declared.get(c"length")?.number()? > 0.0 {
        declared.for_each(|id| push(models, &[fields(config, &[("modelId", id)])?]))?;
    } else {
        push(models, &[fields(config, &[("modelId", model_id)])?])?;
    }
    // Preserve source evaluation order, including the live clock and getters.
    let revision = concat(config, &[text(config, "multicc-zcode-")?, model_id])?;
    let generated = call(config.global()?.get(c"Date")?, c"now", &[])?;
    let model = fields(
        config,
        &[("providerId", provider_id), ("modelId", model_id)],
    )?;
    let output = fields(
        config,
        &[
            ("providerId", provider_id),
            (
                "kind",
                fallback(provider.get(c"kind")?, "anthropic".into())?,
            ),
            ("source", text(config, "workspace")?),
        ],
    )?;
    if options.get(c"baseURL")?.truthy()? {
        output.set(c"baseURL", options.get(c"baseURL")?)?;
    }
    if options.get(c"apiKey")?.truthy()? {
        output.set(
            c"apiKey",
            fields(
                config,
                &[
                    ("source", text(config, "inline")?),
                    ("value", options.get(c"apiKey")?),
                ],
            )?,
        )?;
    }
    output.set(c"models", models)?;
    fields(
        config,
        &[
            ("revision", revision),
            ("generatedAt", generated),
            ("model", model),
            ("provider", output),
        ],
    )
}
