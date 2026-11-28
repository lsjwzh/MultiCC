use super::*;
use std::{collections::HashSet, fs, path::Path};

pub(super) fn manifest<'a>(p: L<'a>, root: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if !valid_id(&fold_string(id)?, true) {
        return null(p);
    }
    let dir = call(p.get(c"path")?, c"resolve", &[root, id])?;
    let Ok(raw) = fs::read(Path::new(&fold_string(dir)?).join("plugin.json")) else {
        return null(p);
    };
    parse_manifest(p, dir, id, &String::from_utf8_lossy(&raw))
}
fn parse_manifest<'a>(p: L<'a>, dir: L<'a>, id: L<'a>, raw: &str) -> Result<L<'a>> {
    let Some(m) = p.catch(|| json_call(p, c"parse", text(p, raw)?))? else {
        return null(p);
    };
    if !m.get(c"id")?.equals(id)? {
        return null(p);
    }
    let commands = m.get(c"commands")?;
    if !commands.is_array()? || !commands.get(c"length")?.truthy()? {
        return null(p);
    }
    let engine = m.get(c"engine")?;
    let binary = engine.optional(c"binary")?;
    if !engine.optional(c"type")?.is_string("command")?
        || binary.kind()? != sys::ValueType::napi_string
        || !binary.truthy()?
    {
        return null(p);
    }
    fields(p, &[("manifest", m), ("dir", dir)])
}
pub(super) fn binary<'a>(p: L<'a>, found: L<'a>, platform: L<'a>, arch: L<'a>) -> Result<L<'a>> {
    let dir = found.get(c"dir")?;
    let engine = found.get(c"manifest")?.get(c"engine")?;
    let binary = engine.get(c"binary")?;
    let path = p.get(c"path")?;
    let base = call(path, c"basename", &[binary])?;
    let windows = platform.is_string("win32")? && !fold_string(base)?.ends_with(".exe");
    let mut names = vec![base];
    if windows {
        names.push(text(p, &format!("{}.exe", fold_string(base)?))?)
    }
    let mut candidates = Vec::new();
    let plat_dir = engine.get(c"binaryPlatformDir")?;
    if plat_dir.truthy()? {
        let target = text(
            p,
            &format!("{}-{}", fold_string(platform)?, fold_string(arch)?),
        )?;
        for n in names {
            candidates.push(call(path, c"join", &[dir, plat_dir, target, n])?)
        }
    }
    candidates.push(call(path, c"join", &[dir, binary])?);
    if windows {
        candidates.push(call(
            path,
            c"join",
            &[dir, text(p, &format!("{}.exe", fold_string(binary)?))?],
        )?)
    }
    let prefix = format!("{}{}", fold_string(dir)?, fold_string(path.get(c"sep")?)?);
    for c in candidates {
        let resolved = call(path, c"resolve", &[c])?;
        let s = fold_string(resolved)?;
        if s.starts_with(&prefix) && fs::metadata(&s).is_ok_and(|m| m.is_file()) {
            return Ok(resolved);
        }
    }
    null(p)
}
pub(super) fn entry<'a>(
    p: L<'a>,
    root: L<'a>,
    id: L<'a>,
    platform: L<'a>,
    arch: L<'a>,
    source: L<'a>,
) -> Result<L<'a>> {
    build_entry(p, manifest(p, root, id)?, id, platform, arch, source)
}
fn build_entry<'a>(
    p: L<'a>,
    found: L<'a>,
    id: L<'a>,
    platform: L<'a>,
    arch: L<'a>,
    source: L<'a>,
) -> Result<L<'a>> {
    if !found.truthy()? {
        return null(p);
    }
    let binary = binary(p, found, platform, arch)?;
    let m = found.get(c"manifest")?;
    let requires = m.get(c"requires")?;
    let category = m.get(c"category")?;
    let provides = array(p)?;
    let declared = m.get(c"provides")?;
    if declared.is_array()? {
        for item in items(declared)? {
            if item.kind()? == sys::ValueType::napi_string {
                push(provides, item)?
            }
        }
    }
    fields(
        p,
        &[
            ("id", id),
            ("source", source),
            (
                "requires",
                if object(requires)? && !requires.is_array()? {
                    requires
                } else {
                    null(p)?
                },
            ),
            (
                "category",
                if category.kind()? == sys::ValueType::napi_string {
                    category
                } else {
                    null(p)?
                },
            ),
            ("provides", provides),
            ("name", fallback_to(m.get(c"name")?, id)?),
            ("nameEn", or_null(m.get(c"nameEn")?)?),
            (
                "version",
                fallback_to(m.get(c"version")?, text(p, "0.0.0")?)?,
            ),
            (
                "description",
                fallback_to(m.get(c"description")?, text(p, "")?)?,
            ),
            ("descriptionEn", or_null(m.get(c"descriptionEn")?)?),
            ("icon", fallback_to(m.get(c"icon")?, text(p, "🧩")?)?),
            ("commands", m.get(c"commands")?),
            ("ui", or_null(m.get(c"ui")?)?),
            (
                "resident",
                flag(p, m.get(c"engine")?.get(c"resident")?.is_true()?)?,
            ),
            (
                "channel",
                call(
                    p.get(c"channel")?,
                    c"normalizeChannel",
                    &[m.get(c"channel")?],
                )?,
            ),
            (
                "engine",
                fields(
                    p,
                    &[
                        ("type", text(p, "command")?),
                        ("available", flag(p, binary.truthy()?)?),
                        (
                            "reason",
                            if binary.truthy()? {
                                null(p)?
                            } else {
                                text(p, "插件二进制缺失：需要为当前平台构建（见插件 README）")?
                            },
                        ),
                    ],
                )?,
            ),
        ],
    )
}
fn roots(o: L<'_>) -> Result<Vec<(&'static str, L<'_>)>> {
    let mut result = vec![("builtin", o.get(c"pluginsDir")?)];
    let user = o.get(c"userDir")?;
    if user.truthy()? {
        result.push(("user", user))
    }
    Ok(result)
}
pub(super) fn find<'a>(o: L<'a>, id: L<'a>) -> Result<L<'a>> {
    for (_, root) in roots(o)? {
        let found = manifest(o.get(c"ports")?, root, id)?;
        if found.truthy()? {
            return Ok(found);
        }
    }
    null(o)
}

