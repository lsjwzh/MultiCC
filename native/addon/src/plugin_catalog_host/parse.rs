use super::*;

fn positive_safe(v: L<'_>) -> Result<bool> {
    Ok(v.number_value()?
        .is_some_and(|n| n > 0. && n <= 9007199254740991. && n.fract() == 0.))
}
fn check_requires(r: L<'_>) -> Result<L<'_>> {
    if r.nullish()? {
        return null(r);
    }
    if !object(r)? || r.is_array()? {
        return reject(r, "requires must be an object");
    }
    for (k, n) in [(c"multicc", "multicc"), (c"agentBuild", "agentBuild")] {
        let v = r.get(k)?;
        if !v.nullish()? && terms(&text_of(v)?).is_none() {
            return reject(r, &format!("requires.{n} is not a version range"));
        }
    }
    let api = r.get(c"pluginApi")?;
    if !api.nullish()? && !positive_safe(api)? {
        return reject(r, "requires.pluginApi must be a positive integer");
    }
    let platforms = r.get(c"platforms")?;
    if !platforms.nullish()? {
        if !platforms.is_array()? || !platforms.get(c"length")?.truthy()? {
            return reject(r, "requires.platforms must be a non-empty array");
        }
        for v in items(platforms)? {
            if !v.truthy()?
                || !matches!(
                    text_of(v.optional(c"os")?)?.as_str(),
                    "darwin" | "linux" | "win32"
                )
            {
                return reject(r, "requires.platforms[].os is unknown");
            }
            let arch = v.get(c"arch")?;
            if !arch.nullish()?
                && !str_nonempty(arch)?.truthy()?
                && !string_list(arch)?.get(c"length")?.truthy()?
            {
                return reject(r, "requires.platforms[].arch is invalid");
            }
            let min = v.get(c"minOS")?;
            if !min.nullish()? && parse_version(&text_of(min)?).is_none() {
                return reject(r, "requires.platforms[].minOS is not a version");
            }
        }
    }
    let apps = r.get(c"apps")?;
    if !apps.nullish()? {
        if !apps.is_array()? {
            return reject(r, "requires.apps must be an array");
        }
        for app in items(apps)? {
            let id = app.optional(c"id")?;
            if !id.truthy()? || !valid_bundle(&text_of(id)?) {
                return reject(r, "requires.apps[].id is not a bundle id");
            }
            let min = app.get(c"minVersion")?;
            if !min.nullish()? && parse_version(&text_of(min)?).is_none() {
                return reject(r, "requires.apps[].minVersion is not a version");
            }
            for path in items(string_list(app.get(c"macosPaths")?)?)? {
                let s = text_of(path)?;
                if !s.starts_with("/Applications/") || !s.ends_with(".app") {
                    return reject(r, "requires.apps[].macosPaths must be /Applications/*.app");
                }
            }
        }
    }
    Ok(r)
}
fn check_assets<'a>(p: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let out = fields(p, &[])?;
    if v.nullish()? {
        return Ok(out);
    }
    if !object(v)? || v.is_array()? {
        return reject(p, "assets must be an object");
    }
    for key in items(keys(v)?)? {
        let k = text_of(key)?;
        if !matches!(
            k.split_once('-'),
            Some(("darwin" | "linux" | "win32", "arm64" | "x64"))
        ) {
            return reject(p, &format!("assets key {k} is not <os>-<arch>"));
        }
        let asset = v.get_key(key)?;
        let url = str_nonempty(asset.optional(c"url")?)?;
        let u = text_of(url)?;
        if !u.starts_with("https://github.com/")
            && !u.starts_with("https://objects.githubusercontent.com/")
        {
            return reject(p, &format!("assets.{k}.url must be on github.com"));
        }
        let sha = asset.get(c"sha256")?;
        let s = text_of(sha)?;
        if s.len() != 64
            || !s
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        {
            return reject(p, &format!("assets.{k}.sha256 is invalid"));
        }
        let size = asset.get(c"size")?;
        if !positive_safe(size)? {
            return reject(p, &format!("assets.{k}.size is invalid"));
        }
        out.define_key(
            key,
            fields(p, &[("url", url), ("sha256", sha), ("size", size)])?,
        )?;
    }
    Ok(out)
}
fn entry(v: L<'_>) -> Result<L<'_>> {
    let id = v.optional(c"id")?;
    if !id.truthy()? || !valid_id(&text_of(id)?, false) {
        return reject(v, "id is invalid");
    }
    let distribution = v.get(c"distribution")?;
    let builtin = distribution.is_string("builtin")?;
    if !builtin && !distribution.is_string("optional")? {
        return reject(
            v,
            &format!("distribution {} is unknown", fold_string(distribution)?),
        );
    }
    let releases = array(v)?;
    let homepage = str_nonempty(v.get(c"homepage")?)?;
    let out = fields(
        v,
        &[
            ("id", id),
            ("name", fallback_to(str_nonempty(v.get(c"name")?)?, id)?),
            ("nameEn", str_nonempty(v.get(c"nameEn")?)?),
            (
                "icon",
                fallback_to(str_nonempty(v.get(c"icon")?)?, text(v, "🧩")?)?,
            ),
            ("category", str_nonempty(v.get(c"category")?)?),
            ("provides", string_list(v.get(c"provides")?)?),
            ("distribution", distribution),
            (
                "summary",
                fallback_to(str_nonempty(v.get(c"summary")?)?, text(v, "")?)?,
            ),
            ("summaryEn", str_nonempty(v.get(c"summaryEn")?)?),
            (
                "homepage",
                if text_of(homepage)?.starts_with("https://") {
                    homepage
                } else {
                    null(v)?
                },
            ),
            ("builtinSince", null(v)?),
            ("requires", null(v)?),
            ("releases", releases),
        ],
    )?;
    if builtin {
        let since = v.get(c"builtinSince")?;
        if !since.nullish()? && parse_version(&text_of(since)?).is_none() {
            return reject(v, "builtinSince is not a version");
        }
        out.set(c"builtinSince", str_nonempty(since)?)?;
        out.set(c"requires", check_requires(v.get(c"requires")?)?)?;
        return Ok(out);
    }
    let input = v.get(c"releases")?;
    let latest = v.get(c"latest")?;
    let mut has_latest = false;
    if input.is_array()? {
        for r in items(input)? {
            let ver = r.optional(c"version")?;
            if parse_version(&text_of(ver)?).is_none() {
                return reject(v, "releases[].version is not a version");
            }
            has_latest |= ver.equals(latest)?;
            push(
                releases,
                fields(
                    v,
                    &[
                        ("version", ver),
                        ("publishedAt", str_nonempty(r.get(c"publishedAt")?)?),
                        ("requires", check_requires(r.get(c"requires")?)?),
                        ("assets", check_assets(v, r.get(c"assets")?)?),
                        ("notes", str_nonempty(r.get(c"notes")?)?),
                        ("notesEn", str_nonempty(r.get(c"notesEn")?)?),
                    ],
                )?,
            )?;
        }
    }
    if !releases.get(c"length")?.truthy()? {
        return reject(v, "an optional plugin needs at least one release");
    }
    call(
        releases,
        c"sort",
        &[function(v, "", 2, 2, |p, a| {
            num(
                p,
                compare(
                    &text_of(a[1].get(c"version")?)?,
                    &text_of(a[0].get(c"version")?)?,
                ),
            )
        })?],
    )?;
    if !latest.nullish()? && !has_latest {
        return reject(
            v,
            &format!("latest {} is not one of the releases", fold_string(latest)?),
        );
    }
    Ok(out)
}
pub(super) fn catalog<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let data = json_call(p, c"parse", input)?;
    let schema = if data.truthy()? {
        data.get(c"schema")?
    } else {
        data
    };
    if !schema.is_number(1.)? {
        let e = error_value(
            p,
            &format!(
                "catalog schema {} is not supported by this MultiCC",
                fold_string(schema)?
            ),
        )?;
        e.set(c"code", text(p, "CATALOG_SCHEMA")?)?;
        return Err(e.throw_error());
    }
    let updated = data.get(c"updatedAt")?;
    if !call(p.global()?.get(c"Date")?, c"parse", &[updated])?
        .number()?
        .is_finite()
    {
        return reject(p, "catalog updatedAt is not a date");
    }
    let raw = data.get(c"plugins")?;
    if !raw.is_array()? {
        return reject(p, "catalog plugins must be an array");
    }
    let seen = p.global()?.get(c"Set")?.construct(&[])?;
    let plugins = array(p)?;
    let warnings = array(p)?;
    for v in items(raw)? {
        let parsed = (|| {
            let r = entry(v)?;
            let id = r.get(c"id")?;
            if call(seen, c"has", &[id])?.truthy()? {
                return reject(p, "duplicate id");
            }
            call(seen, c"add", &[id])?;
            Ok(r)
        })();
        match parsed {
            Ok(r) => push(plugins, r)?,
            Err(err) => {
                let msg = message(p, err)?.get(c"message")?;
                let id = fallback_to(v.optional(c"id")?, text(p, "?")?)?;
                push(
                    warnings,
                    call(text(p, "")?, c"concat", &[id, text(p, ": ")?, msg])?,
                )?;
            }
        }
    }
    fields(
        p,
        &[
            ("schema", schema),
            ("updatedAt", updated),
            ("plugins", plugins),
            ("warnings", warnings),
        ],
    )
}
pub(super) fn verify<'a>(p: L<'a>, body: L<'a>, signature: L<'a>, keys: L<'a>) -> Result<L<'a>> {
    let envelope = match p.catch(|| json_call(p, c"parse", string(signature)?))? {
        Some(e) => e,
        None => return reject(p, "signature file is not JSON"),
    };
    let id = if envelope.truthy()? {
        envelope.get(c"keyId")?
    } else {
        envelope
    };
    let spki = if envelope.truthy()? {
        keys.get_key(id)?
    } else {
        envelope
    };
    if !spki.truthy()? {
        return reject(
            p,
            &format!("signature key {} is not trusted", fold_string(id)?),
        );
    }
    let buf = p.global()?.get(c"Buffer")?;
    let crypto = p.get(c"crypto")?;
    let b64 = text(p, "base64")?;
    let key = call(
        crypto,
        c"createPublicKey",
        &[fields(
            p,
            &[
                ("key", call(buf, c"from", &[spki, b64])?),
                ("format", text(p, "der")?),
                ("type", text(p, "spki")?),
            ],
        )?],
    )?;
    let sig = call(
        buf,
        c"from",
        &[
            string(fallback_to(envelope.get(c"signature")?, text(p, "")?)?)?,
            b64,
        ],
    )?;
    if !call(
        crypto,
        c"verify",
        &[null(p)?, call(buf, c"from", &[body])?, key, sig],
    )?
    .truthy()?
    {
        return reject(p, "signature does not match the list");
    }
    Ok(id)
}
