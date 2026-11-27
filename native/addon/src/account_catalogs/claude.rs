use super::*;
use multicc_core::{
    claude_models::{fallback_models, CACHE_FILE_NAME},
    js::json_parse,
};
use std::{fs, path::Path, time::UNIX_EPOCH};

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let rows = V::Array(
        fallback_models()
            .into_iter()
            .map(|r| {
                V::object(vec![
                    ("model", V::string(&r.model)),
                    ("label", V::string(&r.label)),
                ])
            })
            .collect(),
    );
    let list = p.from_value(&rows)?.freeze()?;
    let o = fields(p, &[("root", p.get(c"root")?), ("fallback", list)])?;
    let api = methods(
        o,
        &[
            ("listClaudeModelsSync", 0, models),
            ("_resetCacheForTest", 0, reset),
        ],
    )?;
    api.set(c"CLAUDE_MODELS_FALLBACK", list)?;
    api.set(c"CACHE_FILE_NAME", text(p, CACHE_FILE_NAME)?)?;
    Ok(api)
}
fn reset<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    o.set(c"lastRoot", undef(o)?)?;
    o.set(c"memo", null(o)?)?;
    undef(o)
}
fn ids(o: L<'_>) -> Result<L<'_>> {
    call(
        o.get(c"fallback")?,
        c"map",
        &[function(o, "model", 1, 1, |_, a| a[0].get(c"model"))?],
    )
}
fn models<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let hit = o.catch(|| {
        let root = plain(o, c"root", &[])?;
        if !o.get(c"lastRoot")?.equals(root)? {
            o.set(c"lastRoot", root)?;
            o.set(c"memo", null(o)?)?;
        }
        let path = Path::new(&fold_string(root)?).join(CACHE_FILE_NAME);
        let stat = fs::metadata(&path)?;
        let modified = stat.modified()?;
        // Node returns a floating point millisecond timestamp; keep its
        // precision, including for files dated before 1970.
        let ms = match modified.duration_since(UNIX_EPOCH) {
            Ok(t) => t.as_secs() as f64 * 1000. + f64::from(t.subsec_nanos()) / 1e6,
            Err(e) => {
                let t = e.duration();
                -(t.as_secs() as f64 * 1000. + f64::from(t.subsec_nanos()) / 1e6)
            }
        };
        let size = stat.len() as f64;
        let memo = o.get(c"memo")?;
        if memo.truthy()?
            && memo.get(c"mtime")?.is_number(ms)?
            && memo.get(c"size")?.is_number(size)?
        {
            return memo.get(c"models");
        }
        let bytes = fs::read(&path)?;
        let doc = json_parse(&String::from_utf8_lossy(&bytes))
            .map_err(|_| napi::Error::from_reason("invalid model cache"))?;
        let out = match doc.get("models") {
            Some(V::Array(rows)) => rows
                .iter()
                .filter_map(|r| match r.get("model") {
                    Some(V::String(s)) if !s.is_empty() => Some(V::String(s.clone())),
                    _ => None,
                })
                .collect(),
            _ => vec![],
        };
        let models = o.from_value(&V::Array(out))?;
        o.set(
            c"memo",
            fields(
                o,
                &[
                    ("mtime", num(o, ms)?),
                    ("size", num(o, size)?),
                    ("models", models),
                ],
            )?,
        )?;
        Ok(models)
    })?;
    if let Some(hit) = hit {
        if hit.get(c"length")?.truthy()? {
            return Ok(hit);
        }
    }
    ids(o)
}
