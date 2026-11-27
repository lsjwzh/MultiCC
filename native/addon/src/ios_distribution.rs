//! Work on JS code units so a title can be truncated between surrogate halves.
use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;
const MANIFEST: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key>
					<string>software-package</string>
					<key>url</key>
					<string>{}</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>{}</string>
				<key>bundle-version</key>
				<string>{}</string>
				<key>kind</key>
				<string>software</string>
				<key>title</key>
				<string>{}</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
"##;

fn escape(value: &JsString) -> JsString {
    let mut out = JsString::new();
    for &c in value.as_units() {
        match c {
            38 => out.push_str("&amp;"),
            60 => out.push_str("&lt;"),
            62 => out.push_str("&gt;"),
            34 => out.push_str("&quot;"),
            39 => out.push_str("&apos;"),
            _ => out.push_unit(c),
        }
    }
    out
}
#[napi]
pub fn ios_escape(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, value);
    Ok(p.from_value(&V::String(escape(&p.coerce_string()?)))?.raw())
}
#[napi]
pub fn ios_manifest(
    env: Env,
    asset: Unknown<'_>,
    bundle: Unknown<'_>,
    version: Unknown<'_>,
    title: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, asset);
    let parts = MANIFEST.split("{}");
    let mut args = [asset, bundle, version, title].into_iter();
    let mut out = JsString::new();
    for literal in parts {
        out.push_str(literal);
        if let Some(v) = args.next() {
            out.push(&escape(&L::new(&env, v).coerce_string()?));
        }
    }
    Ok(p.from_value(&V::String(out))?.raw())
}
#[napi]
pub fn ios_origin(proto: String, host: String) -> String {
    let proto = if proto == "http" { "http" } else { "https" };
    let valid = !host.is_empty()
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c));
    format!("{proto}://{}", if valid { &host } else { "127.0.0.1" })
}
fn valid_version(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=80).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
}
#[napi]
pub fn ios_sidecar(
    env: Env,
    result: Unknown<'_>,
    data: Unknown<'_>,
    iso_date: Unknown<'_>,
) -> Result<()> {
    let r = L::new(&env, result);
    let p = L::new(&env, data);
    if p.kind()? != sys::ValueType::napi_object {
        return Ok(());
    }
    for key in [c"versionName", c"bundleId", c"versionCode"] {
        let value = p.get(key)?;
        if let Some(s) = value.string()? {
            let s = s.trim();
            let word = s.as_str_lossy();
            let valid = if key == c"bundleId" {
                (2..=128).contains(&word.len())
                    && word.as_bytes()[0].is_ascii_alphanumeric()
                    && word
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            } else {
                valid_version(&word)
            };
            if valid {
                r.set(key, r.from_value(&V::String(s))?)?;
            }
        } else if key == c"versionCode" {
            if let Some(n) = value.number_value()? {
                if n.fract() == 0. && (1.0..=9007199254740991.).contains(&n) {
                    r.set(key, string(value)?)?
                }
            }
        }
    }
    if let Some(s) = p.get(c"title")?.string()? {
        let s = s.trim();
        if !s.is_empty() {
            r.set(c"title", r.from_value(&V::String(s.truncate_units(80)))?)?
        }
    }
    let hash = p.get(c"sha256")?;
    if let Some(h) = hash.string()? {
        if h.len() == 64 && h.as_units().iter().all(|n| matches!(n,48..=57|97..=102)) {
            r.set(c"sha256", hash)?
        }
    }
    let date = p.get(c"builtAt")?;
    if date.kind()? == sys::ValueType::napi_string {
        let iso = L::new(&env, iso_date).call_plain(&[date])?;
        if iso.truthy()? {
            r.set(c"builtAt", iso)?;
        }
    }
    Ok(())
}
#[napi]
pub fn ios_distribution_info(env: Env, local: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, local);
    let r = fields(
        p,
        &[
            ("exists", flag(p, false)?),
            ("installable", flag(p, false)?),
            ("installPage", text(p, "/ios-ota")?),
            ("downloadUrl", text(p, "/multicc-ios.ipa")?),
        ],
    )?;
    if p.get(c"exists")?.truthy()? {
        r.set(c"exists", flag(p, true)?)?;
        for key in [
            c"size",
            c"mtime",
            c"versionName",
            c"versionCode",
            c"bundleId",
            c"title",
            c"sha256",
            c"builtAt",
        ] {
            let v = p.get(key)?;
            if key == c"size" || key == c"mtime" || !v.nullish()? {
                r.set(key, v)?;
            }
        }
        r.set(
            c"installable",
            flag(
                p,
                p.get(c"bundleId")?.truthy()? && p.get(c"versionName")?.truthy()?,
            )?,
        )?;
    }
    Ok(r.raw())
}

