//! Per-CLI MCP configuration. The child env stays live so synchronous callers
//! see setters and receive the same object. Only public stdio settings are
//! written to shared user configuration.
use crate::{host_api::*, js_iteration::read};
use napi::Error;
use napi_derive::napi;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn list<'a>(owner: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let result = array(owner)?;
    for (i, value) in values.iter().enumerate() {
        result.set_element(i as u32, *value)?;
    }
    Ok(result)
}

fn stdio<'a>(node: L<'a>, script: L<'a>) -> Result<L<'a>> {
    fields(
        node,
        &[
            ("command", string(node)?),
            ("args", list(node, &[string(script)?])?),
        ],
    )
}

fn stdio_server<'a>(_: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    stdio(args[0], args[1])
}

fn claude_args<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    if !args[0].truthy()? || !args[1].truthy()? {
        return array(p);
    }
    let servers = fields(p, &[("multicc_router", stdio(args[0], args[1])?)])?;
    let config = fields(p, &[("mcpServers", servers)])?;
    list(
        p,
        &[
            text(p, "--mcp-config")?,
            json_call(p, c"stringify", config)?,
        ],
    )
}

fn config_object(value: L<'_>) -> Result<L<'_>> {
    if object(value)? && !value.is_array()? {
        Ok(value)
    } else {
        fields(value, &[])
    }
}

fn env_config(raw: L<'_>) -> Result<L<'_>> {
    if raw.truthy()? {
        if let Some(config) = raw.catch(|| config_object(json_call(raw, c"parse", raw)?))? {
            return Ok(config);
        }
    }
    fields(raw, &[])
}

fn io_error(error: std::io::Error) -> Error {
    Error::from_reason(error.to_string())
}

fn joined(owner: L<'_>, dir: L<'_>, components: &[&str]) -> Result<PathBuf> {
    let mut args = vec![dir];
    for part in components {
        args.push(text(owner, part)?);
    }
    let path = call(owner.get(c"path")?, c"join", &args)?;
    Ok(PathBuf::from(path.coerce_string()?.to_string_lossy()))
}

fn read_config<'a>(p: L<'a>, path: &Path) -> Result<L<'a>> {
    let bytes = fs::read(path).map_err(io_error)?;
    json_call(p, c"parse", text(p, &String::from_utf8_lossy(&bytes))?)
}

fn write_config(path: &Path, config: L<'_>) -> Result<()> {
    let json = call(
        config.global()?.get(c"JSON")?,
        c"stringify",
        &[config, null(config)?, num(config, 2.0)?],
    )?;
    fs::write(path, json.coerce_string()?.to_string_lossy()).map_err(io_error)
}

fn workspace_config<'a>(
    p: L<'a>,
    cwd: L<'a>,
    node: L<'a>,
    script: L<'a>,
    env: L<'a>,
) -> Result<()> {
    if !cwd.truthy()?
        || !read(env, c"MULTICC_BASE_URL")?.truthy()?
        || !read(env, c"MULTICC_ROUTER_CAPABILITY")?.truthy()?
    {
        return Ok(());
    }
    p.catch(|| {
        let path = joined(p, string(cwd)?, &[".zcode", "config.json"])?;
        let config = if path.exists() {
            config_object(read_config(p, &path)?)?
        } else {
            fields(p, &[])?
        };
        let router_env = fields(p, &[])?;
        for key in [
            c"MULTICC_SESSION_ID",
            c"MULTICC_BASE_URL",
            c"MULTICC_TURN_ID",
            c"MULTICC_ORIGIN_DISPATCH_ID",
            c"MULTICC_ROUTER_CAPABILITY",
            c"MULTICC_IMAGE_BRIDGE",
        ] {
            if read(env, key)?.truthy()? {
                router_env.set(key, string(read(env, key)?)?)?;
            }
        }
        config.assign(c"mcp", spread(config.get(c"mcp")?)?)?;
        let mcp = config.get(c"mcp")?;
        let servers = spread(mcp.get(c"servers")?)?;
        let entry = fields(p, &[("type", text(p, "stdio")?)])?;
        entry.spread_from(stdio(node, script)?)?;
        entry.set(c"env", router_env)?;
        servers.set(c"multicc_router", entry)?;
        mcp.assign(c"servers", servers)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(io_error)?;
        }
        write_config(&path, config)
    })?;
    Ok(())
}

