//! Express host endpoint used by the gateway for facts owned by this process.
use super::*;
use multicc_core::plugin_routes::{CATEGORY_MAX, DEFAULT_UI, SESSION_ID_MAX};
use std::ffi::CStr;

pub(super) const HOST_PATH: &str = "/api/__host/plugins";

fn clipped<'a>(item: L<'a>, key: &CStr, max: usize) -> Result<L<'a>> {
    if item.get(key)?.kind()? != sys::ValueType::napi_string {
        return text(item, "");
    }
    call(
        item.get(key)?,
        c"slice",
        &[num(item, 0.)?, num(item, max as f64)?],
    )
}

pub(super) fn recheck<'a>(items: L<'a>, still_active: L<'a>) -> Result<L<'a>> {
    let check = function(still_active, "", 1, 1, |active, args| {
        let item = args[0];
        if !object(item)? {
            return flag(active, false);
        }
        let id = clipped(item, c"sessionId", SESSION_ID_MAX)?;
        let category = clipped(item, c"category", CATEGORY_MAX)?;
        flag(active, active.call_plain(&[id, category])?.truthy()?)
    })?;
    call(items, c"map", &[check])
}

fn find<'a>(state: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let id = if body.get(c"id")?.kind()? == sys::ValueType::napi_string {
        body.get(c"id")?
    } else {
        text(body, "")?
    };
    let owner = state.get(c"routes")?;
    let found = if owner.undefined()? {
        state.get(c"findManifest")?.call_plain(&[id])?
    } else {
        discover::find(owner, id)?
    };
    if !found.truthy()? || !found.get(c"manifest")?.truthy()? || !object(found.get(c"manifest")?)? {
        return fields(
            state,
            &[("ok", flag(state, true)?), ("found", flag(state, false)?)],
        );
    }
    let declared = found.get(c"manifest")?.get(c"ui")?;
    let ui = if !declared.truthy()? {
        text(state, DEFAULT_UI)?
    } else if declared.kind()? == sys::ValueType::napi_string {
        declared
    } else {
        return failure(state, text(state, "invalid manifest ui")?);
    };
    fields(
        state,
        &[
            ("ok", flag(state, true)?),
            ("found", flag(state, true)?),
            ("dir", found.get(c"dir")?),
            ("ui", ui),
        ],
    )
}

fn failure<'a>(state: L<'a>, detail: L<'a>) -> Result<L<'a>> {
    fields(
        state,
        &[
            ("ok", flag(state, false)?),
            ("error", fields(state, &[("message", detail)])?),
        ],
    )
}

fn status<'a>(state: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let snapshot = || {
        let usage = state.get(c"usage")?.call(state.get(c"receiver")?, &[])?;
        let host = state.get(c"channelHost")?;
        let plugins = if host.truthy()? {
            call(host, c"status", &[])?
        } else {
            array(state)?
        };
        let payload = fields(
            state,
            &[
                ("ok", flag(state, true)?),
                ("available", flag(state, host.truthy()?)?),
                ("plugins", plugins),
                ("usage", usage),
            ],
        )?;
        send(res, None, payload)
    };
    match snapshot() {
        Ok(reply) => Ok(reply),
        Err(err) => {
            let thrown = message(state, err)?;
            let detail = if thrown.truthy()? && thrown.get(c"message")?.truthy()? {
                thrown.get(c"message")?
            } else {
                thrown
            };
            send(res, None, failure(state, string(detail)?)?)
        }
    }
}