use crate::host_methods::{arg, env as host_env, function, raw};
fn read_local(p: L<'_>) -> Result<L<'_>> {
    let path = call(
        p.get(c"path")?,
        c"join",
        &[
            p.get(c"rootDir")?,
            text(p, "public")?,
            text(p, "multicc-ios.ipa")?,
        ],
    )?;
    let r = fields(p, &[("exists", flag(p, false)?), ("ipaPath", path)])?;
    let stat = match p.catch(|| call(p.get(c"fs")?, c"lstatSync", &[path]))? {
        Some(v) => v,
        None => return Ok(r),
    };
    if !call(stat, c"isFile", &[])?.truthy()? || stat.get(c"size")?.explicit_number()? <= 0. {
        return Ok(r);
    }
    r.set(c"exists", flag(p, true)?)?;
    r.set(c"size", stat.get(c"size")?)?;
    r.set(c"mtime", call(stat.get(c"mtime")?, c"toISOString", &[])?)?;
    let side = p
        .catch(|| {
            let mut path = path.coerce_string()?;
            path.push_str(".json");
            let file = p.from_value(&V::String(path))?;
            let stat = call(p.get(c"fs")?, c"lstatSync", &[file])?;
            if call(stat, c"isFile", &[])?.truthy()?
                && stat.get(c"size")?.explicit_number()? > 0.
                && stat.get(c"size")?.explicit_number()? <= 16384.
            {
                return call(
                    p.global()?.get(c"JSON")?,
                    c"parse",
                    &[call(
                        p.get(c"fs")?,
                        c"readFileSync",
                        &[file, text(p, "utf8")?],
                    )?],
                );
            }
            null(p)
        })?
        .unwrap_or(null(p)?);
    let iso = function(p, "", 1, 1, |p, a| {
        let date = p.global()?.get(c"Date")?;
        if !call(date, c"parse", &[a[0]])?.number()?.is_finite() {
            return null(p);
        }
        call(date.construct(&[a[0]])?, c"toISOString", &[])
    })?;
    ios_sidecar(host_env(p), arg(r)?, arg(side)?, arg(iso)?)?;
    Ok(r)
}
fn header(v: L<'_>) -> Result<JsString> {
    let v = if v.is_array()? { v.element(0)? } else { v };
    let s = string(fallback(v, "".into())?)?.coerce_string()?;
    Ok(JsString::from_units(
        s.as_units()
            .split(|&c| c == 44)
            .next()
            .unwrap_or_default()
            .to_vec(),
    )
    .trim()
    .to_lowercase())
}
fn base_url(req: L<'_>) -> Result<L<'_>> {
    let h = fallback(req.optional(c"headers")?, V::Object(vec![]))?;
    let mut proto = header(h.get(c"x-forwarded-proto")?)?;
    if proto.is_empty() {
        proto = string(fallback(req.optional(c"protocol")?, "".into())?)?
            .coerce_string()?
            .to_lowercase();
    }
    let mut host = header(h.get(c"x-forwarded-host")?)?;
    if host.is_empty() {
        host = header(h.get(c"host")?)?;
    }
    text(
        req,
        &ios_origin(proto.to_string_lossy(), host.to_string_lossy()),
    )
}
fn manifest_for<'a>(meta: L<'a>, base: L<'a>) -> Result<L<'a>> {
    let mut url = base.coerce_string()?;
    url.push_str("/multicc-ios.ipa");
    let title = fallback(meta.get(c"title")?, "MultiCC".into())?;
    let code = meta.get(c"versionCode")?;
    let version = if code.truthy()? {
        code
    } else {
        meta.get(c"versionName")?
    };
    let asset = meta.from_value(&V::String(url))?;
    Ok(raw(
        meta,
        ios_manifest(
            host_env(meta),
            arg(asset)?,
            arg(string(meta.get(c"bundleId")?)?)?,
            arg(string(version)?)?,
            arg(string(title)?)?,
        )?,
    ))
}
#[napi]
pub fn ios_read_local(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(read_local(L::new(&env, deps))?.raw())
}
#[napi]
pub fn ios_absolute_url(env: Env, req: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(base_url(L::new(&env, req))?.raw())
}
#[napi]
pub fn ios_build_manifest(
    env: Env,
    meta: Unknown<'_>,
    base: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(manifest_for(L::new(&env, meta), L::new(&env, base))?.raw())
}
#[napi]
pub fn ios_ota_api(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, deps);
    if !p.truthy()?
        || !p.get(c"fs")?.truthy()?
        || !p.get(c"path")?.truthy()?
        || !p.get(c"rootDir")?.truthy()?
    {
        return Err(p.type_error("iOS OTA distribution requires fs, path, and rootDir"));
    }
    let info = function(p, "info", 0, 0, |p, _| {
        Ok(raw(
            p,
            ios_distribution_info(host_env(p), arg(read_local(p)?)?)?,
        ))
    })?;
    let handler = function(p, "manifestHandler", 2, 2, |p, a| {
        let m = read_local(p)?;
        let r = a[1];
        call(
            r,
            c"set",
            &[
                text(r, "Cache-Control")?,
                text(r, "no-store, no-cache, must-revalidate")?,
            ],
        )?;
        call(r, c"set", &[text(r, "Pragma")?, text(r, "no-cache")?])?;
        if !m.get(c"exists")?.truthy()?
            || !m.get(c"bundleId")?.truthy()?
            || !m.get(c"versionName")?.truthy()?
        {
            return call(call(r, c"status", &[num(p, 404.)?])?, c"end", &[]);
        }
        call(
            r,
            c"set",
            &[
                text(r, "Content-Type")?,
                text(r, "text/xml; charset=utf-8")?,
            ],
        )?;
        let target = call(r, c"status", &[num(r, 200.)?])?;
        call(target, c"send", &[manifest_for(m, base_url(a[0])?)?])
    })?;
    Ok(fields(p, &[("info", info), ("manifestHandler", handler)])?
        .freeze()?
        .raw())
}
