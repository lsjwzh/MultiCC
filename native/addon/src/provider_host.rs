use crate::{
    js_iteration::read,
    route_response::{fallback, fields, text, L, V},
};
use multicc_core::{
    account_subscription::{CODEX_USAGE_ORIGINATOR, CODEX_USAGE_URL},
    js::JsString,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
#[napi]
pub fn provider_store(file: String, input: String) -> Result<String> {
    multicc_core::provider_store::access(&file, &input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn provider_credential(input: String) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("CREDENTIAL_INVALID_REQUEST"))?;
    multicc_core::provider_credentials::run(&v)
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}

/// Build the quota request without serializing the live signal or the fetch result.
#[napi]
pub fn request_codex_usage(
    env: Env,
    auth: Unknown<'_>,
    fetch: Unknown<'_>,
    signal: Unknown<'_>,
) -> Result<sys::napi_value> {
    let auth = L::new(&env, auth);
    let token = read(auth, c"accessToken")?.coerce_string()?;
    let bearer = JsString::concat(&[&JsString::from("Bearer "), &token]);
    let headers = fields(
        auth,
        &[
            ("Authorization", auth.from_value(&V::String(bearer))?),
            (
                "ChatGPT-Account-Id",
                fallback(read(auth, c"accountId")?, "".into())?,
            ),
            ("originator", text(auth, CODEX_USAGE_ORIGINATOR)?),
            ("Accept", text(auth, "application/json")?),
        ],
    )?;
    let init = fields(
        auth,
        &[
            ("method", text(auth, "GET")?),
            ("headers", headers),
            ("signal", L::new(&env, signal)),
        ],
    )?;
    let fetch = L::new(&env, fetch);
    if fetch.kind()? != sys::ValueType::napi_function {
        return Err(fetch.type_error("fetch is not a function"));
    }
    Ok(fetch
        .call_plain(&[text(auth, CODEX_USAGE_URL)?, init])?
        .raw())
}

#[napi]
pub async fn read_provider_cli_credential(input: String) -> Result<String> {
    multicc_cpr::provider_host::read_cli(&input)
        .await
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}

#[napi]
pub async fn account_subscription_plan(input: String) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    multicc_cpr::provider_host::subscription_plan(v)
        .await
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}
#[napi]
pub fn account_subscription_result(input: String) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    Ok(multicc_cpr::provider_host::subscription_result(&v).to_string())
}
#[napi]
pub async fn query_account_subscription(input: String) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    Ok(multicc_cpr::provider_host::subscription_query(v)
        .await
        .to_string())
}

#[napi]
pub struct RustProviderRequest {
    inner: multicc_core::provider_request::Request,
}
#[napi]
impl RustProviderRequest {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Default::default(),
        }
    }
    #[napi]
    pub fn choose(&mut self, input: String) -> Result<String> {
        let v = multicc_core::json_lenient::from_str(&input)
            .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
        self.inner
            .choose(v)
            .map(|v| v.to_string())
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn outcome(&mut self, input: String) -> Result<String> {
        let v = multicc_core::json_lenient::from_str(&input)
            .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
        self.inner
            .outcome(v)
            .map(|v| v.to_string())
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn commit(&mut self) {
        self.inner.commit();
    }
    #[napi]
    pub fn cancel(&mut self) {
        self.inner.cancel();
    }
}
impl Default for RustProviderRequest {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
pub async fn authorize_provider_request(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let v = multicc_core::json_lenient::from_str(&input)
            .map_err(|_| "HOP_CREDENTIAL_INVALID_REQUEST".to_owned())?;
        multicc_core::provider_authorization::authorize(&v).map(|v| v.to_string())
    })
    .await
    .map_err(|_| napi::Error::from_reason("HOP_CREDENTIAL_READ_FAILED"))?
    .map_err(napi::Error::from_reason)
}

#[napi]
pub fn codex_official_error(input: String) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
    Ok(multicc_cpr::codex_official::public_error(&v).to_string())
}

