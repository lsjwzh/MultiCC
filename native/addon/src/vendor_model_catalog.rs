//! V8 owns the live model arrays (including a mutable offline row). Rust
//! selects the catalog, publishes successful reads and decides cache lifetime.
use crate::js_live::{fields, spread, LiveValue as L};
use multicc_core::{
    js::{JsString, JsValue as V},
    vendor_model_catalog::Vendor,
};
use napi::{
    bindgen_prelude::{AsyncTask, Unknown},
    sys, Env, Result, ScopedTask,
};
use napi_derive::napi;

// CLI stdout is bounded by execFile but can still be several MiB. Decode it on
// the worker pool and construct at most the vendor row limit on the JS thread.
pub struct ReadListing {
    kind: Vendor,
    text: JsString,
}

impl<'task> ScopedTask<'task> for ReadListing {
    type Output = V;
    type JsValue = Unknown<'task>;
    fn compute(&mut self) -> Result<V> {
        let listing = self.kind.parse(&self.text);
        Ok(V::object(vec![
            ("models", V::Array(listing.models)),
            ("authenticated", V::Bool(listing.authenticated)),
        ]))
    }
    fn resolve(&mut self, env: &'task Env, output: V) -> Result<Unknown<'task>> {
        let value = unsafe { crate::js_bridge::write_value(env.raw(), &output)? };
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), value) })
    }
}

#[napi]
pub struct RustVendorModelCatalog {
    kind: Vendor,
}

fn now(anchor: L<'_>) -> Result<L<'_>> {
    let date = anchor.global()?.get(c"Date")?;
    date.get(c"now")?.call(date, &[])
}
fn input(raw: L<'_>) -> Result<JsString> {
    if !raw.truthy()? {
        return Ok(JsString::new());
    }
    raw.global()?
        .get(c"String")?
        .call_plain(&[raw])?
        .coerce_string()
}
impl RustVendorModelCatalog {
    fn fallback<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let table = anchor.get(c"fallback")?;
        let rows = anchor.from_value(&V::Array(vec![]))?;
        let length = table.get(c"length")?.number()? as u32;
        for i in 0..length {
            let entry = table.element(i)?;
            let value = if self.kind == Vendor::Commandcode {
                let copy = spread(entry)?;
                copy.define_key(anchor.from_value(&"label".into())?, entry.get(c"model")?)?;
                copy
            } else {
                fields(anchor, &[("model", entry), ("label", entry)])?
            };
            rows.set_element(i, value)?;
        }
        Ok(rows)
    }
    fn fresh(&self, state: L<'_>) -> Result<bool> {
        let cache = state.get(c"cache")?;
        Ok(!cache.nullish()?
            && now(state)?.number()? - cache.get(c"at")?.number()? < self.kind.ttl_ms())
    }
}
#[napi]
impl RustVendorModelCatalog {
    #[napi(constructor)]
    pub fn new(name: String) -> Result<Self> {
        Ok(Self {
            kind: Vendor::named(&name)
                .ok_or_else(|| napi::Error::from_reason("invalid vendor catalog"))?,
        })
    }
    #[napi]
    pub fn defaults(&self, env: Env) -> Result<sys::napi_value> {
        let table = unsafe { crate::js_bridge::write_value(env.raw(), &self.kind.defaults())? };
        Ok(L::from_raw(env.raw(), table).freeze()?.raw())
    }
    #[napi]
    pub fn parse(&self, env: Env, raw: Unknown<'_>) -> Result<sys::napi_value> {
        let raw = L::new(&env, raw);
        let listing = self.kind.parse(&input(raw)?);
        let models = raw.from_value(&V::Array(listing.models))?;
        Ok(if self.kind == Vendor::Grok {
            fields(
                raw,
                &[
                    ("models", models),
                    (
                        "authenticated",
                        raw.from_value(&V::Bool(listing.authenticated))?,
                    ),
                ],
            )?
        } else {
            models
        }
        .raw())
    }
    #[napi]
    pub fn is_fresh(&self, env: Env, state: Unknown<'_>) -> Result<bool> {
        self.fresh(L::new(&env, state))
    }
    #[napi]
    pub fn peek(&self, env: Env, state: Unknown<'_>) -> Result<sys::napi_value> {
        let state = L::new(&env, state);
        Ok(if self.fresh(state)? {
            state.get(c"cache")?.get(c"models")?
        } else {
            self.fallback(state)?
        }
        .raw())
    }
    #[napi]
    pub fn read_listing(&self, env: Env, raw: Unknown<'_>) -> Result<AsyncTask<ReadListing>> {
        Ok(AsyncTask::new(ReadListing {
            kind: self.kind,
            text: input(L::new(&env, raw))?,
        }))
    }
    #[napi]
    pub fn finish(
        &self,
        env: Env,
        state: Unknown<'_>,
        listing: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let state = L::new(&env, state);
        let listing = L::new(&env, listing);
        let models = listing.optional(c"models")?;
        let (models, source) = if models.nullish()? || models.get(c"length")?.is_number(0.)? {
            (self.fallback(state)?, "fallback")
        } else if listing.get(c"authenticated")?.truthy()? {
            state.set(
                c"cache",
                fields(state, &[("at", now(state)?), ("models", models)])?,
            )?;
            (models, "cli")
        } else {
            (models, "cli-unauthenticated")
        };
        Ok(fields(
            state,
            &[
                ("models", models),
                ("source", state.from_value(&source.into())?),
            ],
        )?
        .raw())
    }
}
