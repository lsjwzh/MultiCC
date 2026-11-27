use crate::route_response::*;
use multicc_core::sakura_launcher;
use napi_derive::napi;
#[napi]
pub fn sakura_diagnosis(env: Env, input: Unknown<'_>, now: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, input);
    let value = if let Some(source) = p.string()? {
        if let Some((code, reason, detail)) = sakura_launcher::diagnosis(&source) {
            fields(
                p,
                &[
                    ("code", text(p, code)?),
                    ("reason", text(p, reason)?),
                    ("detail", p.from_value(&V::String(detail))?),
                    ("at", L::new(&env, now).call_plain(&[])?),
                ],
            )?
        } else {
            null(p)?
        }
    } else {
        null(p)?
    };
    Ok(value.raw())
}

#[napi]
pub fn sakura_launcher_paths() -> Vec<String> {
    [
        "Contents/MacOS/SakuraLauncher",
        "Contents/MacOS/natfrp-service.app/Contents/MacOS/natfrp-service",
        "Contents/MacOS/natfrp-service.app/Contents/MacOS/frpc",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[napi]
pub fn sakura_find_app(
    env: Env,
    apps: Unknown<'_>,
    join: Unknown<'_>,
    exists: Unknown<'_>,
) -> Result<sys::napi_value> {
    let apps = L::new(&env, apps);
    let join = L::new(&env, join);
    let exists = L::new(&env, exists);
    let mut result = null(apps)?;
    apps.for_each_while(|app| {
        for path in sakura_launcher_paths().iter().take(2) {
            if !exists
                .call_plain(&[join.call_plain(&[app, text(apps, path)?])?])?
                .truthy()?
            {
                return Ok(true);
            }
        }
        result = app;
        Ok(false)
    })?;
    Ok(result.raw())
}
#[napi(object)]
pub struct RestartOutcome {
    pub ok: bool,
    pub message: String,
}
impl RestartOutcome {
    fn finished(ok: bool, message: &str) -> Self {
        Self {
            ok,
            message: message.into(),
        }
    }
}
#[napi]
pub struct SakuraRestart {
    binary: u32,
    checks: u32,
    stage: Stage,
}
enum Stage {
    Probe,
    Stop,
    WaitStopped,
    PauseStop,
    Open,
    WaitStarted,
    PauseStart,
}
#[napi]
impl SakuraRestart {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            binary: 0,
            checks: 0,
            stage: Stage::Probe,
        }
    }
    #[napi(getter)]
    pub fn index(&self) -> u32 {
        if matches!(self.stage, Stage::WaitStarted | Stage::PauseStart) {
            1
        } else {
            self.binary
        }
    }
    #[napi(getter)]
    pub fn action(&self) -> &'static str {
        match self.stage {
            Stage::Probe | Stage::WaitStopped | Stage::WaitStarted => "probe",
            Stage::Stop => "stop",
            Stage::Open => "open",
            Stage::PauseStop | Stage::PauseStart => "wait",
        }
    }
    /// Return an outcome only on a terminal step. The host converts failures
    /// into plain Error objects without exposing native status codes.
    #[napi]
    pub fn advance(&mut self, ok: bool, missing: bool) -> Option<RestartOutcome> {
        use Stage::*;
        match self.stage {
            Probe | WaitStopped | WaitStarted if !ok && !missing => {
                return Some(RestartOutcome::finished(
                    false,
                    "SakuraFrp 进程状态检查失败",
                ))
            }
            Probe if ok => self.stage = Stop,
            Probe | WaitStopped if !ok => {
                self.binary += 1;
                self.checks = 0;
                self.stage = if self.binary == 3 { Open } else { Probe };
            }
            Probe => unreachable!(),
            Stop => {
                if !ok && !missing {
                    return Some(RestartOutcome::finished(false, "SakuraFrp 客户端停止失败"));
                }
                self.stage = WaitStopped;
            }
            WaitStopped => {
                if self.checks >= 20 {
                    return Some(RestartOutcome::finished(
                        false,
                        "SakuraFrp 客户端尚未退出，未重复启动",
                    ));
                }
                self.stage = PauseStop;
            }
            PauseStop => {
                self.checks += 1;
                self.stage = WaitStopped;
            }
            Open => {
                if !ok {
                    return Some(RestartOutcome::finished(false, "SakuraFrp 启动器打开失败"));
                }
                self.checks = 0;
                self.stage = WaitStarted;
            }
            WaitStarted => {
                if ok {
                    return Some(RestartOutcome::finished(
                        true,
                        "已启动 SakuraFrp 启动器，等待公网复检",
                    ));
                }
                self.stage = PauseStart;
            }
            PauseStart => {
                self.checks += 1;
                if self.checks == 20 {
                    return Some(RestartOutcome::finished(false, "SakuraFrp 核心服务未启动"));
                }
                self.stage = WaitStarted;
            }
        }
        None
    }
}

