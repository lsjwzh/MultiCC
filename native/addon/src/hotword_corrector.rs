use crate::route_response::*;
use multicc_core::{hotword_corrector as core, js::JsString as S};
use napi_derive::napi;
fn words(v: L<'_>) -> Result<Vec<S>> {
    let mut out = vec![];
    v.for_each(|s| {
        out.push(s.coerce_string()?);
        Ok(())
    })?;
    Ok(out)
}
#[napi]
pub fn hotword_entries(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, input);
    let s = p.string()?.unwrap_or_default();
    let out = p.from_value(&V::Array(vec![]))?;
    for (term, aliases) in core::entries(&s) {
        call(
            out,
            c"push",
            &[fields(
                p,
                &[
                    ("term", p.from_value(&V::String(term))?),
                    (
                        "aliases",
                        p.from_value(&V::Array(aliases.into_iter().map(V::String).collect()))?,
                    ),
                ],
            )?],
        )?;
    }
    Ok(out.raw())
}
#[napi]
pub fn hotword_stripped(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, input);
    Ok(
        p.from_value(&V::String(core::stripped(&p.string()?.unwrap_or_default())))?
            .raw(),
    )
}
#[napi]
pub fn hotword_near(env: Env, a: Unknown<'_>, b: Unknown<'_>) -> Result<bool> {
    Ok(core::near(
        &L::new(&env, a).coerce_string()?,
        &L::new(&env, b).coerce_string()?,
    ))
}
#[napi]
pub struct HotwordWindows {
    patterns: Vec<Vec<S>>,
}
#[napi]
impl HotwordWindows {
    #[napi(constructor)]
    pub fn new(env: Env, patterns: Unknown<'_>) -> Result<Self> {
        let mut terms = vec![];
        L::new(&env, patterns).for_each(|v| {
            terms.push(words(v)?);
            Ok(())
        })?;
        Ok(Self { patterns: terms })
    }
    #[napi]
    pub fn find(&self, env: Env, input: Unknown<'_>) -> Result<Vec<Vec<u32>>> {
        Ok(core::spans(&self.patterns, &words(L::new(&env, input))?)
            .into_iter()
            .map(|(n, s, e)| vec![n as u32, s as u32, e as u32])
            .collect())
    }
}
