use crate::{
    host_methods::{env, function},
    route_response::*,
};
use napi::bindgen_prelude::JsValue as _;
use std::{
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[napi]
pub const DEFAULT_OUTBOUND_TTL_MS: u32 = 4_000;
#[napi]
pub const DEFAULT_ROLLOUT_WINDOW_MS: u32 = 15_000;
const LSOF_TIMEOUT_MS: u64 = 4_000;
use napi_derive::napi;

// The two JS regexes were independent per newline. Dot excludes four line
// terminators and the port's trailing word boundary uses ASCII word characters.
#[napi]
pub fn probe_established(output: String) -> bool {
    output.split('\n').any(|line| {
        line.contains("ESTABLISHED")
            && line.split(['\r', '\u{2028}', '\u{2029}']).any(|part| {
                let Some((_, tail)) = part.split_once("->") else {
                    return false;
                };
                tail.match_indices(':').any(|(i, _)| {
                    let port = &tail[i + 1..];
                    ["443", "80"].iter().any(|s| {
                        port.strip_prefix(s).is_some_and(|rest| {
                            !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
                        })
                    })
                })
            })
    })
}

/// Bound both the time and the amount of output, as for execFile. A non-zero
/// exit or timeout can still leave a useful connection in the captured prefix.
async fn system_lsof(pid: String) -> bool {
    const MAX_STDOUT: usize = 1024 * 1024;
    let Ok(mut child) = Command::new("lsof")
        .args(["-nP", "-p", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return false;
    };
    let mut stdout = child.stdout.take().expect("piped lsof stdout");
    let mut bytes = Vec::new();
    let read_and_wait = async {
        (&mut stdout)
            .take(MAX_STDOUT as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_STDOUT {
            child.kill().await?;
        } else {
            child.wait().await?;
        }
        std::io::Result::Ok(())
    };
    if !matches!(
        timeout(Duration::from_millis(LSOF_TIMEOUT_MS), read_and_wait).await,
        Ok(Ok(()))
    ) {
        let _ = child.kill().await;
    }
    bytes.truncate(MAX_STDOUT);
    probe_established(String::from_utf8_lossy(&bytes).into_owned())
}

fn system_mtime(path: L<'_>) -> Result<L<'_>> {
    let Some(name) = path.string()? else {
        return null(path);
    };
    let Ok(modified) = std::fs::metadata(name.to_string_lossy()).and_then(|m| m.modified()) else {
        return null(path);
    };
    let millis =
        |d: Duration| d.as_millis() as f64 + (d.subsec_nanos() % 1_000_000) as f64 / 1_000_000.;
    let ms = match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => millis(d),
        Err(e) => -millis(e.duration()),
    };
    num(path, ms)
}

fn injected_lsof<'a>(p: L<'a>, pid: L<'a>) -> Result<L<'a>> {
    let request = fields(
        p,
        &[("execFile", p.get(c"execFile")?), ("pid", string(pid)?)],
    )?;
    let execute = function(request, "", 2, 2, |req, promises| {
        let done = function(promises[0], "", 2, 2, |resolve, values| {
            let stdout = values[1];
            let active = stdout.truthy()?
                && probe_established(string(stdout)?.coerce_string()?.to_string_lossy());
            resolve.call_plain(&[flag(resolve, active)?])
        })?;
        let args = req.from_value(&V::Array(vec!["-nP".into(), "-p".into()]))?;
        args.set_element(2, req.get(c"pid")?)?;
        let opts = fields(req, &[("timeout", num(req, LSOF_TIMEOUT_MS as f64)?)])?;
        req.get(c"execFile")?
            .call_plain(&[text(req, "lsof")?, args, opts, done])
    })?;
    p.global()?.get(c"Promise")?.construct(&[execute])
}

#[derive(Clone, Copy)]
enum Source {
    System,
    Injected,
    SignalPorts,
}

impl Source {
    fn run<'a>(self, p: L<'a>, pid: L<'a>) -> Result<L<'a>> {
        match self {
            Self::System => {
                let pid = string(pid)?.coerce_string()?.to_string_lossy();
                let runtime = env(p);
                let job = runtime.spawn_future(async move { Ok(system_lsof(pid).await) })?;
                Ok(L::from_raw(p.env(), job.raw()))
            }
            Self::Injected => injected_lsof(p, pid),
            Self::SignalPorts => call(p, c"runLsof", &[pid]),
        }
    }
    fn within(self, p: L<'_>, now: L<'_>, then: L<'_>, expire: bool) -> Result<bool> {
        if matches!(self, Self::System) {
            let elapsed = now.number()? - then.number()?;
            Ok(if expire {
                elapsed > DEFAULT_OUTBOUND_TTL_MS as f64
            } else {
                elapsed <= DEFAULT_OUTBOUND_TTL_MS as f64
            })
        } else {
            call(p, if expire { c"expired" } else { c"fresh" }, &[now, then])?.truthy()
        }
    }
}

fn outbound<'a>(p: L<'a>, pid: L<'a>, source: Source) -> Result<L<'a>> {
    if !pid
        .number_value()?
        .is_some_and(|n| n > 0. && n.fract() == 0.)
    {
        return if matches!(source, Source::SignalPorts) {
            call(p, c"inactive", &[])
        } else {
            call(p.global()?.get(c"Promise")?, c"resolve", &[flag(p, false)?])
        };
    }
    let now = p.get(c"now")?.call_plain(&[])?;
    let cache = p.get(c"outbound")?;
    let entry = call(cache, c"get", &[pid])?;
    if entry.truthy()? && source.within(p, now, entry.get(c"at")?, false)? {
        return entry.get(c"promise");
    }
    cache.for_each(|pair| {
        let (key, entry) = pair.iterator_pair()?;
        if source.within(p, now, entry.get(c"at")?, true)? {
            call(cache, c"delete", &[key])?;
        }
        Ok(())
    })?;
    let promise = source.run(p, pid)?;
    call(
        cache,
        c"set",
        &[pid, fields(p, &[("at", now), ("promise", promise)])?],
    )?;
    Ok(promise)
}

fn grew<'a>(p: L<'a>, path: L<'a>, source: Source) -> Result<L<'a>> {
    if !path.truthy()? {
        return flag(p, false);
    }
    let system = matches!(source, Source::System);
    let mtime = if system {
        system_mtime(path)?
    } else if let Some(value) = p.catch(|| p.get(c"statMtimeMs")?.call_plain(&[path]))? {
        value
    } else {
        return flag(p, false);
    };
    if mtime.nullish()? {
        return flag(p, false);
    }
    let cache = p.get(c"mtimes")?;
    let prev = call(cache, c"get", &[path])?;
    call(cache, c"set", &[path, mtime])?;
    if system {
        let current = mtime.number()?;
        let growing = if prev.nullish()? {
            p.get(c"now")?.call_plain(&[])?.number()? - current <= DEFAULT_ROLLOUT_WINDOW_MS as f64
        } else {
            current > prev.number()?
        };
        flag(p, growing)
    } else if prev.nullish()? {
        call(p, c"recent", &[mtime])
    } else {
        call(p, c"advanced", &[mtime, prev])
    }
}

fn signals(p: L<'_>, source: Source) -> Result<sys::napi_value> {
    Ok(fields(
        p,
        &[
            (
                "outboundHttps",
                function(p, "outboundHttps", 1, 1, move |p, a| {
                    outbound(p, a[0], source)
                })?,
            ),
            (
                "rolloutGrew",
                function(p, "rolloutGrew", 1, 1, move |p, a| grew(p, a[0], source))?,
            ),
        ],
    )?
    .raw())
}

#[napi]
pub fn process_probe_signals(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    signals(L::new(&env, ports), Source::SignalPorts)
}

#[napi]
pub fn process_probe_runtime(
    env: Env,
    ports: Unknown<'_>,
    system: bool,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let source = if system {
        p.set(c"now", p.global()?.get(c"Date")?.get(c"now")?)?;
        Source::System
    } else {
        for (key, message) in [
            (c"execFile", "[process-probe] execFile is required"),
            (c"statMtimeMs", "[process-probe] statMtimeMs is required"),
        ] {
            if p.get(key)?.kind()? != sys::ValueType::napi_function {
                return Err(p.type_error(message));
            }
        }
        Source::Injected
    };
    let map = p.global()?.get(c"Map")?;
    p.set(c"mtimes", map.construct(&[])?)?;
    p.set(c"outbound", map.construct(&[])?)?;
    signals(p, source)
}
