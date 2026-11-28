//! Installation policy and single-flight ownership of the shared macOS Agent.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

mod inspect;
mod install;

const LABEL: &str = "com.multicc.agent";

fn or<'a>(v: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        fallback()
    }
}
fn join<'a>(p: L<'a>, base: L<'a>, names: &[&str]) -> Result<L<'a>> {
    let mut args = vec![base];
    for name in names {
        args.push(text(p, name)?);
    }
    call(p, c"join", &args)
}
fn list<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let arr = array(p)?;
    for (i, v) in values.iter().enumerate() {
        arr.set_element(i as u32, *v)?;
    }
    Ok(arr)
}
fn create<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(args[0])?;
    let dep = |key: &'static CStr| or(options.get(key)?, || ports.get(key));
    let injected_fs = options.get(c"fs")?;
    let fs = or(injected_fs, || ports.get(c"fs"))?;
    let path = dep(c"path")?;
    let os = dep(c"os")?;
    let spawn = dep(c"spawn")?;
    let platform = dep(c"platform")?;
    let env = dep(c"env")?;
    let logger = dep(c"logger")?;
    let root = options.get(c"rootDir")?;
    let home = or(options.get(c"home")?, || call(os, c"homedir", &[]))?;
    let script = join(path, root, &["scripts", "install-agent.sh"])?;
    let source_dir = join(ports.get(c"path")?, root, &["scripts", "macos-agent"])?;
    let required = list(ports, &[script])?;
    let mut icon = undef(ports)?;
    for name in [
        "MultiCCAgent.swift",
        "LidBrightnessBridge.h",
        "LidBrightnessBridge.m",
        "MultiCCAgentH264.swift",
        "AgentPermissions.swift",
        "MultiCCAgentRemoteInput.swift",
        "AgentIcon.icns",
    ] {
        let source = join(path, root, &["scripts", "macos-agent", name])?;
        call(required, c"push", &[source])?;
        if name == "AgentIcon.icns" {
            icon = source;
        }
    }
    let app = or(env.get(c"MULTICC_AGENT_APP")?, || {
        text(ports, "/Applications/MultiCC Agent.app")
    })?;
    let bin = join(path, app, &["Contents", "MacOS", "MultiCCAgent"])?;
    let stamp = join(path, app, &["Contents", "Resources", "source.sha256"])?;
    let plist = or(env.get(c"MULTICC_AGENT_PLIST")?, || {
        join(
            path,
            home,
            &["Library", "LaunchAgents", "com.multicc.agent.plist"],
        )
    })?;
    let link = or(env.get(c"MULTICC_AGENT_LINK")?, || {
        join(path, home, &[".multicc", "bin", "multicc-agent"])
    })?;
    let dir = or(env.get(c"MULTICC_AGENT_DIR")?, || {
        join(path, home, &[".multicc", "agent"])
    })?;
    let record = join(path, dir, &["install.json"])?;
    let desktops = or(options.get(c"desktopApps")?, || {
        list(
            ports,
            &[
                text(ports, "/Applications/MultiCC.app")?,
                join(path, home, &["Applications", "MultiCC.app"])?,
            ],
        )
    })?;
    let desktop_env = or(options.get(c"desktopEnvFile")?, || {
        join(
            path,
            home,
            &["Library", "Application Support", "MultiCC", "multicc.env"],
        )
    })?;
    let x_ok = or(fs.get(c"constants")?.optional(c"X_OK")?, || num(ports, 1.))?;
    let s = fields(
        ports,
        &[
            ("ports", ports),
            ("fs", fs),
            ("injectedFs", injected_fs),
            ("path", path),
            ("spawn", spawn),
            ("platform", platform),
            ("env", env),
            ("logger", logger),
            ("root", root),
            ("script", script),
            ("sourceDir", source_dir),
            ("required", required),
            ("icon", icon),
            ("app", app),
            ("bin", bin),
            ("stamp", stamp),
            ("plist", plist),
            ("link", link),
            ("dir", dir),
            ("record", record),
            ("desktops", desktops),
            ("desktopEnv", desktop_env),
            ("xOk", x_ok),
            ("last", null(ports)?),
            ("inFlight", null(ports)?),
        ],
    )?;
    defaulted_methods(
        s,
        &[
            ("plan", 0, 1, inspect::plan),
            ("inspect", 0, 0, |s, _| inspect::inspect(s)),
            ("ensure", 0, 1, install::ensure),
            ("getStatus", 0, 0, |s, _| s.get(c"last")),
        ],
    )
}
fn shared<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let root = opts.get(c"rootDir")?;
    let logger = opts.get(c"logger")?;
    let cache = p.get(c"shared")?;
    if !call(cache, c"has", &[root])?.truthy()? {
        let opts = fields(p, &[("rootDir", root), ("logger", logger)])?;
        let provisioner = create(p, &mut [opts])?;
        call(cache, c"set", &[root, provisioner])?;
    }
    call(cache, c"get", &[root])
}
#[napi]
pub fn macos_agent_provision_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"shared", p.global()?.get(c"Map")?.construct(&[])?)?;
    let api = defaulted_methods(
        p,
        &[
            ("createMacosAgentProvisioner", 0, 1, create),
            ("sharedMacosAgentProvisioner", 0, 1, shared),
        ],
    )?;
    api.set(c"LABEL", text(p, LABEL)?)?;
    api.set(c"SIGNING_DEFERRED_EXIT", num(p, 75.)?)?;
    Ok(api.raw())
}