fn kimi_config<'a>(p: L<'a>, env: L<'a>, node: L<'a>, script: L<'a>) -> Result<()> {
    let Some(home) = read(env, c"KIMI_CODE_HOME")?.string()? else {
        return Ok(());
    };
    if home.is_empty() {
        return Ok(());
    }
    let dir = PathBuf::from(home.to_string_lossy());
    fs::create_dir_all(&dir).map_err(io_error)?;
    let path = joined(p, text(p, &dir.to_string_lossy())?, &["mcp.json"])?;
    let config = match p.catch(|| read_config(p, &path))? {
        Some(v) if v.nullish()? => v,
        Some(v) => config_object(v)?,
        None => fields(p, &[])?,
    };
    let entry = stdio(node, script)?;
    entry.set(c"env", fields(p, &[])?)?;
    config.assign(c"multicc_router", entry)?;
    write_config(&path, config)
}

fn agy_config<'a>(p: L<'a>, env: L<'a>, node: L<'a>, script: L<'a>) -> Result<()> {
    let value = if read(env, c"HOME")?.kind()? == sys::ValueType::napi_string
        && call(read(env, c"HOME")?, c"trim", &[])?.truthy()?
    {
        call(read(env, c"HOME")?, c"trim", &[])?
    } else {
        p.get(c"homedir")?.call_plain(&[])?
    };
    if value.truthy()? {
        multicc_core::agy_stream::ensure_router_mcp(
            Path::new(&fold_string(value)?),
            &fold_string(node)?,
            &fold_string(script)?,
        )
        .map_err(Error::from_reason)?;
    }
    Ok(())
}

fn apply<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (env, cli, node, script) = (args[0], args[1], args[2], args[3]);
    if !env.truthy()? || !node.truthy()? || !script.truthy()? {
        return Ok(env);
    }
    let command = list(p, &[string(node)?, string(script)?])?;
    let zcode = cli.is_string("zcode")?;
    if zcode || cli.is_string("opencode")? {
        let source = env_config(read(env, c"OPENCODE_CONFIG_CONTENT")?)?;
        let config = spread(source)?;
        let mcp = spread(source.get(c"mcp")?)?;
        let entry = fields(
            p,
            &[
                ("type", text(p, "local")?),
                ("command", command),
                ("enabled", flag(p, true)?),
                ("timeout", num(p, 10000.0)?),
            ],
        )?;
        mcp.set(c"multicc_router", entry)?;
        config.set(c"mcp", mcp)?;
        env.assign(
            c"OPENCODE_CONFIG_CONTENT",
            json_call(p, c"stringify", config)?,
        )?;
    }
    if zcode {
        let source = env_config(read(env, c"ZCODE_CONFIG_CONTENT")?)?;
        let config = spread(source)?;
        let mcp = spread(source.get(c"mcp")?)?;
        let servers = spread(source.get(c"mcp")?.optional(c"servers")?)?;
        let entry = stdio(node, script)?;
        entry.set(c"env", fields(p, &[])?)?;
        servers.set(c"multicc_router", entry)?;
        mcp.set(c"servers", servers)?;
        config.set(c"mcp", mcp)?;
        env.assign(c"ZCODE_CONFIG_CONTENT", json_call(p, c"stringify", config)?)?;
        workspace_config(
            p,
            read(default_object(args[4])?, c"cwd")?,
            node,
            script,
            env,
        )?;
    }
    if cli.is_string("kimi")? && read(env, c"KIMI_CODE_HOME")?.truthy()? {
        p.catch(|| kimi_config(p, env, node, script))?;
    }
    if cli.is_string("agy")? && !read(env, c"MULTICC_AGY_REMOTE_ACCOUNT_JSON")?.truthy()? {
        p.catch(|| agy_config(p, env, node, script))?;
    }
    Ok(env)
}

#[napi]
pub fn router_mcp_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(defaulted_methods(
        L::new(&env, host),
        &[
            ("applyRouterMcpEnv", 4, 5, apply),
            ("claudeLikeMcpArgs", 2, 2, claude_args),
            ("stdioServer", 2, 2, stdio_server),
        ],
    )?
    .raw())
}