fn handle<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let req = args[0];
    let res = args[1];
    let local = state.get(c"isLocal")?;
    let allowed = if local.undefined()? {
        crate::request_locality::evaluate("local", req)?
    } else {
        local.call_plain(&[req])?
    };
    if !allowed.truthy()? {
        return error(res, 404, "not found", false);
    }
    let body = if req.get(c"body")?.truthy()?
        && object(req.get(c"body")?)?
        && !req.get(c"body")?.is_array()?
    {
        req.get(c"body")?
    } else {
        fields(state, &[])?
    };
    if body.get(c"op")?.is_string("findPlugin")? {
        return send(res, None, find(state, body)?);
    }
    if body.get(c"op")?.is_string("channelStillActive")? {
        let items = if body.get(c"items")?.is_array()? {
            body.get(c"items")?
        } else {
            array(state)?
        };
        let active = recheck(items, state.get(c"stillActive")?)?;
        return send(
            res,
            None,
            fields(state, &[("ok", flag(state, true)?), ("active", active)])?,
        );
    }
    if body.get(c"op")?.is_string("channelsStatus")? {
        return status(state, res);
    }
    error(res, 400, "unknown host operation", false)
}

fn register<'a>(state: L<'a>, app: L<'a>) -> Result<L<'a>> {
    call(
        app,
        c"post",
        &[text(state, HOST_PATH)?, function(state, "", 2, 2, handle)?],
    )?;
    undef(state)
}

fn require_function<'a>(value: L<'a>, label: &str) -> Result<L<'a>> {
    if callable(value)? {
        Ok(value)
    } else {
        Err(value.type_error(&format!("[plugins-host] {label} must be a function")))
    }
}

fn registry_callback<'a>(options: L<'a>, key: &CStr, label: &str) -> Result<L<'a>> {
    let method = if callable(options.get(key)?)? {
        options.get(key)?
    } else {
        let registry = options.get(c"channelRegistry")?;
        if registry.truthy()? {
            options.get(c"channelRegistry")?.get(key)?
        } else {
            registry
        }
    };
    require_function(method, label)
}

pub(super) fn mount<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let app = args[0];
    if !app.truthy()? || !callable(app.get(c"post")?)? {
        return Err(ports.type_error("[plugins-host] Express-compatible app is required"));
    }
    let opts = default_object(args[1])?;
    let find = require_function(opts.get(c"findManifest")?, "findManifest")?;
    let active = registry_callback(opts, c"stillActive", "channelRegistry.stillActive")?;
    let usage = registry_callback(opts, c"usage", "channelRegistry.usage")?;
    let receiver = if callable(opts.get(c"usage")?)? {
        undef(ports)?
    } else {
        opts.get(c"channelRegistry")?
    };
    let host = or_null(opts.get(c"channelHost")?)?;
    if host.truthy()? {
        require_function(host.get(c"status")?, "channelHost.status")?;
    }
    let mut local = opts.get(c"isLocal")?;
    if !local.truthy()? {
        local = opts.get(c"isLocalRequest")?;
    }
    if !local.truthy()? {
        local = undef(ports)?;
    }
    register(
        fields(
            ports,
            &[
                ("findManifest", find),
                ("stillActive", active),
                ("usage", usage),
                ("receiver", receiver),
                ("channelHost", host),
                ("isLocal", local),
            ],
        )?,
        app,
    )
}

pub(super) fn mount_installed<'a>(owner: L<'a>, app: L<'a>) -> Result<L<'a>> {
    let ports = owner.get(c"ports")?;
    let registry = ports.get(c"registry")?;
    let active = require_function(registry.get(c"stillActive")?, "channelRegistry.stillActive")?;
    let usage = require_function(registry.get(c"usage")?, "channelRegistry.usage")?;
    let channel_host = owner.get(c"channelHost")?;
    if channel_host.truthy()? {
        require_function(channel_host.get(c"status")?, "channelHost.status")?;
    }
    let selected = owner.get(c"isLocal")?;
    let local = if selected.equals(ports.get(c"local")?)? {
        undef(owner)?
    } else {
        selected
    };
    register(
        fields(
            owner,
            &[
                ("routes", owner),
                ("stillActive", active),
                ("usage", usage),
                ("receiver", registry),
                ("channelHost", channel_host),
                ("isLocal", local),
            ],
        )?,
        app,
    )
}
