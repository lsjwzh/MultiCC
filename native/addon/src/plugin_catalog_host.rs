//! Signed plugin catalogs and host compatibility metadata.
use crate::host_api::*;
use multicc_core::js::is_js_whitespace_char;
use napi_derive::napi;
use std::ffi::CStr;
mod cache;
mod host;
pub(crate) mod io;
mod parse;
mod states;

pub(crate) fn fallback_to<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { other })
}
pub(crate) fn or_null(v: L<'_>) -> Result<L<'_>> {
    fallback_to(v, null(v)?)
}
pub(crate) fn default_to<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.undefined()? { other } else { v })
}
pub(crate) fn push<'a>(a: L<'a>, v: L<'a>) -> Result<()> {
    call(a, c"push", &[v])?;
    Ok(())
}
pub(crate) fn items(v: L<'_>) -> Result<Vec<L<'_>>> {
    let mut result = Vec::new();
    v.for_each(|x| {
        result.push(x);
        Ok(())
    })?;
    Ok(result)
}
pub(crate) fn keys(o: L<'_>) -> Result<L<'_>> {
    call(o.global()?.get(c"Object")?, c"keys", &[o])
}
pub(crate) fn message<'a>(p: L<'a>, err: napi::Error) -> Result<L<'a>> {
    Ok(match p.exception_value()? {
        Some(e) => e,
        None => error_value(p, &err.reason)?,
    })
}
pub(crate) fn reject<'a>(p: L<'a>, s: &str) -> Result<L<'a>> {
    Err(error_value(p, s)?.throw_error())
}
pub(crate) fn log<'a>(o: L<'a>, key: &CStr, tag: &str, detail: L<'a>) -> Result<()> {
    let f = o.get(key)?;
    if !f.nullish()? {
        f.call(o, &[text(o, tag)?, detail])?;
    }
    Ok(())
}
pub(crate) fn str_nonempty(v: L<'_>) -> Result<L<'_>> {
    Ok(if v.kind()? == sys::ValueType::napi_string && v.truthy()? {
        v
    } else {
        null(v)?
    })
}
pub(crate) fn string_list(v: L<'_>) -> Result<L<'_>> {
    let out = array(v)?;
    if v.is_array()? {
        v.for_each(|x| {
            if str_nonempty(x)?.truthy()? {
                push(out, x)?
            }
            Ok(())
        })?;
    }
    Ok(out)
}
pub(crate) fn strings<'a>(p: L<'a>, v: &[&str]) -> Result<L<'a>> {
    let a = array(p)?;
    for s in v {
        push(a, text(p, s)?)?;
    }
    Ok(a)
}
pub(crate) fn valid_id(s: &str, uppercase: bool) -> bool {
    let valid =
        |c: u8| c.is_ascii_digit() || c.is_ascii_lowercase() || uppercase && c.is_ascii_uppercase();
    s.as_bytes().first().is_some_and(|c| valid(*c))
        && s.bytes()
            .all(|c| valid(c) || matches!(c, b'.' | b'_' | b'-'))
}
fn valid_bundle(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
}
pub(crate) fn now_js(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn text_of(v: L<'_>) -> Result<String> {
    if v.nullish()? {
        Ok(String::new())
    } else {
        fold_string(v)
    }
}
#[derive(Clone)]
struct Version {
    parts: [f64; 3],
    pre: String,
}
fn parse_version(s: &str) -> Option<Version> {
    let s = s.trim_matches(is_js_whitespace_char);
    let s = s.strip_prefix('v').unwrap_or(s);
    let (n, pre) = match s.split_once('-') {
        None => (s, ""),
        Some((n, pre))
            if !pre.is_empty()
                && pre
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || x == b'.' || x == b'-') =>
        {
            (n, pre)
        }
        _ => return None,
    };
    let mut parts = [0.; 3];
    for (i, v) in n.split('.').enumerate() {
        if i >= 3 || v.is_empty() || !v.bytes().all(|x| x.is_ascii_digit()) {
            return None;
        }
        parts[i] = v.parse().ok()?;
    }
    Some(Version {
        parts,
        pre: pre.into(),
    })
}
fn cmp(a: &Version, b: &Version) -> f64 {
    for (a, b) in a.parts.into_iter().zip(b.parts) {
        if a != b {
            return a - b;
        }
    }
    if a.pre == b.pre {
        0.
    } else if a.pre.is_empty() {
        1.
    } else if b.pre.is_empty() || a.pre < b.pre {
        -1.
    } else {
        1.
    }
}
fn compare(a: &str, b: &str) -> f64 {
    parse_version(a)
        .zip(parse_version(b))
        .map(|(a, b)| cmp(&a, &b))
        .unwrap_or(f64::NAN)
}
fn terms(s: &str) -> Option<Vec<(&str, Version)>> {
    let s = s.trim_matches(is_js_whitespace_char);
    if s == "*" || s.is_empty() {
        return Some(vec![]);
    }
    s.split(is_js_whitespace_char)
        .filter(|t| !t.is_empty())
        .map(|t| {
            let op = [">=", "<", "^", "="]
                .iter()
                .find(|op| t.starts_with(**op))
                .copied()
                .unwrap_or("");
            Some((op, parse_version(&t[op.len()..])?))
        })
        .collect()
}
fn satisfies(v: &str, s: &str) -> bool {
    let (Some(v), Some(terms)) = (parse_version(v), terms(s)) else {
        return false;
    };
    terms.into_iter().all(|(op, t)| {
        let n = cmp(&v, &t);
        match op {
            ">=" => n >= 0.,
            "<" => n < 0.,
            "^" => {
                let p = if t.parts[0] > 0. {
                    [t.parts[0] + 1., 0., 0.]
                } else {
                    [0., t.parts[1] + 1., 0.]
                };
                n >= 0.
                    && cmp(
                        &v,
                        &Version {
                            parts: p,
                            pre: String::new(),
                        },
                    ) < 0.
            }
            _ => n == 0.,
        }
    })
}
const ORDER: &[&str] = &[
    "update",
    "incompatible",
    "builtin",
    "installed",
    "installable",
    "unsupported",
];
#[napi]
pub fn plugin_catalog_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = defaulted_methods(
        p,
        &[
            ("parseVersion", 1, 1, |p, a| {
                let Some(v) = parse_version(&text_of(a[0])?) else {
                    return null(p);
                };
                let parts = array(p)?;
                for n in v.parts {
                    push(parts, num(p, n)?)?
                }
                fields(p, &[("parts", parts), ("pre", text(p, &v.pre)?)])
            }),
            ("compareVersions", 2, 2, |p, a| {
                num(p, compare(&text_of(a[0])?, &text_of(a[1])?))
            }),
            ("satisfies", 2, 2, |p, a| {
                flag(p, satisfies(&text_of(a[0])?, &text_of(a[1])?))
            }),
            ("parseCatalog", 1, 1, |p, a| parse::catalog(p, a[0])),
            ("verifySignature", 2, 3, |p, a| {
                parse::verify(p, a[0], a[1], default_to(a[2], p.get(c"keys")?)?)
            }),
            ("unmetRequirement", 2, 2, |_, a| states::unmet(a[0], a[1])),
            ("appsReferenced", 2, 2, |_, a| states::apps(a[0], a[1])),
            ("computeStates", 1, 1, |p, a| states::compute(p, a[0])),
            ("createHostFacts", 0, 1, host::create),
            ("createPluginCatalog", 0, 1, cache::create),
        ],
    )?;
    let keys = fields(
        p,
        &[(
            "catalog-2026-10",
            text(
                p,
                "MCowBQYDK2VwAyEAdfDhN/oSaq1KgWb7bn7RqaT7uovSmg/5Hg6iQNEtD1I=",
            )?,
        )],
    )?
    .freeze()?;
    let sources = strings(
        p,
        &[
            "https://raw.githubusercontent.com/lsjwzh/multicc-plugins/main/index.json",
            "https://cdn.jsdelivr.net/gh/lsjwzh/multicc-plugins@main/index.json",
        ],
    )?
    .freeze()?;
    p.set(c"keys", keys)?;
    p.set(c"sources", sources)?;
    out.set(c"CATALOG_KEYS", keys)?;
    out.set(c"CATALOG_SOURCES", sources)?;
    let order = strings(p, ORDER)?;
    p.set(c"stateOrder", order)?;
    out.set(c"STATE_ORDER", order)?;
    out.set(c"PLUGIN_API_VERSION", num(p, 2.)?)?;
    out.set(c"CATALOG_SCHEMA", num(p, 1.)?)?;
    Ok(out.raw())
}
