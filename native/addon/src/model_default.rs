//! 默认模型的宿主边界：只读约定字段，回调/转换一律在原生锁外执行。
use crate::js_live::LiveValue;
use multicc_core::{
    js::JsValue,
    model_default::{History, Kind, ProviderInfo, Request, Store},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::sync::Mutex;

fn text(value: LiveValue<'_>) -> Result<Option<String>> {
    // 保持旧 JSON lenient 边界的孤立 UTF-16 → U+FFFD 及 Rust trim 语义。
    // 不经过序列化，也不读取对象的 toJSON/无关字段。
    Ok(value
        .string()?
        .map(|s| s.to_string_lossy().trim().to_owned())
        .filter(|s| !s.is_empty()))
}
fn object(value: LiveValue<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_object && !value.is_array()?)
}
fn list(value: LiveValue<'_>) -> Result<Vec<String>> {
    let mut result = Vec::new();
    if value.is_array()? {
        for i in 0..value.get(c"length")?.number()? as u32 {
            if let Some(model) = text(value.element(i)?)? {
                if !result.contains(&model) {
                    result.push(model);
                }
            }
        }
    }
    Ok(result)
}
fn request(value: LiveValue<'_>) -> Result<Request> {
    if !object(value)? {
        return Err(napi::Error::from_reason(
            "MODEL_DEFAULT_INVALID: request must be an object",
        ));
    }
    let kind = match text(value.get(c"kind")?)?.as_deref().unwrap_or("effective") {
        "effective" => Kind::Effective,
        "providerDefault" => Kind::ProviderDefault,
        other => {
            return Err(napi::Error::from_reason(format!(
                "MODEL_DEFAULT_INVALID: unknown kind {other}"
            )))
        }
    };
    let provider_id = text(value.get(c"providerId")?)?;
    let scope = value.get(c"historyProviderId")?;
    let history_provider_id = if scope.undefined()? {
        provider_id.clone()
    } else {
        text(scope)?
    };
    let provider = value.get(c"provider")?;
    let provider = if object(provider)? {
        Some(ProviderInfo {
            model: text(provider.get(c"model")?)?,
            options: list(provider.get(c"modelOptions")?)?,
            alias_only: provider.get(c"aliasOnly")?.is_true()?,
            official: provider.get(c"official")?.is_true()?,
        })
    } else {
        None
    };
    Ok(Request {
        kind,
        cli: text(value.get(c"cli")?)?.unwrap_or_default(),
        app_type: text(value.get(c"appType")?)?,
        provider_id,
        history_provider_id,
        provider,
        models: list(value.get(c"models")?)?,
        reported_model: text(value.get(c"reportedModel")?)?,
        global_provider_cli: value.get(c"globalProviderCli")?.is_true()?,
        wire_default_model: text(value.get(c"wireDefaultModel")?)?,
    })
}
fn history(value: LiveValue<'_>) -> Result<Vec<History>> {
    let mut result = Vec::new();
    if value.is_array()? {
        for i in 0..value.get(c"length")?.number()? as u32 {
            let item = value.element(i)?;
            if !object(item)? {
                continue;
            }
            let Some(cli) = text(item.get(c"cli")?)? else {
                continue;
            };
            let Some(model) = text(item.get(c"model")?)? else {
                continue;
            };
            result.push(History {
                cli,
                model,
                provider: text(item.get(c"provider")?)?,
            });
        }
    }
    Ok(result)
}

#[napi]
pub struct RustModelDefaults {
    inner: Mutex<Store>,
}

#[napi]
impl RustModelDefaults {
    #[napi(constructor)]
    pub fn new(env: Env, ttl_ms: Unknown<'_>) -> Result<Self> {
        let ttl = LiveValue::new(&env, ttl_ms)
            .number_value()?
            .unwrap_or(f64::NAN);
        Ok(Self {
            inner: Mutex::new(Store::new(ttl)),
        })
    }

    #[napi]
    pub fn resolve(
        &self,
        env: Env,
        input: Unknown<'_>,
        read_history: Unknown<'_>,
        clock: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let anchor = LiveValue::new(&env, input);
        let input = request(anchor)?;
        let clock = LiveValue::new(&env, clock);
        let caching = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .caching();
        let now = if caching {
            clock.call_plain(&[])?.number()?
        } else {
            f64::NAN
        };
        let token = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refresh_token(now);
        if let Some(token) = token {
            let entries = history(LiveValue::new(&env, read_history).call_plain(&[])?)?;
            let at = clock.call_plain(&[])?.number()?;
            self.inner
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .publish(token, entries, at);
        }
        let model = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resolve(input);
        Ok(anchor
            .from_value(
                &model
                    .as_deref()
                    .map(JsValue::string)
                    .unwrap_or(JsValue::Null),
            )?
            .raw())
    }
}
