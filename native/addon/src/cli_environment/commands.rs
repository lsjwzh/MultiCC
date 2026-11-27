use super::*;
use crate::host_methods::{arg, env as napi_env, raw};
use std::{collections::HashSet, ffi::CStr};

struct Context<'a> {
    owner: L<'a>,
    windows: L<'a>,
    env: L<'a>,
    fs: L<'a>,
    home: L<'a>,
    logger: L<'a>,
    path: L<'a>,
}
impl<'a> Context<'a> {
    fn new(p: L<'a>, opts: L<'a>) -> Result<Self> {
        let windows = opts.get(c"isWindows")?;
        let windows = if windows.nullish()? { win(p)? } else { windows };
        if windows.truthy()? && !opts.get(c"env")?.truthy()? {
            call(p.get(c"windows")?, c"augmentPath", &[env(p)?])?;
        }
        let host = p.get(c"host")?;
        Ok(Self {
            owner: p,
            windows,
            env: or(opts.get(c"env")?, || env(p))?,
            fs: or(opts.get(c"fsImpl")?, || host.get(c"fs"))?,
            home: or(opts.get(c"homeDir")?, || {
                host.get(c"homedir")?.call_plain(&[])
            })?,
            logger: or(opts.get(c"logger")?, || p.global()?.get(c"console"))?,
            path: host.get(c"path")?,
        })
    }
    fn on_windows(&self) -> Result<bool> {
        self.windows.truthy()
    }
    fn runnable(&self, file: L<'a>) -> Result<bool> {
        runnable(self.owner, self.fs, file, self.on_windows()?)
    }
    fn lookup(&self, name: &str) -> Result<Option<L<'a>>> {
        find(
            self.owner,
            self.path,
            self.fs,
            self.env,
            self.on_windows()?,
            text(self.owner, name)?,
        )
    }
    fn path_at(&self, template: &str) -> Result<L<'a>> {
        if let Some(relative) = template.strip_prefix("~/") {
            call(
                self.path,
                c"join",
                &[self.home, text(self.owner, relative)?],
            )
        } else {
            text(self.owner, template)
        }
    }
    fn paths(&self, names: &[&str]) -> Result<Vec<L<'a>>> {
        names.iter().map(|s| self.path_at(s)).collect()
    }
    fn fallback(&self, binary: &str, extension: &str) -> Result<L<'a>> {
        if self.on_windows()? {
            text(self.owner, &format!("{binary}.{extension}"))
        } else {
            text(self.owner, binary)
        }
    }
    fn discovered(
        &self,
        name: &str,
        ext: &str,
        paths: &[L<'a>],
        alias: Option<&str>,
    ) -> Result<L<'a>> {
        for f in paths {
            if self.runnable(*f)? {
                return Ok(*f);
            }
        }
        if let Some(v) = self.lookup(name)? {
            return Ok(v);
        }
        if let Some(alias) = alias {
            if let Some(v) = self.lookup(alias)? {
                return Ok(v);
            }
        }
        self.fallback(name, ext)
    }
    fn log(&self, level: &CStr, parts: &[L<'a>]) -> Result<()> {
        let mut s = JsString::new();
        for x in parts {
            s.push(&x.coerce_string()?);
        }
        call(self.logger, level, &[units(self.owner, s)?])?;
        Ok(())
    }
}
fn runnable<'a>(p: L<'a>, fs: L<'a>, file: L<'a>, windows: bool) -> Result<bool> {
    if !file.truthy()? {
        return Ok(false);
    }
    Ok(p.catch(|| -> Result<bool> {
        let stat = call(fs, c"statSync", &[file])?;
        if !call(stat, c"isFile", &[])?.truthy()? {
            return Ok(false);
        }
        // F_OK and X_OK are the constants on Node's fs module, independent of
        // whether the caller supplied a virtual filesystem.
        let constants = p.get(c"host")?.get(c"fs")?.get(c"constants")?;
        call(
            fs,
            c"accessSync",
            &[
                file,
                constants.get(if windows { c"F_OK" } else { c"X_OK" })?,
            ],
        )?;
        Ok(true)
    })?
    .unwrap_or(false))
}
fn names<'a>(p: L<'a>, name: L<'a>, windows: bool, env: L<'a>) -> Result<Vec<L<'a>>> {
    if !windows {
        return Ok(vec![name]);
    }
    let exts = string(or(env_value(env, "PATHEXT")?, || {
        text(p, ".COM;.EXE;.BAT;.CMD")
    })?)?
    .coerce_string()?;
    let mut extensions = Vec::new();
    for v in exts.as_units().split(|u| *u == 59) {
        let s = JsString::from_units(v.to_vec()).trim();
        if s.is_empty() {
            continue;
        }
        if s.as_units()[0] == 46 {
            extensions.push(s)
        } else {
            let mut ext = JsString::from(".");
            ext.push(&s);
            extensions.push(ext)
        }
    }
    let lower = call(name, c"toLowerCase", &[])?.coerce_string()?;
    if extensions
        .iter()
        .any(|e| lower.as_units().ends_with(e.to_lowercase().as_units()))
    {
        return Ok(vec![name]);
    }
    let base = name.coerce_string()?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for ext in extensions {
        if seen.insert(ext.clone()) {
            let mut s = base.clone();
            s.push(&ext);
            out.push(units(p, s)?)
        }
    }
    Ok(out)
}
fn find<'a>(
    p: L<'a>,
    path: L<'a>,
    fs: L<'a>,
    env: L<'a>,
    windows: bool,
    name: L<'a>,
) -> Result<Option<L<'a>>> {
    if !name.truthy()? {
        return Ok(None);
    }
    let dirs = string_or_empty(env_value(env, "PATH")?)?;
    let names = names(p, name, windows, env)?;
    for dir in dirs
        .as_units()
        .split(|u| *u == if windows { 59 } else { 58 })
    {
        let dir = normalized(dir.to_vec().into());
        if dir.is_empty() {
            continue;
        }
        let dir = units(p, dir)?;
        for name in &names {
            let f = call(path, c"join", &[dir, *name])?;
            if runnable(p, fs, f, windows)? {
                return Ok(Some(f));
            }
        }
    }
    Ok(None)
}
fn find_api<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[1])?;
    let win = default(opts.get(c"isWindows")?, || win(p))?.truthy()?;
    let env = default(opts.get(c"env")?, || env(p))?;
    let host = p.get(c"host")?;
    let fs = default(opts.get(c"fsImpl")?, || host.get(c"fs"))?;
    Ok(find(p, host.get(c"path")?, fs, env, win, a[0])?.unwrap_or(null(p)?))
}
fn stem(v: L<'_>) -> Result<L<'_>> {
    let re = v
        .global()?
        .get(c"RegExp")?
        .construct(&[text(v, r"\.[^.\\/]+$")?])?;
    call(v, c"replace", &[re, text(v, "")?])
}
fn remote<'a>(p: L<'a>, name: L<'a>, opts: L<'a>) -> Result<bool> {
    if opts.get(c"env")?.truthy()? || opts.get(c"fsImpl")?.truthy()? {
        return Ok(false);
    }
    let host = p.get(c"host")?;
    let tail = call(host.get(c"path")?, c"basename", &[name])?;
    let stem = call(stem(tail)?, c"toLowerCase", &[])?;
    Ok(p.catch(|| -> Result<bool> {
        if stem.is_string("agy")? {
            return accounts::has_remote(p, env(p)?.get(c"HOME")?);
        }
        if stem.is_string("claude")? || stem.is_string("codex")? {
            return call(host, c"hasCliRelayProvider", &[stem])?.truthy();
        }
        Ok(false)
    })?
    .unwrap_or(false))
}
fn available<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[1])?;
    let name = units(p, string_or_empty(args[0])?.trim())?;
    if !name.truthy()? {
        return flag(p, false);
    }
    let ctx = Context::new(p, opts)?;
    let win = ctx.on_windows()?;
    let path = if win {
        ctx.path.get(c"win32")?
    } else {
        ctx.path
    };
    let s = name.coerce_string()?;
    let explicit = call(path, c"isAbsolute", &[name])?.truthy()?
        || s.as_units().contains(&47)
        || win && s.as_units().contains(&92);
    if explicit {
        for f in names(p, name, win, ctx.env)? {
            if ctx.runnable(f)? {
                return flag(p, true);
            }
        }
    } else {
        if find(p, ctx.path, ctx.fs, ctx.env, win, name)?.is_some() {
            return flag(p, true);
        }
        if win {
            let base = stem(name)?;
            if !base.equals(name)? && find(p, ctx.path, ctx.fs, ctx.env, win, base)?.is_some() {
                return flag(p, true);
            }
        }
    }
    flag(p, remote(p, name, opts)?)
}
fn claude<'a>(c: &Context<'a>) -> Result<L<'a>> {
    let p = c.owner;
    if c.env.get(c"CLAUDE_CMD")?.truthy()? {
        c.log(
            c"log",
            &[
                text(p, "[multicc] CLAUDE_CMD override: ")?,
                c.env.get(c"CLAUDE_CMD")?,
            ],
        )?;
        return c.env.get(c"CLAUDE_CMD");
    }
    let mut items = Vec::new();
    for d in c.paths(&[
        "~/.local/bin",
        "~/.local/share/claude/bin",
        "~/.npm-global/bin",
        "~/.npm/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
    ])? {
        items.push(d.coerce_string()?);
    }
    let separator = if c.on_windows()? { 59 } else { 58 };
    let path = string_or_empty(env_value(c.env, "PATH")?)?;
    items.extend(
        path.as_units()
            .split(|u| *u == separator)
            .filter(|v| !v.is_empty())
            .map(|v| JsString::from_units(v.to_vec())),
    );
    let mut seen = HashSet::new();
    items.retain(|d| seen.insert(d.clone()));
    let widened = units(p, JsString::join(&items, &vec![separator].into()))?;
    c.env.assign(c"PATH", widened)?;
    let env = spread(c.env)?;
    env.set(c"PATH", widened)?;
    if let Some(hit) = find(p, c.path, c.fs, env, c.on_windows()?, text(p, "claude")?)? {
        c.log(
            c"log",
            &[text(p, "[multicc] Found claude via PATH: ")?, hit],
        )?;
        return Ok(hit);
    }
    call(
        c.logger,
        c"warn",
        &[text(
            p,
            "[multicc] WARNING: Could not locate claude binary, falling back to \"claude\"",
        )?],
    )?;
    c.fallback("claude", "exe")
}
fn codex<'a>(c: &Context<'a>) -> Result<L<'a>> {
    if c.env.get(c"CODEX_CMD")?.truthy()? {
        let pinned = c.env.get(c"CODEX_CMD")?;
        if !call(c.path, c"isAbsolute", &[pinned])?.truthy()? || c.runnable(pinned)? {
            return Ok(pinned);
        }
        c.log(
            c"warn",
            &[
                text(c.owner, "[multicc] WARNING: CODEX_CMD=")?,
                pinned,
                text(c.owner, " is not runnable, falling back to auto-detection")?,
            ],
        )?;
    }
    if c.on_windows()? {
        let d = call(
            c.owner.get(c"windows")?,
            c"command",
            &[text(c.owner, "codex")?, c.env],
        )?;
        if d.truthy()? && c.runnable(d)? {
            return Ok(d);
        }
    }
    c.discovered(
        "codex",
        "exe",
        &c.paths(&[
            "~/.local/bin/codex",
            "~/.cargo/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ])?,
        None,
    )
}
fn version(s: &str) -> Option<[f64; 3]> {
    // Find the first three dot-separated digit runs; prerelease and build
    // metadata never change the ordering of the release triplet.
    let parts = s.as_bytes();
    let mut i = 0;
    while i < parts.len() {
        if !parts[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let first = i;
        while i < parts.len() && parts[i].is_ascii_digit() {
            i += 1
        }
        let mut start = first;
        let mut end = i;
        let mut out = [0.; 3];
        for n in 0..3 {
            out[n] = s[start..end].parse().ok()?;
            if n == 2 {
                return Some(out);
            }
            if parts.get(end) != Some(&b'.') || !parts.get(end + 1).is_some_and(u8::is_ascii_digit)
            {
                break;
            }
            start = end + 1;
            end = start;
            while end < parts.len() && parts[end].is_ascii_digit() {
                end += 1
            }
        }
    }
    None
}
fn qoder<'a>(c: &Context<'a>) -> Result<L<'a>> {
    let p = c.owner;
    let mut locations = c.paths(&[
        "/opt/homebrew/bin/qoderclicn",
        "/usr/local/bin/qoderclicn",
        "~/.local/bin/qoderclicn",
        "~/.qoder/bin/qoderclicn",
        "~/.qoder-cn/bin/qoderclicn",
        "~/.qodersec/bin/qoderclicn",
    ])?;
    if let Some(hit) = c.lookup("qoderclicn")? {
        let mut duplicate = false;
        for f in &locations {
            if f.equals(hit)? {
                duplicate = true;
                break;
            }
        }
        if !duplicate {
            locations.push(hit)
        }
    }
    let mut candidates = Vec::new();
    for f in locations {
        if c.runnable(f)? {
            candidates.push(f)
        }
    }
    let Some(&first) = candidates.first() else {
        return c.fallback("qoderclicn", "exe");
    };
    let memo = p.get(c"qoder")?;
    let key = call(list(p, &candidates)?, c"join", &[text(p, "\n")?])?;
    if call(memo, c"has", &[key])?.truthy()? {
        return call(memo, c"get", &[key]);
    }
    let mut picked = first;
    let mut highest = None;
    let args = list(p, &[text(p, "--version")?])?;
    let stdio = list(
        p,
        &[text(p, "ignore")?, text(p, "pipe")?, text(p, "ignore")?],
    )?;
    let opts = fields(
        p,
        &[
            ("timeout", num(p, 2000.)?),
            ("encoding", text(p, "utf8")?),
            ("windowsHide", flag(p, true)?),
            ("stdio", stdio),
        ],
    )?;
    for candidate in candidates {
        let Some(stdout) =
            p.catch(|| p.get(c"probeVersion")?.call_plain(&[candidate, args, opts]))?
        else {
            continue;
        };
        if let Some(v) = version(&string_or_empty(stdout)?.to_string_lossy()) {
            if highest.is_none_or(|current| v > current) {
                picked = candidate;
                highest = Some(v)
            }
        }
    }
    call(memo, c"set", &[key, picked])?;
    Ok(picked)
}
fn with_override<'a>(
    ctx: &Context<'a>,
    keys: &[&str],
    discover: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    for key in keys {
        if prop(ctx.env, key)?.truthy()? {
            return prop(ctx.env, key);
        }
    }
    discover()
}

