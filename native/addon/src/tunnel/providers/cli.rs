use super::*;

pub(super) fn frpc_dest<'a>(s: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let paths = super::super::paths(s, opts.get(c"dataDir")?)?;
    let root = paths.get(c"root")?;
    let platform = option(opts, c"platform", s.get(c"process")?.get(c"platform")?)?;
    let file = text(
        s,
        if platform.is_string("win32")? {
            "frpc.exe"
        } else {
            "frpc"
        },
    )?;
    let path = s.get(c"path")?;
    if root.equals(paths.get(c"pkgRoot")?)? {
        call(
            path,
            c"join",
            &[
                call(s.get(c"os")?, c"homedir", &[])?,
                text(s, ".multicc")?,
                text(s, "bin")?,
                file,
            ],
        )
    } else {
        call(path, c"join", &[root, text(s, "bin")?, file])
    }
}
struct Client {
    display: &'static str,
    bin: &'static str,
    template: &'static str,
    candidates: &'static [&'static str],
}
fn client(name: &str) -> Client {
    match name {
        "natapp" => Client {
            display: "natapp",
            bin: "natapp",
            template: "natapp -authtoken={authtoken}",
            candidates: &[
                "/opt/natapp/natapp",
                "/usr/local/bin/natapp",
                "/opt/homebrew/bin/natapp",
            ],
        },
        "cpolar" => Client {
            display: "cpolar",
            bin: "cpolar",
            template: "cpolar http {port}",
            candidates: &[
                "/usr/local/bin/cpolar",
                "/opt/homebrew/bin/cpolar",
                "/usr/bin/cpolar",
            ],
        },
        _ => Client {
            display: "樱花frp (Sakura)",
            bin: "frpc",
            template: SAKURA_START,
            candidates: &[
                "/usr/local/bin/frpc",
                "/opt/homebrew/bin/frpc",
                "/usr/bin/frpc",
            ],
        },
    }
}
fn launcher(s: L<'_>) -> Result<L<'_>> {
    let start = call(
        fallback(config(s, "sakurafrp")?.get(c"startCmd")?, "".into())?,
        c"trim",
        &[],
    )?;
    if !start.truthy()? || start.is_string(SAKURA_START)? {
        s.get(c"findSakuraLauncher")?.call_plain(&[])
    } else {
        null(s)
    }
}
fn find<'a>(s: L<'a>, client: &Client) -> Result<L<'a>> {
    let fs = s.get(c"fs")?;
    let exists = |v| call(fs, c"existsSync", &[v])?.truthy();
    if client.bin == "frpc" {
        let dest = s.get(c"frpcDest")?;
        if exists(dest)? {
            return Ok(dest);
        }
    }
    for candidate in client.candidates {
        let path = text(s, candidate)?;
        if exists(path)? {
            return Ok(path);
        }
    }
    let dirs = call(
        fallback(s.get(c"process")?.get(c"env")?.get(c"PATH")?, "".into())?,
        c"split",
        &[text(s, ":")?],
    )?;
    let mut selected = null(s)?;
    dirs.for_each_while(|dir| {
        if !dir.truthy()? {
            return Ok(true);
        }
        let full = call(s.get(c"path")?, c"join", &[dir, text(s, client.bin)?])?;
        let executable = s
            .catch(|| {
                if !exists(full)?
                    || !call(call(fs, c"statSync", &[full])?, c"isFile", &[])?.truthy()?
                {
                    return Ok(false);
                }
                call(
                    fs,
                    c"accessSync",
                    &[full, fs.get(c"constants")?.get(c"X_OK")?],
                )?;
                Ok(true)
            })?
            .unwrap_or(false);
        if executable {
            selected = full
        }
        Ok(!executable)
    })?;
    Ok(selected)
}
pub(super) fn available(s: L<'_>) -> Result<L<'_>> {
    let exists = |path: &str| call(s.get(c"fs")?, c"existsSync", &[text(s, path)?]);
    fields(
        s,
        &[
            ("phddns", exists(PHDDNS)?),
            ("tailscale", exists(TAILSCALE)?),
            ("natapp", flag(s, find(s, &client("natapp"))?.truthy()?)?),
            ("cpolar", flag(s, find(s, &client("cpolar"))?.truthy()?)?),
            (
                "sakurafrp",
                flag(
                    s,
                    launcher(s)?.truthy()? || find(s, &client("sakurafrp"))?.truthy()?,
                )?,
            ),
        ],
    )
}
pub(super) fn phddns<'a>(s: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let run_fn = options.get(c"run")?;
    let f = frame(s, &[("run", run_fn), ("wait", options.get(c"wait")?)])?;
    after(
        f,
        run(
            s,
            run_fn,
            "/usr/bin/killall",
            &["PhtunnelService", "PhDDNS"],
        )?,
        |f, _| {
            let wait = f.get(c"wait")?;
            let delay = if wait.undefined()? {
                let executor = function(f, "", 1, 1, |f, a| {
                    call(f.global()?, c"setTimeout", &[a[0], num(f, 3000.)?])
                })?;
                promise(f)?.construct(&[executor])?
            } else {
                wait.call_plain(&[num(f, 3000.)?])?
            };
            after(f, delay, |f, _| {
                let s = f.get(c"owner")?;
                let opened = run(s, f.get(c"run")?, "/usr/bin/open", &[PHDDNS])?;
                after(s, opened, |s, v| {
                    checked(s, v, "phddns start failed", "已重启花生壳 (PhDDNS)")
                })
            })
        },
    )
}
// Keep all quoting and interpolation on UTF-16 strings, including non-BMP text.
fn replace<'a>(v: L<'a>, pattern: &str, sub: L<'a>) -> Result<L<'a>> {
    call(call(v, c"split", &[text(v, pattern)?])?, c"join", &[sub])
}
fn quote(value: L<'_>) -> Result<L<'_>> {
    let quote = text(value, "'")?;
    let v = if value.nullish()? {
        text(value, "")?
    } else {
        string(value)?
    };
    call(
        quote,
        c"concat",
        &[replace(v, "'", text(v, "'\\''")?)?, quote],
    )
}
fn launch(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"owner")?;
    let name = label(f.get(c"name")?)?;
    let pc = f.get(c"pc")?;
    let meta = client(&name);
    let template = fallback(pc.get(c"startCmd")?, meta.template.into())?;
    let cmd = replace(
        replace(template, "{authtoken}", quote(pc.get(c"authtoken")?)?)?,
        "{port}",
        string(fallback(pc.get(c"port")?, V::Number(3000.))?)?,
    )?;
    let log = format!("/tmp/multicc-{name}.log");
    let shell = call(
        text(s, "pkill -f ")?,
        c"concat",
        &[
            quote(f.get(c"bin")?)?,
            text(s, " 2>/dev/null; sleep 1; nohup ")?,
            cmd,
            text(s, &format!(" > {log} 2>&1 &"))?,
        ],
    )?;
    let op = frame(s, &[("shell", shell)])?;
    let executor = function(op, "", 2, 2, |op, a| {
        let completion = fields(op, &[("ok", a[0]), ("fail", a[1])])?;
        let cb = function(completion, "", 1, 1, |f, a| {
            if a[0].truthy()? {
                f.get(c"fail")?.call_plain(&[failure(
                    f,
                    "后台启动失败",
                    Some(a[0].get(c"message")?),
                )?])
            } else {
                f.get(c"ok")?.call_plain(&[])
            }
        })?;
        op.get(c"owner")?.get(c"execFile")?.call_plain(&[
            text(op, "/bin/bash")?,
            array(op, &[text(op, "-c")?, op.get(c"shell")?])?,
            fields(op, &[("timeout", num(op, 15000.)?)])?,
            cb,
        ])
    })?;
    let started = promise(s)?.construct(&[executor])?;
    let success = text(s, &format!("已后台启动 {} (日志 {log})", meta.display))?;
    after(success, started, |message, _| Ok(message))
}
pub(super) fn restart<'a>(s: L<'a>, name: &str) -> Result<L<'a>> {
    if name == "sakurafrp" {
        let app = launcher(s)?;
        if app.truthy()? {
            return s
                .get(c"restartSakuraLauncher")?
                .call_plain(&[app, fields(s, &[("run", s.get(c"execShell")?)])?]);
        }
    }
    let meta = client(name);
    let pc = config(s, name)?;
    let bin = find(s, &meta)?;
    if !bin.truthy()? {
        return Err(failure(s, &format!("{name} 未安装, 请先安装其客户端"), None)?.throw_error());
    }
    let f = frame(s, &[("pc", pc), ("bin", bin), ("name", text(s, name)?)])?;
    if name == "cpolar" {
        let token = pc.get(c"authtoken")?;
        if token.truthy()? {
            return after(
                f,
                exec(s, bin, array(s, &[text(s, "authtoken")?, token])?)?,
                |f, _| launch(f),
            );
        }
    }
    launch(f)
}
