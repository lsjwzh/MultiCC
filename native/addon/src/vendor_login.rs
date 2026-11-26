//! Interactive vendor login specifications and terminal command selection.
use crate::{host_methods::method, route_response::*};
use multicc_core::{cli_capability::family_of, js::JsString};
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

const VENDORS: &[(&str, &str, bool)] = &[
    ("commandcode", "command-code login", true),
    ("codebuddy", "/login", false),
    ("qoder", "/login", false),
    ("agy", "agy", true),
];

fn key(value: L<'_>) -> Result<JsString> {
    if value.truthy()? {
        Ok(string(value)?.coerce_string()?.trim())
    } else {
        Ok(JsString::new())
    }
}

pub(crate) fn login_cli(flow: L<'_>) -> Result<L<'_>> {
    let value = key(flow)?.to_string_lossy();
    if let Some(cli) = value.strip_suffix("-login") {
        if VENDORS.iter().any(|&(id, _, _)| id == cli) {
            return text(flow, cli);
        }
    }
    null(flow)
}

fn vendor_command<'a>(flow: L<'a>, commands: L<'a>) -> Result<L<'a>> {
    let cli = login_cli(flow)?;
    if cli.nullish()? || !commands.truthy()? || !commands.get_key(cli)?.truthy()? {
        return null(flow);
    }
    let binary = commands.get_key(cli)?;
    if !cli.is_string("commandcode")? {
        return flow.from_value(&V::String(binary.coerce_string()?));
    }
    let mut quoted = JsString::from_rust_str("'");
    for &unit in string(binary)?.coerce_string()?.as_units() {
        if unit == u16::from(b'\'') {
            quoted.push_str("'\"'\"'");
        } else {
            quoted.push_unit(unit);
        }
    }
    quoted.push_str("' login --no-auto-update");
    flow.from_value(&V::String(quoted))
}

#[napi]
pub fn vendor_login_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let specs = fields(anchor, &[])?;
    for &(cli, command, auto_start) in VENDORS {
        let family = family_of(cli)
            .ok_or_else(|| napi::Error::from_reason(format!("missing CLI family {cli}")))?;
        let spec = fields(
            anchor,
            &[
                ("loginFlow", text(anchor, &format!("{cli}-login"))?),
                ("label", text(anchor, family.name)?),
                ("loginCommand", text(anchor, command)?),
            ],
        )?;
        if auto_start {
            spec.set(c"autoStart", flag(anchor, true)?)?;
        }
        specs.set_key(text(anchor, cli)?, spec.freeze()?)?;
    }
    let specs = specs.freeze()?;
    let api = fields(anchor, &[("VENDOR_LOGIN", specs)])?;
    api.set(
        c"vendorLoginForCli",
        method(&env, specs, "vendorLoginForCli", 1, 1, |specs, args| {
            let key = key(args[0])?.to_lowercase();
            if VENDORS
                .iter()
                .any(|&(id, _, _)| key == JsString::from_rust_str(id))
            {
                specs.get_key(specs.from_value(&V::String(key))?)
            } else {
                null(specs)
            }
        })?,
    )?;
    api.set(
        c"cliForLoginFlow",
        method(&env, specs, "cliForLoginFlow", 1, 1, |_, args| {
            login_cli(args[0])
        })?,
    )?;
    api.set(
        c"vendorLoginTerminalCmd",
        method(&env, specs, "vendorLoginTerminalCmd", 2, 2, |_, args| {
            vendor_command(args[0], args[1])
        })?,
    )?;
    api.set(
        c"terminalLoginCommand",
        method(&env, specs, "terminalLoginCommand", 2, 2, |_, args| {
            let flow = args[0];
            let (name, suffix) = if flow.is_string("codex-login")? {
                (c"codex", " login")
            } else if flow.is_string("claude-auth-login")? {
                (c"claude", " auth login")
            } else {
                return vendor_command(flow, args[1]);
            };
            let mut command = args[1].get(name)?.coerce_string()?;
            command.push_str(suffix);
            flow.from_value(&V::String(command))
        })?,
    )?;
    Ok(api.raw())
}