struct Installation {
    binary: &'static str,
    overrides: &'static [&'static str],
    directories: &'static [&'static str],
    alias: Option<&'static str>,
}

impl Installation {
    fn resolve<'a>(&self, ctx: &Context<'a>) -> Result<L<'a>> {
        with_override(ctx, self.overrides, || {
            let mut paths = Vec::new();
            for directory in self.directories {
                paths.push(ctx.path_at(&format!("{directory}/{}", self.binary))?);
            }
            ctx.discovered(self.binary, "exe", &paths, self.alias)
        })
    }
}

const OPENCODE: Installation = Installation {
    binary: "opencode",
    overrides: &["OPENCODE_CMD"],
    directories: &[
        "~/.opencode/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.local/bin",
    ],
    alias: None,
};

const KIMI: Installation = Installation {
    binary: "kimi",
    overrides: &["KIMI_CMD"],
    directories: &[
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.local/bin",
        "~/.npm-global/bin",
        "~/.kimi-code/bin",
    ],
    alias: None,
};

const CODEBUDDY: Installation = Installation {
    binary: "codebuddy",
    overrides: &["CODEBUDDY_CMD", "WORKBUDDY_CMD"],
    directories: &[
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.local/bin",
        "~/.codebuddy/bin",
        "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin",
    ],
    alias: Some("cbc"),
};

