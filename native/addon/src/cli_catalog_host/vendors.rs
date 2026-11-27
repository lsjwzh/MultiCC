//! Each vendor owns one live cache. Parse jobs publish in child completion order.
use super::*;
pub(super) struct Spec {
    pub parse: &'static str,
    pub peek: &'static str,
    pub list: &'static str,
    pub fallback: &'static str,
    pub bin: &'static str,
    pub arg: &'static str,
    pub timeout: f64,
    pub buffer: f64,
}
pub(super) fn spec(cli: &str) -> Option<Spec> {
    let (parse, peek, list, fallback, bin, arg, timeout, buffer) = match cli {
        "qoder" => (
            "parseQoderStdout",
            "peekQoderModels",
            "listQoderModels",
            "QODER_TIER_FALLBACK",
            "qoderclicn",
            "--list-models",
            15000.0,
            262144.0,
        ),
        "grok" => (
            "parseGrokModels",
            "peekGrokModels",
            "listGrokModels",
            "GROK_MODEL_FALLBACK",
            "grok",
            "models",
            10000.0,
            1048576.0,
        ),
        "codebuddy" => (
            "parseCodebuddyHelp",
            "peekCodebuddyModels",
            "listCodebuddyModels",
            "CODEBUDDY_MODEL_FALLBACK",
            "codebuddy",
            "--help",
            10000.0,
            1048576.0,
        ),
        "commandcode" => (
            "parseCommandcodeList",
            "peekCommandcodeModels",
            "listCommandcodeModels",
            "COMMANDCODE_MODEL_FALLBACK",
            "commandcode",
            "--list-models",
            20000.0,
            2097152.0,
        ),
        _ => return None,
    };
    Some(Spec {
        parse,
        peek,
        list,
        fallback,
        bin,
        arg,
        timeout,
        buffer,
    })
}
pub(super) fn catalog<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let key = fold_string(id)?;
    let catalog = p.get(c"catalogs")?;
    if call(catalog, c"has", &[id])?.truthy()? {
        return call(catalog, c"get", &[id]);
    }
    let spec = spec(&key).ok_or_else(|| p.type_error("unknown CLI model catalog"))?;
    let native = p.get(c"VendorCatalog")?.construct(&[id])?;
    let fallback = call(native, c"defaults", &[])?;
    let timeout = truthy_or(
        process_env(p)?.get_key(text(
            p,
            &format!("{}_MODELS_TIMEOUT_MS", key.to_uppercase()),
        )?)?,
        num(p, spec.timeout)?,
    )?
    .number()?;
    let s = fields(
        p,
        &[
            ("owner", p),
            ("id", id),
            ("native", native),
            ("fallback", fallback),
            ("cache", null(p)?),
            ("timeout", num(p, timeout)?),
            ("buffer", num(p, spec.buffer)?),
            ("bin", text(p, spec.bin)?),
            ("arg", text(p, spec.arg)?),
            ("published", resolved(undef(p)?)?),
        ],
    )?;
    let api = methods(
        s,
        &[
            ("_setCacheForTest", 2, test_cache),
            ("_resetCacheForTest", 0, reset_cache),
        ],
    )?;
    reg(api, s, spec.parse, 1, 1, |s, a| {
        call(s.get(c"native")?, c"parse", &[a[0]])
    })?;
    reg(api, s, spec.peek, 0, 0, |s, _| {
        call(s.get(c"native")?, c"peek", &[s])
    })?;
    reg(api, s, spec.list, 1, 2, list)?;
    api.define_key(text(p, spec.fallback)?, fallback)?;
    call(catalog, c"set", &[id, api])?;
    Ok(api)
}
fn child_finished<'a>(op: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = op.get(c"state")?;
    op.set(c"error", a[0])?;
    op.set(c"stdout", a[1])?;
    let result = then(s.get(c"published")?, op, |op, _| {
        let s = op.get(c"state")?;
        let n = s.get(c"native")?;
        if op.get(c"error")?.truthy()? {
            return call(n, c"finish", &[s, null(s)?]);
        }
        let listing = call(n, c"readListing", &[op.get(c"stdout")?])?;
        then(listing, s, |s, a| {
            call(s.get(c"native")?, c"finish", &[s, a[0]])
        })
    })?;
    let noop = function(s, "", 0, 0, |s, _| undef(s))?;
    s.set(c"published", call(result, c"then", &[noop, noop])?)?;
    let cb = op.get(c"cb")?;
    let ok = function(cb, "", 1, 1, |cb, a| {
        next_tick(cb, &[null(cb)?, a[0].get(c"models")?, a[0].get(c"source")?])
    })?;
    let fail = function(cb, "", 1, 1, |cb, a| next_tick(cb, &[a[0]]))?;
    call(result, c"then", &[ok, fail])?;
    undef(op)
}
fn list<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cb = a[0];
    let opts = default_object(a[1])?;
    let owner = s.get(c"owner")?;
    if !opts.get(c"refresh")?.truthy()? && call(s.get(c"native")?, c"isFresh", &[s])?.truthy()? {
        return immediate_cache(s, cb);
    }
    let id = s.get(c"id")?;
    let resolved = s
        .catch(|| call(owner, c"resolveCliCommands", &[])?.get_key(id))?
        .unwrap_or(undef(s)?);
    let bin = if resolved.string()?.is_some() && resolved.truthy()? {
        resolved
    } else {
        s.get(c"bin")?
    };
    let options = fields(
        s,
        &[
            ("timeout", s.get(c"timeout")?),
            ("maxBuffer", s.get(c"buffer")?),
        ],
    )?;
    if id.is_string("qoder")? {
        options.set(c"windowsHide", flag(s, true)?)?;
    }
    let args = array(s)?;
    args.set_element(0, s.get(c"arg")?)?;
    let op = fields(s, &[("state", s), ("cb", cb)])?;
    call(
        owner,
        c"execFile",
        &[bin, args, options, function(op, "", 2, 2, child_finished)?],
    )?;
    undef(s)
}
