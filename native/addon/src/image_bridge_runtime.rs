//! Build the official image worker's credential resolvers. Re-read the account
//! list and home on each request so logins and expiry changes take effect.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

fn default_file(p: L<'_>) -> Result<L<'_>> {
    call(
        p.get(c"path")?,
        c"join",
        &[
            p.get(c"home")?.call_plain(&[])?,
            text(p, ".codex")?,
            text(p, "auth.json")?,
        ],
    )
}

#[napi]
pub fn official_image_bridge_ports(
    env: Env,
    opts: Unknown<'_>,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let opts = default_object(L::new(&env, opts))?;
    let host = L::new(&env, host);
    let p = fields(
        host,
        &[
            ("accounts", opts.get(c"officialAccounts")?),
            ("providers", opts.get(c"providers")?),
            ("home", host.get(c"home")?),
            ("path", host.get(c"path")?),
            ("officialId", host.get(c"officialId")?),
        ],
    )?;
    let auth = function(p, "resolveAuthFile", 1, 1, |p, a| {
        let id = p.get(c"officialId")?.call_plain(&[a[0]])?;
        if id.truthy()? {
            call(p.get(c"accounts")?, c"codexAuthFile", &[id])
        } else {
            default_file(p)
        }
    })?;
    let fallback = function(p, "fallbackAuthFiles", 0, 0, |p, _| {
        let files = p.from_value(&V::Array(vec![]))?;
        files.set_element(0, default_file(p)?)?;
        let accounts = p.get(c"accounts")?;
        let list = call(accounts, c"listCodexAccounts", &[])?;
        let eligible = function(p, "eligible", 1, 1, |p, a| {
            flag(
                p,
                a[0].get(c"loggedIn")?.truthy()? && !a[0].get(c"expired")?.truthy()?,
            )
        })?;
        let selected = call(list, c"filter", &[eligible])?;
        let to_file = function(accounts, "authFile", 1, 1, |accounts, a| {
            call(accounts, c"codexAuthFile", &[a[0].get(c"id")?])
        })?;
        let paths = call(selected, c"map", &[to_file])?;
        paths.for_each(|file| {
            call(files, c"push", &[file])?;
            Ok(())
        })?;
        Ok(files)
    })?;
    Ok(fields(
        opts,
        &[
            ("artifactsDir", opts.get(c"paths")?.get(c"artifactsDir")?),
            ("resolveSessionCwd", opts.get(c"resolveSessionCwd")?),
            (
                "getProvider",
                function(p, "getProvider", 2, 2, |p, a| {
                    call(p.get(c"providers")?, c"getProvider", a)
                })?,
            ),
            ("resolveAuthFile", auth),
            ("fallbackAuthFiles", fallback),
            ("registerArtifact", opts.get(c"registerArtifact")?),
            ("codexCommand", opts.get(c"codexCommand")?),
        ],
    )?
    .raw())
}