const DSH: Installation = Installation {
    binary: "dsh",
    overrides: &["DSH_CMD"],
    directories: &["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"],
    alias: None,
};

fn zcode<'a>(ctx: &Context<'a>) -> Result<L<'a>> {
    let owner = ctx.owner;
    let options = fields(owner, &[("isWindows", ctx.windows), ("homeDir", ctx.home)])?;
    let native_paths = crate::zcode_engine::zcode_engine_candidates(
        napi_env(owner),
        arg(options)?,
        arg(ctx.path)?,
    )?;
    let mut paths = Vec::new();
    raw(owner, native_paths).for_each(|path| {
        paths.push(path);
        Ok(())
    })?;
    paths.extend(ctx.paths(&[
        "/opt/homebrew/bin/zcode",
        "/usr/local/bin/zcode",
        "~/.local/bin/zcode",
        "~/.zcode/bin/zcode",
    ])?);
    ctx.discovered("zcode", "exe", &paths, None)
}

fn agy<'a>(ctx: &Context<'a>) -> Result<L<'a>> {
    let windows = ctx.on_windows()?;
    let file = if windows { "agy.exe" } else { "agy" };
    let mut paths = vec![ctx.path_at(&format!("~/.local/bin/{file}"))?];
    if windows {
        let local = or(ctx.env.get(c"LOCALAPPDATA")?, || {
            ctx.env.get(c"localappdata")
        })?;
        if local.truthy()? {
            paths.push(call(
                ctx.path,
                c"join",
                &[
                    local,
                    text(local, "agy")?,
                    text(local, "bin")?,
                    text(local, file)?,
                ],
            )?);
        }
    } else {
        paths.extend(ctx.paths(&["/opt/homebrew/bin/agy", "/usr/local/bin/agy"])?);
    }
    ctx.discovered("agy", "exe", &paths, None)
}