#[napi]
pub fn sakura_process_pattern(env: Env, file: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, file);
    let s = p.coerce_string()?;
    let mut out = multicc_core::js::JsString::from("^");
    for &u in s.as_units() {
        if u < 128 && b".*+?^\x24{}()|[]\\".contains(&(u as u8)) {
            out.push_unit(92)
        }
        out.push_unit(u);
    }
    out.push_str("([[:space:]]|$)");
    Ok(p.from_value(&V::String(out))?.raw())
}
#[napi]
impl SakuraRestart {
    #[napi]
    pub fn command(
        &self,
        env: Env,
        app: Unknown<'_>,
        binaries: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        use crate::host_methods::{arg, env as host_env, raw};
        let p = L::new(&env, app);
        let action = self.action();
        if action == "wait" {
            return Ok(fields(p, &[("delay", num(p, 250.)?)])?.raw());
        }
        let args = p.from_value(&V::Array(vec![]))?;
        let cmd = if action == "open" {
            call(args, c"push", &[text(p, "-g")?, text(p, "-a")?, p])?;
            "/usr/bin/open"
        } else {
            let bin = L::new(&env, binaries).element(self.index())?;
            if action == "stop" {
                call(args, c"push", &[text(p, "-TERM")?])?;
            }
            call(
                args,
                c"push",
                &[
                    text(p, "-f")?,
                    raw(p, sakura_process_pattern(host_env(p), arg(bin)?)?),
                ],
            )?;
            if action == "stop" {
                "/usr/bin/pkill"
            } else {
                "/usr/bin/pgrep"
            }
        };
        Ok(fields(
            p,
            &[
                ("cmd", text(p, cmd)?),
                ("args", args),
                ("checkMissing", flag(p, action != "open")?),
            ],
        )?
        .raw())
    }
}
#[napi]
pub fn sakura_log_result(
    env: Env,
    dir: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::host_methods::{arg, env as host_env, function, raw};
    let p = L::new(&env, ports);
    let dir = L::new(&env, dir);
    Ok(p.catch(|| {
        let names = p.get(c"list")?.call_plain(&[dir])?;
        let filter = function(p, "", 1, 1, |p, a| {
            let raw = a[0].coerce_string()?;
            let s = raw.as_str_lossy();
            let valid = s
                .strip_prefix("natfrp-service.")
                .and_then(|s| s.strip_suffix(".log"))
                .is_some_and(|s| s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()));
            flag(p, valid)
        })?;
        let files = call(call(names, c"filter", &[filter])?, c"sort", &[])?;
        let len = files.get(c"length")?.number()? as u32;
        if len == 0 {
            return null(p);
        }
        let path = call(p, c"join", &[dir, files.element(len - 1)?])?;
        let contents = p.get(c"read")?.call_plain(&[path, text(p, "utf8")?])?;
        Ok(raw(
            p,
            sakura_diagnosis(host_env(p), arg(contents)?, arg(p.get(c"now")?)?)?,
        ))
    })?
    .unwrap_or(null(p)?)
    .raw())
}