type Roots = Vec<(&'static str, String)>;
fn absolute_roots(o: L<'_>) -> Result<Roots> {
    let path = o.get(c"ports")?.get(c"path")?;
    roots(o)?
        .into_iter()
        .map(|(source, dir)| Ok((source, fold_string(call(path, c"resolve", &[dir])?)?)))
        .collect()
}
struct Record {
    source: &'static str,
    id: String,
    dir: String,
    raw: String,
}
fn read_manifests(roots: Roots) -> Vec<Record> {
    let mut rows = Vec::new();
    for (source, root) in roots {
        let Ok(dir) = fs::read_dir(&root) else {
            continue;
        };
        let mut names: Vec<_> = dir
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|id| valid_id(id, true))
            .collect();
        names.sort();
        for id in names {
            let dir = Path::new(&root).join(&id);
            if let Ok(raw) = fs::read(dir.join("plugin.json")) {
                rows.push(Record {
                    source,
                    id,
                    dir: dir.to_string_lossy().into_owned(),
                    raw: String::from_utf8_lossy(&raw).into_owned(),
                });
            }
        }
    }
    rows
}
fn records<'a>(p: L<'a>, raw: Vec<Record>) -> Result<L<'a>> {
    let out = array(p)?;
    for r in raw {
        push(
            out,
            fields(
                p,
                &[
                    ("id", text(p, &r.id)?),
                    ("dir", text(p, &r.dir)?),
                    ("source", text(p, r.source)?),
                    ("raw", text(p, &r.raw)?),
                ],
            )?,
        )?;
    }
    Ok(out)
}
fn render<'a>(o: L<'a>, rows: L<'a>) -> Result<L<'a>> {
    let p = o.get(c"ports")?;
    let platform = o.get(c"platform")?;
    let arch = o.get(c"arch")?;
    let mut seen = HashSet::new();
    let plugins = array(o)?;
    let conflicts = array(o)?;
    for row in items(rows)? {
        let id = row.get(c"id")?;
        let found = parse_manifest(p, row.get(c"dir")?, id, &fold_string(row.get(c"raw")?)?)?;
        let item = build_entry(p, found, id, platform, arch, row.get(c"source")?)?;
        if !item.truthy()? {
            continue;
        }
        if seen.insert(fold_string(id)?) {
            push(plugins, item)?
        } else {
            push(conflicts, id)?
        }
    }
    fields(o, &[("plugins", plugins), ("conflicts", conflicts)])
}
pub(super) fn scan(o: L<'_>) -> Result<L<'_>> {
    render(o, records(o, read_manifests(absolute_roots(o)?))?)
}
pub(super) fn scan_async(o: L<'_>) -> Result<L<'_>> {
    use napi::bindgen_prelude::{JsValue as _, ToNapiValue};
    let roots = absolute_roots(o)?;
    let env = crate::host_methods::env(o);
    let task = env.spawn_future_with_callback(
        async move {
            tokio::task::spawn_blocking(move || read_manifests(roots))
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))
        },
        |env, rows| Ok(records(L::new(env, ().into_unknown(env)?), rows)?.raw()),
    )?;
    then(L::from_raw(o.env(), task.raw()), o, |o, a| render(o, a[0]))
}
pub(super) fn residents(o: L<'_>) -> Result<L<'_>> {
    let out = array(o)?;
    for item in items(scan(o)?.get(c"plugins")?)? {
        if !item.get(c"resident")?.truthy()? {
            continue;
        }
        let found = find(o, item.get(c"id")?)?;
        item.set(
            c"dir",
            if found.truthy()? {
                found.get(c"dir")?
            } else {
                found
            },
        )?;
        item.set(
            c"binary",
            if found.truthy()? {
                binary(
                    o.get(c"ports")?,
                    found,
                    o.get(c"platform")?,
                    o.get(c"arch")?,
                )?
            } else {
                null(o)?
            },
        )?;
        push(out, item)?;
    }
    Ok(out)
}
