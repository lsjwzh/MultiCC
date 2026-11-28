//! Installed manifests, catalog management endpoints, and command-engine dispatch.
use crate::host_api::*;
use crate::plugin_catalog_host::{
    default_to, fallback_to, items, message, or_null, push, strings, valid_id,
};
use napi_derive::napi;
mod catalog;
mod discover;
mod routes;
mod run;
fn create_channel<'a>(o: L<'a>, r: L<'a>) -> Result<L<'a>> {
    if !r.truthy()? {
        return null(o);
    }
    let p = o.get(c"ports")?;
    let mut dir = r.get(c"dataDir")?;
    if !dir.truthy()? {
        let user = o.get(c"userDir")?;
        if !user.truthy()? {
            return null(o);
        }
        let path = p.get(c"path")?;
        dir = call(
            path,
            c"join",
            &[call(path, c"dirname", &[user])?, text(o, "plugins-data")?],
        )?;
    }
    let base = r.get(c"baseUrl")?;
    let base = if base.truthy()? {
        base
    } else if r.get(c"port")?.truthy()? {
        function(r, "baseUrl", 0, 0, |r, _| {
            text(
                r,
                &format!("http://127.0.0.1:{}", fold_string(call(r, c"port", &[])?)?),
            )
        })?
    } else {
        null(o)?
    };
    let cfg = fields(
        o,
        &[
            (
                "discover",
                function(o, "discover", 0, 0, |o, _| discover::residents(o))?,
            ),
            ("dataDir", dir),
            ("platform", o.get(c"platform")?),
            ("baseUrl", base),
            (
                "alert",
                fallback_to(
                    r.get(c"alert")?,
                    function(o, "alert", 0, 0, |o, _| undef(o))?,
                )?,
            ),
            ("logger", o.get(c"logger")?),
        ],
    )?;
    cfg.spread_from(r.get(c"overrides")?)?;
    let host = call(p.get(c"channel")?, c"createChannelHost", &[cfg])?;
    if host.truthy()? {
        if !r.get(c"autoStart")?.is_false()? {
            call(host, c"start", &[])?;
        }
        if !r.get(c"register")?.is_false()? {
            call(p.get(c"registry")?, c"register", &[host])?;
        }
    }
    Ok(host)
}
fn configured_dir<'a>(deps: L<'a>, key: &std::ffi::CStr, nested: &std::ffi::CStr) -> Result<L<'a>> {
    let direct = deps.get(key)?;
    if direct.truthy()? {
        return Ok(direct);
    }
    let paths = deps.get(c"paths")?;
    if paths.truthy()? {
        or_null(paths.get(nested)?)
    } else {
        null(deps)
    }
}
fn create<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let deps = args[0];
    for (k, name) in [
        (c"pluginsDir", "pluginsDir"),
        (c"platform", "platform"),
        (c"arch", "arch"),
        (c"logger", "logger"),
    ] {
        if !deps.truthy()? || !deps.get(k)?.truthy()? {
            return Err(p.type_error(&format!("[plugins] {name} is required")));
        }
    }
    let user = configured_dir(deps, c"userPluginsDir", c"userPluginsDir")?;
    let dir = configured_dir(deps, c"catalogDir", c"pluginCatalogDir")?;
    let platform = deps.get(c"platform")?;
    let arch = deps.get(c"arch")?;
    let logger = deps.get(c"logger")?;
    let o = fields(
        p,
        &[
            ("ports", p),
            ("pluginsDir", deps.get(c"pluginsDir")?),
            ("userDir", user),
            ("platform", platform),
            ("arch", arch),
            ("logger", logger),
            (
                "isLocal",
                fallback_to(deps.get(c"isLocalRequest")?, p.get(c"local")?)?,
            ),
        ],
    )?;
    let api = p.get(c"catalog")?;
    let mut catalog = deps.get(c"catalog")?;
    if !catalog.truthy()? {
        catalog = if dir.truthy()? {
            call(
                api,
                c"createPluginCatalog",
                &[fields(p, &[("cacheDir", dir), ("logger", logger)])?],
            )?
        } else {
            null(p)?
        }
    }
    let mut facts = deps.get(c"hostFacts")?;
    if !facts.truthy()? {
        facts = call(
            api,
            c"createHostFacts",
            &[fields(p, &[("platform", platform), ("arch", arch)])?],
        )?
    }
    let mut installer = deps.get(c"installer")?;
    if !installer.truthy()? {
        installer = if user.truthy()? {
            let inspect = function(o, "inspect", 2, 2, |o, a| {
                let p = o.get(c"ports")?;
                let found = discover::manifest(p, a[0], a[1])?;
                if !found.truthy()? {
                    return null(o);
                }
                fields(
                    o,
                    &[
                        ("manifest", found.get(c"manifest")?),
                        (
                            "binary",
                            discover::binary(p, found, o.get(c"platform")?, o.get(c"arch")?)?,
                        ),
                    ],
                )
            })?;
            call(
                p.get(c"installer")?,
                c"createPluginInstaller",
                &[fields(
                    o,
                    &[
                        ("root", user),
                        ("platform", platform),
                        ("fetch", fallback_to(deps.get(c"fetch")?, p.get(c"fetch")?)?),
                        ("inspect", inspect),
                        ("logger", logger),
                    ],
                )?],
            )?
        } else {
            null(p)?
        };
    }
    o.set(c"catalog", catalog)?;
    o.set(c"facts", facts)?;
    o.set(c"installer", installer)?;
    if catalog.truthy()?
        && deps.get(c"autoRefresh")?.truthy()?
        && !p
            .get(c"process")?
            .get(c"env")?
            .get(c"MULTICC_PLUGIN_CATALOG_OFFLINE")?
            .is_string("1")?
    {
        call(catalog, c"start", &[])?;
    }
    let channel = create_channel(o, deps.get(c"resident")?)?;
    o.set(c"channelHost", channel)?;
    let out = methods(
        o,
        &[
            ("mount", 1, |o, a| routes::mount(o, a[0])),
            ("listPlugins", 0, |o, _| discover::scan(o)?.get(c"plugins")),
            ("scan", 0, |o, _| discover::scan(o)),
            ("catalogPayload", 1, |o, a| catalog::payload(o, a[0], false)),
            ("runPluginCommand", 3, |o, a| {
                run::command(o, a[0], a[1], a[2])
            }),
        ],
    )?;
    out.set(c"catalog", catalog)?;
    out.set(c"installer", installer)?;
    out.set(c"channelHost", channel)?;
    Ok(out)
}
#[napi]
pub fn plugins_routes_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createPluginsRoutes", 1, 1, create),
            ("pluginEntry", 4, 5, |p, a| {
                discover::entry(
                    p,
                    a[0],
                    a[1],
                    a[2],
                    a[3],
                    default_to(a[4], text(p, "builtin")?)?,
                )
            }),
            ("readManifest", 2, 2, |p, a| {
                discover::manifest(p, a[0], a[1])
            }),
            ("resolveBinary", 3, 3, |p, a| {
                discover::binary(p, a[0], a[1], a[2])
            }),
        ],
    )?;
    Ok(api.raw())
}
