use super::*;
use multicc_core::provider_registry::{
    NATIVE_OPENCODE_ID_PATTERN, NATIVE_VENDOR_SUFFIX, VENDOR_NATIVE_CLIS,
};

fn strings<'a>(p: L<'a>, items: &[&str]) -> Result<L<'a>> {
    let out = array(p)?;
    for (i, s) in items.iter().enumerate() {
        out.set_element(i as u32, text(p, s)?)?;
    }
    out.freeze()
}
fn line_id(cli: L<'_>) -> Result<L<'_>> {
    concat(cli, &[cli, text(cli, NATIVE_VENDOR_SUFFIX)?, cli])
}
fn parse<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let value = empty_if_null(input)?;
    let at = call(value, c"indexOf", &[text(p, NATIVE_VENDOR_SUFFIX)?])?.number()?;
    if at <= 0. {
        return null(p);
    }
    let cli = call(value, c"slice", &[num(p, 0.)?, num(p, at)?])?;
    if !call(p.get(c"members")?, c"has", &[cli])?.truthy()? {
        return null(p);
    }
    let id = call(
        value,
        c"slice",
        &[num(p, at + NATIVE_VENDOR_SUFFIX.len() as f64)?],
    )?;
    fields(p, &[("cli", cli), ("id", id)])?.freeze()
}
fn ids(entries: L<'_>) -> Result<L<'_>> {
    let p = entries;
    let rows = if entries.is_array()? {
        entries
    } else {
        array(p)?
    };
    let models = call(
        rows,
        c"map",
        &[function(p, "", 1, 1, |_, a| {
            if a[0].truthy()? && object(a[0])? {
                a[0].get(c"model")
            } else {
                Ok(a[0])
            }
        })?],
    )?;
    let normalized = call(
        models,
        c"map",
        &[function(p, "", 1, 1, |_, a| a[0].clean_text())?],
    )?;
    let selected = call(normalized, c"filter", &[p.global()?.get(c"Boolean")?])?;
    let unique = p.global()?.get(c"Set")?.construct(&[selected])?;
    let out = array(p)?;
    unique.for_each(|v| {
        call(out, c"push", &[v])?;
        Ok(())
    })?;
    Ok(out)
}
fn models<'a>(p: L<'a>, cli: L<'a>) -> Result<L<'a>> {
    if let Some(rows) = p
        .catch(|| -> Result<Option<L<'a>>> {
            let name = if cli.is_string("commandcode")? {
                c"peekCommandcodeModels"
            } else if cli.is_string("qoder")? {
                c"peekQoderModels"
            } else if cli.is_string("codebuddy")? {
                c"peekCodebuddyModels"
            } else if cli.is_string("grok")? {
                c"peekGrokModels"
            } else if cli.is_string("agy")? {
                return Ok(Some(ids(call(p, c"peekAgyModels", &[])?)?));
            } else {
                return Ok(None);
            };
            Ok(Some(ids(call(
                call(p, c"getVendorCatalog", &[cli])?,
                name,
                &[],
            )?)?))
        })?
        .flatten()
    {
        return Ok(rows);
    }
    for (key, store) in [("dsh", c"dsh"), ("gemini", c"gemini")] {
        if cli.is_string(key)? {
            return call(p.get(store)?, c"slice", &[]);
        }
    }
    array(p)
}
fn synth<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cli = a[0];
    let options = ids(if a[1].undefined()? {
        models(p, cli)?
    } else {
        a[1]
    })?;
    let id = line_id(cli)?;
    let name = call(p, c"displayNameOf", &[cli])?;
    fields(
        p,
        &[
            ("id", id),
            ("name", name),
            ("nativeVendor", flag(p, true)?),
            ("nativeCommandCode", flag(p, cli.is_string("commandcode")?)?),
            ("nativeProvider", cli),
            ("appType", cli),
            ("model", fallback(options.element(0)?, V::Null)?),
            ("modelOptions", options.freeze()?),
        ],
    )?
    .freeze()
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let dsh = strings(p, &["deepseek-v4-flash", "deepseek-v4-pro"])?;
    let gemini = strings(p, &["gemini-2.5-pro", "gemini-2.5-flash"])?;
    let clis = strings(p, &VENDOR_NATIVE_CLIS)?;
    let members = p.global()?.get(c"Set")?.construct(&[clis])?;
    p.set(c"dsh", dsh)?;
    p.set(c"gemini", gemini)?;
    p.set(c"members", members)?;
    let regex = p.global()?.get(c"RegExp")?;
    let out = fields(
        p,
        &[
            ("DSH_MODELS", dsh),
            ("GEMINI_MODELS", gemini),
            (
                "MODEL_ID",
                regex.construct(&[text(
                    p,
                    r"^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,118}[A-Za-z0-9._/-]$",
                )?])?,
            ),
            (
                "NATIVE_VENDOR_ID",
                regex.construct(&[text(p, NATIVE_OPENCODE_ID_PATTERN)?, text(p, "i")?])?,
            ),
            ("NATIVE_VENDOR_SUFFIX", text(p, NATIVE_VENDOR_SUFFIX)?),
            ("VENDOR_NATIVE_CLIS", clis),
            ("VENDOR_NATIVE_SET", members),
        ],
    )?;
    let methods = methods(
        p,
        &[
            ("isVendorNative", 1, |p, a| {
                flag(p, !parse(p, a[0])?.nullish()?)
            }),
            ("nativeVendorLineId", 1, |_, a| line_id(a[0])),
            ("nativeVendorModels", 1, |p, a| models(p, a[0])),
            ("nativeVendorName", 1, |p, a| {
                call(p, c"displayNameOf", &[a[0]])
            }),
            ("nativeVendorOf", 1, |p, a| parse(p, a[0])),
        ],
    )?;
    out.spread_from(methods)?;
    out.set(
        c"syntheticVendorProvider",
        function(p, "syntheticVendorProvider", 1, 2, synth)?,
    )?;
    Ok(out)
}
