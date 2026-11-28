use super::*;
use crate::host_methods::raw;
use napi::bindgen_prelude::{AsyncTask, ToNapiValue};
use std::collections::HashSet;

const DIRECTORIES: &[(&str, &[&str])] = &[
    ("ProgramFiles", &["Git", "cmd"]),
    ("ProgramFiles(x86)", &["Git", "cmd"]),
    ("LOCALAPPDATA", &["Programs", "Git", "cmd"]),
    ("USERPROFILE", &["scoop", "shims"]),
    ("ProgramData", &["chocolatey", "bin"]),
    ("APPDATA", &["npm"]),
    ("LOCALAPPDATA", &["npm"]),
    ("ProgramFiles", &["nodejs"]),
    ("USERPROFILE", &[".local", "bin"]),
    ("LOCALAPPDATA", &["agy", "bin"]),
    ("USERPROFILE", &[".opencode", "bin"]),
    ("USERPROFILE", &[".bun", "bin"]),
    ("LOCALAPPDATA", &["Programs", "claude"]),
    ("LOCALAPPDATA", &["Microsoft", "WindowsApps"]),
];
const REGISTRY: [(&str, &str); 4] = [
    (
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        "Path",
    ),
    (r"HKCU\Environment", "Path"),
    (r"HKLM\SOFTWARE\GitForWindows", "InstallPath"),
    (r"HKCU\SOFTWARE\GitForWindows", "InstallPath"),
];
fn known<'a>(p: L<'a>, env: L<'a>) -> Result<Vec<L<'a>>> {
    let path = p.get(c"host")?.get(c"path")?.get(c"win32")?;
    let props = [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "ProgramData",
    ]
    .into_iter()
    .map(|key| Ok((key, env_value(env, key)?)))
    .collect::<Result<std::collections::HashMap<_, _>>>()?;
    let mut dirs = Vec::new();
    for &(base, parts) in DIRECTORIES {
        let base = props[base];
        if base.kind()? != sys::ValueType::napi_string || !base.truthy()? {
            continue;
        }
        let mut args = vec![base];
        for part in parts {
            args.push(text(p, part)?)
        }
        dirs.push(call(path, c"join", &args)?);
    }
    Ok(dirs)
}
fn entry_key(s: JsString) -> JsString {
    let s = normalized(s);
    let mut end = s.len();
    while end > 0 && matches!(s.as_units()[end - 1], 47 | 92) {
        end -= 1
    }
    s.truncate_units(end).to_lowercase()
}
fn current(env: L<'_>) -> Result<JsString> {
    string_or_empty(env_value(env, "PATH")?)
}
fn write_path<'a>(env: L<'a>, value: L<'a>) -> Result<()> {
    let key = own_key(env, "PATH", false)?.unwrap_or(text(env, "PATH")?);
    env.set_key(key, value)
}
fn bump(p: L<'_>) -> Result<()> {
    p.set(c"revision", num(p, p.get(c"revision")?.number()? + 1.)?)
}
pub(super) fn reset(p: L<'_>) -> Result<L<'_>> {
    for key in [c"revision", c"lastScanAt", c"lastRefreshAt"] {
        p.set(key, num(p, 0.)?)?
    }
    p.set(c"inFlight", null(p)?)?;
    p.set(c"discovered", fields(p, &[])?)?;
    undef(p)
}
fn augment<'a>(p: L<'a>, environment: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let fs = default(opts.get(c"fsImpl")?, || p.get(c"host")?.get(c"fs"))?;
    let windows = default(opts.get(c"windows")?, || win(p))?;
    let now = default(opts.get(c"now")?, || p.global()?.get(c"Date")?.get(c"now"))?;
    let force = opts.get(c"force")?;
    if !windows.truthy()? {
        return flag(p, false);
    }
    let time = now.call_plain(&[])?;
    if !force.truthy()? && time.number()? - p.get(c"lastScanAt")?.number()? < 2000. {
        return flag(p, false);
    }
    p.set(c"lastScanAt", time)?;
    let mut base = current(environment)?;
    let mut seen: HashSet<JsString> = base
        .as_units()
        .split(|u| *u == 59)
        .map(|v| entry_key(v.to_vec().into()))
        .collect();
    let mut additions = Vec::new();
    for dir in known(p, environment)? {
        let key = entry_key(dir.coerce_string()?);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        if !p
            .catch(|| call(call(fs, c"statSync", &[dir])?, c"isDirectory", &[])?.truthy())?
            .unwrap_or(false)
        {
            continue;
        }
        seen.insert(key);
        additions.push(dir.coerce_string()?);
    }
    if additions.is_empty() {
        return flag(p, false);
    }
    if !base.is_empty() && base.as_units().last() != Some(&59) {
        base.push_str(";")
    }
    base.push(&JsString::join(&additions, &";".into()));
    write_path(environment, units(p, base)?)?;
    bump(p)?;
    flag(p, true)
}
fn expand<'a>(value: L<'a>, environment: L<'a>) -> Result<JsString> {
    let raw = string_or_empty(value)?;
    let mut out = JsString::new();
    let mut rest = raw.as_units();
    while let Some(i) = rest.iter().position(|&u| u == 37) {
        out.push(&rest[..i].to_vec().into());
        rest = &rest[i..];
        let Some(j) = rest[1..].iter().position(|&u| u == 37).map(|i| i + 1) else {
            break;
        };
        if j == 1 {
            out.push_unit(37);
            rest = &rest[1..];
            continue;
        }
        let name = JsString::from_units(rest[1..j].to_vec()).trim();
        let v = env_value(environment, &name.to_string_lossy())?;
        if v.nullish()? {
            out.push(&rest[..=j].to_vec().into())
        } else {
            out.push(&string(v)?.coerce_string()?)
        }
        rest = &rest[j + 1..];
    }
    out.push(&rest.to_vec().into());
    Ok(out)
}
fn merge<'a>(base: L<'a>, values: L<'a>, environment: L<'a>) -> Result<L<'a>> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    let mut push = |s: JsString| {
        for raw in s.as_units().split(|u| *u == 59) {
            let entry = normalized(raw.to_vec().into());
            let key = entry_key(entry.clone());
            if !key.is_empty() && seen.insert(key) {
                entries.push(entry)
            }
        }
    };
    push(string_or_empty(base)?);
    values.for_each(|v| {
        push(expand(v, environment)?);
        Ok(())
    })?;
    units(base, JsString::join(&entries, &";".into()))
}
fn parse<'a>(p: L<'a>, stdout: L<'a>, name: L<'a>) -> Result<L<'a>> {
    let regex = p.global()?.get(c"RegExp")?.construct(&[
        text(p, r"^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s*(.*)$")?,
        text(p, "i")?,
    ])?;
    for line in string_or_empty(stdout)?.as_units().split(|&u| u == 10) {
        let line = line.strip_suffix(&[13]).unwrap_or(line);
        let m = call(regex, c"exec", &[units(p, line.to_vec().into())?])?;
        if m.truthy()?
            && m.element(1)?.coerce_string()?.to_lowercase() == name.coerce_string()?.to_lowercase()
        {
            return units(p, m.element(2)?.coerce_string()?.trim());
        }
    }
    null(p)
}
fn read_key<'a>(p: L<'a>, run: L<'a>, exe: L<'a>, key: &str, name: &str) -> Result<L<'a>> {
    let ctx = fields(
        p,
        &[
            ("run", run),
            ("exe", exe),
            ("key", text(p, key)?),
            ("name", text(p, name)?),
        ],
    )?;
    let executor = function(ctx, "", 1, 1, |ctx, a| {
        ctx.set(c"resolve", a[0])?;
        let callback = function(ctx, "", 2, 2, |ctx, r| {
            let value = if r[0].truthy()? {
                null(ctx)?
            } else {
                parse(ctx, r[1], ctx.get(c"name")?)?
            };
            ctx.get(c"resolve")?.call_plain(&[value])
        })?;
        let args = list(
            ctx,
            &[
                text(ctx, "query")?,
                ctx.get(c"key")?,
                text(ctx, "/v")?,
                ctx.get(c"name")?,
            ],
        )?;
        let opts = fields(
            ctx,
            &[
                ("timeout", num(ctx, 5000.)?),
                ("windowsHide", flag(ctx, true)?),
            ],
        )?;
        if ctx
            .catch(|| {
                ctx.get(c"run")?
                    .call_plain(&[ctx.get(c"exe")?, args, opts, callback])
            })?
            .is_none()
        {
            ctx.get(c"resolve")?.call_plain(&[null(ctx)?])?;
        }
        undef(ctx)
    })?;
    p.global()?.get(c"Promise")?.construct(&[executor])
}
fn discover<'a>(ctx: L<'a>, results: L<'a>) -> Result<L<'a>> {
    ctx.set(c"results", results)?;
    let result = async_result(ctx, || {
        let environment = ctx.get(c"environment")?;
        let local = env_value(environment, "LOCALAPPDATA")?;
        let mut paths = vec![];
        let git_roots = results.element(1)?;
        for i in [0, 1] {
            let v = git_roots.element(i)?;
            if v.truthy()? {
                paths.push(units(ctx, expand(v, environment)?)?)
            }
        }
        let input = fields(
            ctx,
            &[
                ("localAppData", local),
                ("gitInstallPaths", list(ctx, &paths)?),
            ],
        )?;
        let custom = ctx.get(c"discover")?;
        if !custom.undefined()? {
            return custom.call_plain(&[input]);
        }
        let json = json_call(ctx, c"stringify", input)?
            .coerce_string()?
            .to_string_lossy();
        let task = crate::windows_tools::windows_tools_discover(json);
        let handle = unsafe { AsyncTask::to_napi_value(ctx.env(), task)? };
        then(raw(ctx, handle), ctx, |p, a| json_call(p, c"parse", a[0]))
    })?;
    let tools = recover(result, ctx, |p, _| null(p))?;
    then(tools, ctx, finish)
}
fn finish<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"owner")?;
    let env = ctx.get(c"environment")?;
    let tools = a[0];
    if tools.truthy()? {
        p.set(
            c"discovered",
            fields(p, &[("codex", fallback(tools.get(c"codex")?, V::Null)?)])?,
        )?
    }
    p.set(c"lastRefreshAt", ctx.get(c"now")?.call_plain(&[])?)?;
    let base = units(p, current(env)?)?;
    let registry_paths = ctx.get(c"results")?.element(0)?;
    let mut values = vec![registry_paths.element(0)?, registry_paths.element(1)?];
    let dirs = tools.optional(c"pathDirs")?;
    if dirs.truthy()? {
        dirs.for_each(|v| {
            values.push(v);
            Ok(())
        })?
    }
    let merged = merge(base, list(p, &values)?, env)?;
    if merged.truthy()? && !merged.equals(base)? {
        write_path(env, merged)?
    }
    bump(p)?;
    let updated = units(p, current(env)?)?;
    fields(
        p,
        &[
            ("changed", flag(p, !updated.equals(ctx.get(c"before")?)?)?),
            ("path", updated),
        ],
    )
}
fn refresh<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = default_object(opts)?;
    let env = default(opts.get(c"env")?, || env(p))?;
    let run = default(opts.get(c"run")?, || p.get(c"readRegistry"))?;
    let windows = default(opts.get(c"windows")?, || win(p))?;
    let force = opts.get(c"force")?;
    let max = default(opts.get(c"maxAgeMs")?, || num(p, 15000.))?;
    let now = default(opts.get(c"now")?, || p.global()?.get(c"Date")?.get(c"now"))?;
    let fs = default(opts.get(c"fsImpl")?, || p.get(c"host")?.get(c"fs"))?;
    let discovery = opts.get(c"discover")?;
    if !windows.truthy()? {
        if force.truthy()? {
            bump(p)?
        }
        return resolved(fields(
            p,
            &[("changed", flag(p, false)?), ("supported", flag(p, false)?)],
        )?);
    }
    let flight = p.get(c"inFlight")?;
    if flight.truthy()? {
        return Ok(flight);
    }
    let time = now.call_plain(&[])?;
    if !force.truthy()? && time.number()? - p.get(c"lastRefreshAt")?.number()? < max.number()? {
        return resolved(fields(
            p,
            &[
                ("changed", flag(p, false)?),
                ("cached", flag(p, true)?),
                ("path", units(p, current(env)?)?),
            ],
        )?);
    }
    let start = async_result(p, || {
        let before = units(p, current(env)?)?;
        augment(
            p,
            env,
            fields(
                p,
                &[
                    ("windows", windows),
                    ("fsImpl", fs),
                    ("now", now),
                    ("force", flag(p, true)?),
                ],
            )?,
        )?;
        let root = or(env_value(env, "SystemRoot")?, || {
            or(env_value(env, "windir")?, || text(p, r"C:\Windows"))
        })?;
        let path = p.get(c"host")?.get(c"path")?.get(c"win32")?;
        let exe = call(
            path,
            c"join",
            &[root, text(p, "System32")?, text(p, "reg.exe")?],
        )?;
        let promise = p.global()?.get(c"Promise")?;
        let mut groups = Vec::new();
        // PATH and Git install roots each settle as a pair. Start all four
        // registry queries synchronously before waiting for either group.
        for group in REGISTRY.chunks_exact(2) {
            let mut queries = Vec::new();
            for &(key, name) in group {
                queries.push(read_key(p, run, exe, key, name)?);
            }
            groups.push(call(promise, c"all", &[list(p, &queries)?])?);
        }
        let all = call(promise, c"all", &[list(p, &groups)?])?;
        let ctx = fields(
            p,
            &[
                ("owner", p),
                ("environment", env),
                ("now", now),
                ("before", before),
                ("discover", discovery),
            ],
        )?;
        then(all, ctx, |ctx, a| discover(ctx, a[0]))
    })?;
    let cleanup = function(p, "", 0, 0, |p, _| {
        p.set(c"inFlight", null(p)?)?;
        undef(p)
    })?;
    let task = call(start, c"finally", &[cleanup])?;
    p.set(c"inFlight", task)?;
    Ok(task)
}
fn schedule<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    recover(refresh(p, opts)?, p, |p, _| {
        fields(p, &[("changed", flag(p, false)?)])
    })
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let child = p.get(c"host")?.get(c"childProcess")?;
    p.set(c"readRegistry", child.get(c"execFile")?)?;
    defaulted_methods(
        p,
        &[
            ("augmentPath", 0, 2, |p, a| {
                augment(p, default(a[0], || env(p))?, default_object(a[1])?)
            }),
            ("knownDirs", 0, 1, |p, a| {
                list(p, &known(p, default(a[0], || env(p))?)?)
            }),
            ("mergePath", 3, 3, |_, a| merge(a[0], a[1], a[2])),
            ("parseRegistryPath", 1, 1, |p, a| {
                parse(p, a[0], text(p, "Path")?)
            }),
            ("prepare", 0, 2, |p, a| {
                let env = default(a[0], || env(p))?;
                let opts = default_object(a[1])?;
                augment(p, env, opts)?;
                let all = fields(p, &[("env", env)])?;
                all.spread_from(opts)?;
                schedule(p, all)
            }),
            ("refresh", 0, 1, |p, a| refresh(p, a[0])),
            ("scheduleRefresh", 1, 1, |p, a| schedule(p, a[0])),
            ("version", 0, 0, |p, _| p.get(c"revision")),
            ("command", 1, 2, |p, a| {
                if default(a[1], || env(p))?.equals(env(p)?)? {
                    fallback(p.get(c"discovered")?.get_key(a[0])?, V::Null)
                } else {
                    null(p)
                }
            }),
            ("_resetForTests", 0, 0, |p, _| reset(p)),
        ],
    )
}
