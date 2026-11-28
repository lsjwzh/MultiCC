//! The one-shot DSH runner is replaced by the packaged streaming profile on
//! the first invocation. The public materializer keeps its injected fs port.
use crate::{
    cli_completion::tracker, host_api::*, host_methods::env as environment, js_iteration::read,
};
use napi_derive::napi;

const PROFILE: &str = "multicc";
const VERSION: u32 = 3;
const MANIFEST: &str = r#"{
  "name": "multicc",
  "version": "1.0.0",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless"
      ]
    }
  }
}
"#;
const PATCH: &str = "# multicc chat runner over dsh: disables the shipped one-shot headless\n\
# runners and mounts our streaming resume-capable runner instead.\n\
- id: headless-runner\n  disabled: true\n- id: headless-startup\n  disabled: true\n\
- insert:\n    - id: multicc-runner\n      name: multicc-dsh-runner\n";

fn append<'a>(arr: L<'a>, value: L<'a>) -> Result<()> {
    call(arr, c"push", &[value])?;
    Ok(())
}
fn join<'a>(path: L<'a>, dir: L<'a>, parts: &[&str]) -> Result<L<'a>> {
    let mut args = vec![dir];
    for part in parts {
        args.push(text(dir, part)?)
    }
    call(path, c"join", &args)
}
fn mkdir<'a>(fs: L<'a>, dir: L<'a>) -> Result<()> {
    call(
        fs,
        c"mkdirSync",
        &[dir, fields(fs, &[("recursive", flag(fs, true)?)])?],
    )?;
    Ok(())
}
fn write_changed<'a>(fs: L<'a>, path: L<'a>, file: L<'a>, contents: &str) -> Result<bool> {
    let contents = text(fs, contents)?;
    let same =
        fs.catch(|| call(fs, c"readFileSync", &[file, text(fs, "utf8")?])?.equals(contents))?;
    if same == Some(true) {
        return Ok(false);
    }
    mkdir(fs, call(path, c"dirname", &[file])?)?;
    call(fs, c"writeFileSync", &[file, contents])?;
    Ok(true)
}
fn copy_runner<'a>(fs: L<'a>, path: L<'a>, source: L<'a>, dest: L<'a>) -> Result<()> {
    mkdir(fs, dest)?;
    let opts = fields(fs, &[("withFileTypes", flag(fs, true)?)])?;
    call(fs, c"readdirSync", &[source, opts])?.for_each(|entry| {
        let from = call(path, c"join", &[source, read(entry, c"name")?])?;
        let to = call(path, c"join", &[dest, read(entry, c"name")?])?;
        if call(entry, c"isDirectory", &[])?.truthy()? {
            copy_runner(fs, path, from, to)?
        } else if call(entry, c"isFile", &[])?.truthy()? {
            call(fs, c"copyFileSync", &[from, to])?;
        }
        Ok(())
    })
}
fn materialize<'a>(host: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let home = read(opts, c"homeDir")?;
    let source = read(opts, c"runnerSrcDir")?;
    let fs = read(opts, c"fsImpl")?;
    let fs = if fs.undefined()? {
        host.get(c"fs")?
    } else {
        fs
    };
    let home = if home.truthy()? {
        home
    } else {
        host.get(c"homedir")?.call_plain(&[])?
    };
    let source = if source.truthy()? {
        source
    } else {
        host.get(c"runnerSrcDir")?
    };
    let path = host.get(c"path")?;
    let dir = join(path, home, &[".dsh", "profiles", PROFILE])?;
    let stamp = join(path, dir, &[".multicc-profile-version"])?;
    let dest = join(path, dir, &["node_modules", "multicc-dsh-runner"])?;
    let stamp_changed = write_changed(fs, path, stamp, &format!("{VERSION}\n"))?;
    let manifest_changed = write_changed(fs, path, join(path, dir, &["package.json"])?, MANIFEST)?;
    let patch_changed = write_changed(fs, path, join(path, dir, &["cordis.patch.yml"])?, PATCH)?;
    write_changed(
        fs,
        path,
        join(path, dir, &["pnpm-workspace.yaml"])?,
        "packages:\n  - .\n",
    )?;
    write_changed(fs, path, join(path, dir, &["cordis.yml"])?, "[]\n")?;
    let installed = call(fs, c"existsSync", &[join(path, dest, &["package.json"])?])?.truthy()?;
    if stamp_changed || manifest_changed || patch_changed || !installed {
        copy_runner(fs, path, source, dest)?;
    }
    fields(dir, &[("dir", dir), ("runnerDest", dest)])
}
fn bootstrap(state: L<'_>) -> Result<()> {
    if state.get(c"bootstrapped")?.truthy()? {
        return Ok(());
    }
    state.set(c"bootstrapped", flag(state, true)?)?;
    if let Err(error) = materialize(state.get(c"host")?, state) {
        let cause = if let Some(cause) = state.exception_value()? {
            cause
        } else {
            error_value(state, &error.reason)?
        };
        let message = if cause.truthy()? {
            read(cause, c"message")?
        } else {
            cause
        };
        let log = call(
            text(state, "[multicc] dsh profile bootstrap failed: ")?,
            c"concat",
            &[message],
        )?;
        call(state.global()?.get(c"console")?, c"warn", &[log])?;
    }
    Ok(())
}
fn terminal<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let mut line = state.get(c"cmd")?.coerce_string()?;
    line.push_str(" --profile multicc");
    let session = args[0];
    if session.truthy()? {
        for (key, prefix) in [
            (c"model", " --multicc-model "),
            (c"cliSessionId", " --multicc-resume "),
        ] {
            if read(session, key)?.truthy()? {
                line.push_str(prefix);
                line.push(&read(session, key)?.coerce_string()?);
            }
        }
    }
    state.from_value(&V::String(line))
}
fn invocation<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    bootstrap(state)?;
    let env = args[0];
    let opts = read(env, c"spawnOpts")?;
    let argv = array(env)?;
    append(argv, text(env, "--profile")?)?;
    append(argv, text(env, PROFILE)?)?;
    if read(opts, c"rawModel")?.truthy()?
        && (read(opts, c"providerModel")?.truthy()?
            || call(
                state.get(c"models")?,
                c"includes",
                &[string(read(opts, c"rawModel")?)?],
            )?
            .truthy()?)
    {
        append(argv, text(env, "--multicc-model")?)?;
        append(argv, read(opts, c"rawModel")?)?;
    }
    if !read(read(env, c"historyHandle")?, c"isFirstTurn")?.truthy()?
        && read(read(env, c"historyHandle")?, c"cliSessionId")?.truthy()?
    {
        append(argv, text(env, "--multicc-resume")?)?;
        append(argv, read(read(env, c"historyHandle")?, c"cliSessionId")?)?;
    }
    let runtime = environment(env);
    let payload = crate::message_composer::render_prompt(&runtime, env)?.raw();
    fields(
        env,
        &[
            ("cmd", state.get(c"cmd")?),
            ("args", argv),
            ("payload", L::from_raw(env.env(), payload)),
        ],
    )
}
fn decode<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let result = array(p)?;
    let event = args[0];
    if !event.truthy()? || !object(event)? {
        return Ok(result);
    }
    let Some(kind) = read(event, c"type")?.string()? else {
        return Ok(result);
    };
    let name = kind.to_string_lossy();
    let row = fields(p, &[("type", text(p, &name)?)])?;
    match name.as_str() {
        "assistant_text" | "thinking" | "session_started" => {
            let key = if name == "session_started" {
                c"sessionId"
            } else {
                c"text"
            };
            if !read(event, key)?.truthy()? {
                return Ok(result);
            }
            row.set(key, read(event, key)?)?;
        }
        "tool_update" => {
            row.set(c"id", read(event, c"id")?)?;
            row.set(c"name", fallback(read(event, c"name")?, "tool".into())?)?;
            let input = read(event, c"input")?;
            row.set(
                c"input",
                if input.truthy()? {
                    input
                } else {
                    fields(p, &[])?
                },
            )?;
            row.set(c"currentFile", null(p)?)?;
            row.set(c"completed", flag(p, read(event, c"completed")?.truthy()?)?)?;
            row.set(c"content", fallback(read(event, c"content")?, "".into())?)?;
            row.set(c"isError", flag(p, read(event, c"isError")?.truthy()?)?)?;
        }
        "status" => row.set(
            c"status",
            fallback(read(event, c"status")?, "thinking".into())?,
        )?,
        "complete" => {}
        "error" => row.set(
            c"message",
            string(fallback(
                read(event, c"message")?,
                "dsh turn failed".into(),
            )?)?,
        )?,
        _ => return Ok(result),
    }
    append(result, row)?;
    Ok(result)
}
fn create<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let cmd = read(opts, c"cmd")?;
    let state = fields(
        owner,
        &[
            ("cmd", cmd),
            ("homeDir", read(opts, c"homeDir")?),
            ("runnerSrcDir", read(opts, c"runnerSrcDir")?),
            ("host", owner.get(c"host")?),
            ("models", owner.get(c"models")?),
            ("bootstrapped", flag(owner, false)?),
        ],
    )?;
    fields(
        owner,
        &[
            ("name", text(owner, "dsh")?),
            (
                "createCompletionTracker",
                function(state, "createCompletionTracker", 0, 0, |p, _| {
                    tracker::create(fields(p, &[])?, text(p, "dsh")?, tracker::Protocol::Named)
                })?,
            ),
            ("cmd", cmd),
            (
                "buildTerminalCmd",
                function(state, "buildTerminalCmd", 1, 1, terminal)?,
            ),
            (
                "buildInvocation",
                function(state, "buildInvocation", 1, 1, invocation)?,
            ),
            ("decodeEvent", function(state, "decodeEvent", 1, 1, decode)?),
            ("needsAsyncSessionIdCapture", flag(owner, false)?),
        ],
    )
}
#[napi]
pub fn dsh_adapter_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    let models = array(host)?;
    append(models, text(host, "deepseek-v4-flash")?)?;
    append(models, text(host, "deepseek-v4-pro")?)?;
    let owner = fields(host, &[("host", host), ("models", models)])?;
    let out = defaulted_methods(
        owner,
        &[
            ("createDshAdapter", 0, 1, create),
            ("ensureDshProfile", 0, 1, |p, a| {
                materialize(p.get(c"host")?, default_object(a[0])?)
            }),
        ],
    )?;
    out.set(c"DSH_MODELS", models)?;
    out.set(c"DSH_PROFILE", text(host, PROFILE)?)?;
    out.set(c"DSH_PROFILE_VERSION", num(host, VERSION.into())?)?;
    Ok(out.raw())
}