fn npm_global<'a>(ctx: &Context<'a>, binary: &str, key: &str) -> Result<L<'a>> {
    with_override(ctx, &[key], || {
        let mut paths = Vec::new();
        for directory in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "~/.local/bin",
            "~/.npm-global/bin",
        ] {
            paths.push(ctx.path_at(&format!("{directory}/{binary}"))?);
        }
        ctx.discovered(binary, "cmd", &paths, None)
    })
}

fn lane<'a>(ctx: &Context<'a>, key: &str) -> Result<L<'a>> {
    match key {
        "claude" => claude(ctx),
        "codex" | "codex-exp" => codex(ctx),
        "opencode" => OPENCODE.resolve(ctx),
        "zcode" => with_override(ctx, &["ZCODE_ENGINE", "ZCODE_CMD"], || zcode(ctx)),
        "qoder" => with_override(ctx, &["QODER_CMD", "QODERCN_CMD"], || qoder(ctx)),
        "kimi" => KIMI.resolve(ctx),
        "codebuddy" => CODEBUDDY.resolve(ctx),
        "dsh" => DSH.resolve(ctx),
        "gemini" => npm_global(ctx, "gemini", "GEMINI_CMD"),
        "commandcode" => npm_global(ctx, "command-code", "COMMAND_CODE_CMD"),
        "grok" => npm_global(ctx, "grok", "GROK_CMD"),
        "agy" => with_override(ctx, &["AGY_CMD"], || agy(ctx)),
        "pi" => npm_global(ctx, "pi", "PI_CMD"),
        _ => unreachable!("only the fixed command catalogue calls lane"),
    }
}
fn resolve_commands<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let c = Context::new(p, default_object(args[0])?)?;
    let out = fields(p, &[])?;
    for key in [
        "claude",
        "codex",
        "codex-exp",
        "opencode",
        "zcode",
        "qoder",
        "kimi",
        "codebuddy",
        "dsh",
        "gemini",
        "commandcode",
        "grok",
        "agy",
        "pi",
    ] {
        out.define_key(text(p, key)?, lane(&c, key)?)?;
    }
    Ok(out)
}
fn resolver<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[0])?;
    let windows = default(opts.get(c"isWindows")?, || win(p))?;
    let seed = default(opts.get(c"seed")?, || fields(p, &[]))?;
    let logger = default(opts.get(c"logger")?, || p.get(c"silentLogger"))?;
    let environment = default(opts.get(c"environment")?, || p.get(c"windows"))?;
    let resolve = default(opts.get(c"resolve")?, || {
        p.get(c"commands")?.get(c"resolveCliCommands")
    })?;
    let revision = call(environment, c"version", &[])?;
    let owner = fields(
        p,
        &[
            ("windows", windows),
            ("seed", seed),
            ("logger", logger),
            ("environment", environment),
            ("resolve", resolve),
            ("revision", revision),
        ],
    )?;
    function(owner, "commandsNow", 0, 0, |o, _| {
        let environment = o.get(c"environment")?;
        if o.get(c"windows")?.truthy()? {
            call(environment, c"augmentPath", &[])?;
            call(environment, c"scheduleRefresh", &[])?;
        }
        let latest = call(environment, c"version", &[])?;
        let seed = o.get(c"seed")?;
        if !latest.equals(o.get(c"revision")?)? {
            o.catch(|| {
                let opts = fields(
                    o,
                    &[
                        ("isWindows", o.get(c"windows")?),
                        ("logger", o.get(c"logger")?),
                    ],
                )?;
                let patch = o.get(c"resolve")?.call_plain(&[opts])?;
                call(o.global()?.get(c"Object")?, c"assign", &[seed, patch])?;
                o.set(c"revision", latest)
            })?;
        }
        Ok(seed)
    })
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let child = p.get(c"host")?.get(c"childProcess")?;
    p.set(c"probeVersion", child.get(c"execFileSync")?)?;
    let silent = methods(
        p,
        &[("log", 0, |p, _| undef(p)), ("warn", 0, |p, _| undef(p))],
    )?;
    p.set(c"silentLogger", silent)?;
    defaulted_methods(
        p,
        &[
            ("createCommandResolver", 0, 1, resolver),
            ("findExecutableOnPath", 1, 2, find_api),
            ("isCommandAvailable", 1, 2, available),
            ("resolveCliCommands", 0, 1, resolve_commands),
        ],
    )
}
