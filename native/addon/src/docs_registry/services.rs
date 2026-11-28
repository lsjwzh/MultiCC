//! The registry owns service state. A detached process and its log live past
//! the JS request. TCP/lsof probes return to the event loop between entries.
use super::*;
use napi::bindgen_prelude::JsValue as _;
use std::{
    fs::OpenOptions,
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    process::{Command, Stdio},
    time::Duration,
};

fn service<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let row = by_id(p, id)?;
    if row.truthy()? && row.get(c"kind")?.is_string("service")? {
        Ok(row)
    } else {
        null(p)
    }
}
fn refusal<'a>(p: L<'a>, status: i32, message: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("error", text(p, message)?),
            ("status", num(p, status.into())?),
        ],
    )
}
fn start<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let row = service(p, id)?;
    if row.nullish()? {
        return refusal(p, 404, "entry not found");
    }
    if row.get(c"status")?.is_string("up")? {
        return refusal(p, 409, "already running");
    }
    let cmd = row.get(c"startCmd")?;
    if !cmd.truthy()? {
        return refusal(p, 400, "no startCmd registered — cannot start");
    }
    let store = word(p.get(c"STORE")?)?;
    let dir = Path::new(&store)
        .parent()
        .unwrap_or(Path::new("."))
        .join("docs-registry-logs");
    let file = dir.join(format!("{}.log", word(row.get(c"id")?)?));
    let mut mkdir = fs::DirBuilder::new();
    mkdir.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        mkdir.mode(0o700);
    }
    let _ = mkdir.create(&dir);
    let mut child = Command::new("/bin/sh");
    child.arg("-c").arg(word(cmd)?);
    let cwd = row.get(c"cwd")?;
    if cwd.truthy()? {
        child.current_dir(word(cwd)?);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid is async-signal-safe and leaves the child's process group
        // independently addressable by stopService.
        unsafe {
            child.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let child = (|| {
        let sink = OpenOptions::new().create(true).append(true).open(&file)?;
        child
            .stdin(Stdio::null())
            .stdout(sink.try_clone()?)
            .stderr(sink)
            .spawn()
    })();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return refusal(p, 500, &format!("spawn failed: {e}")),
    };
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    row.assign(c"pid", num(p, pid.into())?)?;
    row.assign(c"pidSource", text(p, "spawned")?)?;
    row.assign(c"status", text(p, "starting")?)?;
    row.assign(c"startedAt", iso(p)?)?;
    row.assign(c"logFile", text(p, &file.to_string_lossy())?)?;
    save(p)?;
    fields(p, &[("entry", row)])
}
fn stop<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let row = service(p, id)?;
    if row.nullish()? {
        return refusal(p, 404, "entry not found");
    }
    let pid = row.get(c"pid")?;
    if !pid.truthy()? {
        return refusal(p, 409, "no known pid — nothing to stop");
    }
    let process = p.global()?.get(c"process")?;
    let signal = text(p, "SIGTERM")?;
    let group_killed = row.get(c"pidSource")?.is_string("spawned")?
        && p.catch(|| call(process, c"kill", &[num(p, -pid.number()?)?, signal]))?
            .is_some();
    if !group_killed {
        if let Err(e) = call(process, c"kill", &[pid, signal]) {
            let error = p.exception_value()?.ok_or(e)?;
            if !error.get(c"code")?.is_string("ESRCH")? {
                return refusal(
                    p,
                    500,
                    &format!("kill failed: {}", word(error.get(c"message")?)?),
                );
            }
        }
    }
    row.assign(c"status", text(p, "down")?)?;
    row.assign(c"pid", null(p)?)?;
    row.assign(c"pidSource", null(p)?)?;
    row.assign(c"stoppedAt", iso(p)?)?;
    save(p)?;
    fields(p, &[("entry", row)])
}
fn tail<'a>(p: L<'a>, id: L<'a>, max: L<'a>) -> Result<L<'a>> {
    let row = service(p, id)?;
    if row.nullish()? || !row.get(c"logFile")?.truthy()? {
        return text(p, "");
    }
    let path = word(row.get(c"logFile")?)?;
    if !Path::new(&path).exists() {
        return text(p, "");
    }
    use std::io::{Read, Seek, SeekFrom};
    let io_error = |e: std::io::Error| {
        crate::node_fs_error::throw(p, &e, "read", Some(Path::new(&path)), None)
    };
    let mut file = fs::File::open(&path).map_err(io_error)?;
    let size = file.metadata().map_err(io_error)?.len();
    let n = if max.undefined()? {
        16384.
    } else {
        max.number()?.trunc()
    };
    let start = if n > 0. {
        size.saturating_sub(n as u64)
    } else {
        ((-n) as u64).min(size)
    };
    file.seek(SeekFrom::Start(start)).map_err(io_error)?;
    let mut data = Vec::new();
    file.take(size - start)
        .read_to_end(&mut data)
        .map_err(io_error)?;
    text(p, &String::from_utf8_lossy(&data))
}
fn port(row: L<'_>) -> Result<Option<f64>> {
    if let Some(n) = row.get(c"port")?.number_value()? {
        if n.fract() == 0. {
            return Ok((n != 0.).then_some(n));
        }
    }
    let url = row.catch(|| row.global()?.get(c"URL")?.construct(&[row.get(c"url")?]))?;
    let Some(url) = url else { return Ok(None) };
    let n = url.get(c"port")?.explicit_number()?;
    Ok((1.0..=65535.0).contains(&n).then_some(n))
}
async fn tcp(port: u16) -> Result<bool> {
    tokio::task::spawn_blocking(move || {
        TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
            Duration::from_secs(2),
        )
        .is_ok()
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}
async fn pid_on(port: u16) -> Result<Option<i32>> {
    let mut cmd = tokio::process::Command::new("lsof");
    cmd.args(["-nP", &format!("-tiTCP:{port}"), "-sTCP:LISTEN"])
        .kill_on_drop(true);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await else {
        return Ok(None);
    };
    if !out.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim()
        .lines()
        .next()
        .and_then(|l| l.parse().ok())
        .filter(|n| *n > 0))
}
fn flipped(s: L<'_>) -> Result<()> {
    s.set(c"flipped", flag(s, true)?)
}
fn advance(s: L<'_>) -> Result<L<'_>> {
    let rows = s.get(c"rows")?;
    let p = s.get(c"registry")?;
    let mut i = s.get(c"index")?.number()? as u32;
    while (i as usize) < length(rows)? {
        let row = rows.element(i)?;
        i += 1;
        if !row.get(c"kind")?.is_string("service")? {
            continue;
        }
        let Some(port) = port(row)? else {
            if !row.get(c"status")?.is_string("unknown")? {
                row.assign(c"status", text(p, "unknown")?)?;
                flipped(s)?;
            }
            continue;
        };
        row.assign(c"port", num(p, port)?)?;
        if !(1.0..=65535.0).contains(&port) {
            return Err(napi::Error::from_reason("Port should be >= 0 and < 65536"));
        }
        let port = port as u16;
        s.set(c"index", num(p, i.into())?)?;
        s.set(c"row", row)?;
        let e = env(p);
        let probe = e.spawn_future(tcp(port))?;
        let done = function(s, "", 1, 1, move |s, a| {
            let row = s.get(c"row")?;
            let up = a[0].truthy()?;
            row.assign(c"lastCheckAt", iso(s)?)?;
            let status = if up { "up" } else { "down" };
            if !row.get(c"status")?.is_string(status)? {
                row.assign(c"status", text(s, status)?)?;
                flipped(s)?;
            }
            if !up {
                return advance(s);
            }
            row.assign(c"lastUpAt", row.get(c"lastCheckAt")?)?;
            let e = env(s);
            let lookup = e.spawn_future(pid_on(port))?;
            let adopt = function(s, "", 1, 1, |s, a| {
                let row = s.get(c"row")?;
                let pid = a[0];
                if pid.truthy()? && !pid.equals(row.get(c"pid")?)? {
                    row.assign(c"pid", pid)?;
                    row.assign(
                        c"pidSource",
                        fallback(row.get(c"pidSource")?, "observed".into())?,
                    )?;
                    flipped(s)?;
                }
                advance(s)
            })?;
            call(L::from_raw(s.env(), lookup.raw()), c"then", &[adopt])
        })?;
        return call(L::from_raw(p.env(), probe.raw()), c"then", &[done]);
    }
    if s.get(c"flipped")?.truthy()? {
        save(p)?;
    }
    undefined(p)
}
fn probe(p: L<'_>) -> Result<L<'_>> {
    async_result(p, || {
        advance(fields(
            p,
            &[
                ("registry", p),
                ("rows", p.get(c"entries")?),
                ("index", num(p, 0.)?),
                ("flipped", flag(p, false)?),
            ],
        )?)
    })
}
fn kick(p: L<'_>) -> Result<L<'_>> {
    call(
        probe(p)?,
        c"catch",
        &[function(p, "", 0, 0, |p, _| undefined(p))?],
    )?;
    undefined(p)
}
pub(super) fn install<'a>(api: L<'a>, p: L<'a>) -> Result<()> {
    api.set(
        c"startService",
        function(p, "startService", 1, 1, |p, a| start(p, a[0]))?,
    )?;
    api.set(
        c"stopService",
        function(p, "stopService", 1, 1, |p, a| {
            async_result(p, || stop(p, a[0]))
        })?,
    )?;
    api.set(
        c"probeAllServices",
        function(p, "probeAllServices", 0, 0, |p, _| probe(p))?,
    )?;
    api.set(
        c"startProbeLoop",
        function(p, "startProbeLoop", 0, 0, |p, _| {
            if !p.get(c"timer")?.truthy()? {
                p.set(c"timer", flag(p, true)?)?;
                kick(p)?;
                let timer = call(
                    p.global()?,
                    c"setInterval",
                    &[function(p, "", 0, 0, |p, _| kick(p))?, num(p, 30000.)?],
                )?;
                p.set(c"timer", timer)?;
                call(timer, c"unref", &[])?;
            }
            undefined(p)
        })?,
    )?;
    api.set(
        c"_stopProbeForTests",
        function(p, "_stopProbeForTests", 0, 0, |p, _| {
            let timer = p.get(c"timer")?;
            if timer.truthy()? {
                call(p.global()?, c"clearInterval", &[timer])?;
                p.set(c"timer", null(p)?)?;
            }
            undefined(p)
        })?,
    )?;
    api.set(
        c"tailLog",
        function(p, "tailLog", 1, 2, |p, a| tail(p, a[0], a[1]))?,
    )?;
    api.set(
        c"serviceLog",
        function(p, "serviceLog", 1, 1, |p, a| {
            fields(
                p,
                &[
                    ("found", flag(p, service(p, a[0])?.truthy()?)?),
                    ("text", tail(p, a[0], undefined(p)?)?),
                ],
            )
        })?,
    )?;
    Ok(())
}