/// The embedded store is called on the Rust stack. V8 owns the public JSON
/// conversion (including toJSON hooks) and the identity of a thrown exception.
fn repository_access<'a>(p: L<'a>, request: L<'a>) -> Result<L<'a>> {
    use napi::bindgen_prelude::FromNapiValue;
    let file = p.get(c"file")?;
    let injected = p.get(c"access")?;
    if !injected.undefined()? {
        return injected.call_plain(&[file, request]);
    }
    let access = || -> Result<L<'a>> {
        let json = p.global()?.get(c"JSON")?;
        let parse = json.get(c"parse")?;
        let raw = json.get(c"stringify")?.call(json, &[request])?;
        let file = unsafe { String::from_napi_value(file.env(), file.raw()) }?;
        let input = unsafe { String::from_napi_value(raw.env(), raw.raw()) }?;
        let result = provider_store(file, input)?;
        parse.call(json, &[text(p, &result)?])
    };
    match access() {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            let exception = match p.exception_value()? {
                Some(original) => original,
                None => p
                    .global()?
                    .get(c"Error")?
                    .construct(&[text(p, &error.reason)?])?,
            };
            exception.assign(c"code", exception.get(c"message")?)?;
            Err(exception.throw_error())
        }
    }
}

/// Revision ownership follows the exact array returned by read, including
/// writes of a replacement array derived from an earlier snapshot.
#[napi]
pub fn provider_repository(
    env: napi::Env,
    file: napi::bindgen_prelude::Unknown<'_>,
    access: napi::bindgen_prelude::Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    use crate::{
        host_methods::{call, method},
        js_live::{fields, LiveValue as L},
    };
    use multicc_core::js::JsValue as V;
    let file = L::new(&env, file);
    let revisions = file.global()?.get(c"WeakMap")?.construct(&[])?;
    let ports = fields(
        file,
        &[
            ("file", file),
            ("revisions", revisions),
            ("access", L::new(&env, access)),
        ],
    )?;
    let read = method(&env, ports, "read", 0, 0, |p, _| {
        let req = fields(p, &[("operation", p.from_value(&"read".into())?)])?;
        let snapshot = repository_access(p, req)?;
        let records = snapshot.get(c"records")?;
        call(
            p.get(c"revisions")?,
            c"set",
            &[records, snapshot.get(c"revision")?],
        )?;
        snapshot.get(c"records")
    })?;
    let write = method(&env, ports, "write", 1, 2, |p, args| {
        let records = args[0];
        let source = if args[1].undefined()? {
            records
        } else {
            args[1]
        };
        let revisions = p.get(c"revisions")?;
        let rev = call(revisions, c"get", &[source])?;
        let req = fields(
            p,
            &[
                ("operation", p.from_value(&"write".into())?),
                ("records", records),
                ("revision", rev),
            ],
        )?;
        let next = repository_access(p, req)?;
        call(revisions, c"set", &[records, next.get(c"revision")?])?;
        p.from_value(&V::Undefined)
    })?;
    Ok(fields(file, &[("read", read), ("write", write)])?.raw())
}

/// Pick the completion, proxy, or injected fetch continuation after the
/// credential read. Fetch options and timeout are the same for all vendors.
#[napi]
pub async fn account_subscription_start(input: String, injected_fetch: bool) -> Result<String> {
    let v = multicc_core::json_lenient::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    let plan = multicc_cpr::provider_host::subscription_plan(v)
        .await
        .map_err(napi::Error::from_reason)?;
    let step = if plan.get("result").is_some_and(serde_json::Value::is_object) {
        serde_json::json!({"mode":"done","result":plan["result"]})
    } else if injected_fetch {
        serde_json::json!({"mode":"fetch","request":{"method":"GET","headers":plan["headers"]},"timeout":10000,"plan":plan})
    } else {
        serde_json::json!({"mode":"proxy","plan":plan})
    };
    Ok(step.to_string())
}
