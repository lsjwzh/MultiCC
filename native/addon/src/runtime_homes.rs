//! Only collection enumeration propagates. A vanished child is skipped locally.
use crate::route_response::*;
use napi_derive::napi;

fn directory(p: L<'_>, path: L<'_>) -> Result<bool> {
    let stat = call(p, c"stat", &[path])?;
    Ok(!call(stat, c"isSymbolicLink", &[])?.truthy()?
        && call(stat, c"isDirectory", &[])?.truthy()?)
}
fn newest<'a>(p: L<'a>, home: L<'a>) -> Result<L<'a>> {
    let mut newest = num(p, 0.)?;
    p.catch(|| {
        newest = call(p, c"stat", &[home])?.get(c"mtimeMs")?;
        call(p, c"list", &[home])?.for_each(|name| {
            p.catch(|| {
                let child = call(p, c"join", &[home, name])?;
                let m = call(p, c"stat", &[child])?.get(c"mtimeMs")?;
                if call(p, c"newer", &[m, newest])?.truthy()? {
                    newest = m;
                }
                Ok(())
            })?;
            Ok(())
        })
    })?;
    Ok(newest)
}
#[napi]
pub fn runtime_home_ttl(days: f64) -> f64 {
    if days.is_finite() && days > 0. {
        days * 24. * 3600. * 1000.
    } else {
        0.
    }
}
#[napi]
pub fn sweep_runtime_homes(
    env: Env,
    ports: Unknown<'_>,
    root: Unknown<'_>,
    names: Unknown<'_>,
    cutoff: f64,
) -> Result<u32> {
    let p = L::new(&env, ports);
    let root = L::new(&env, root);
    let cutoff = num(p, cutoff)?;
    let mut removed = 0;
    L::new(&env, names).for_each(|name| {
        let dir = call(p, c"join", &[root, name])?;
        if p.catch(|| directory(p, dir))? != Some(true) {
            return Ok(());
        }
        call(p, c"list", &[dir])?.for_each(|entry| {
            let home = call(p, c"join", &[dir, entry])?;
            p.catch(|| {
                if directory(p, home)?
                    && !call(p, c"recent", &[newest(p, home)?, cutoff])?.truthy()?
                {
                    call(p, c"remove", &[home])?;
                    removed += 1;
                }
                Ok(())
            })?;
            Ok(())
        })
    })?;
    Ok(removed)
}

#[napi]
pub fn runtime_home_sweeper(
    env: Env,
    ports: Unknown<'_>,
    raw: Unknown<'_>,
    ttl: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::host_methods::{arg, env as host_env, function};
    let p = L::new(&env, ports);
    let path = p.get(c"path")?;
    let raw = L::new(&env, raw);
    let err = || p.type_error("runtime homes janitor requires a bounded absolute root");
    if !call(path, c"isAbsolute", &[raw])?.truthy()? {
        return Err(err());
    }
    let root = call(path, c"resolve", &[raw])?;
    if root.equals(call(path, c"parse", &[root])?.get(c"root")?)? {
        return Err(err());
    }
    let ttl = runtime_home_ttl(L::new(&env, ttl).explicit_number()?);
    let names = V::Array(
        [
            "codex-session-homes",
            "codex-homes",
            "codex-attempt-homes",
            "zcode-homes",
        ]
        .into_iter()
        .map(V::from)
        .collect(),
    );
    let owner = fields(
        p,
        &[
            ("ports", p),
            ("root", root),
            ("names", p.from_value(&names)?),
        ],
    )?;
    Ok(function(owner, "sweep", 0, 0, move |ctx, _| {
        if ttl <= 0. {
            return num(ctx, 0.);
        }
        let p = ctx.get(c"ports")?;
        let root = ctx.get(c"root")?;
        let removed = sweep_runtime_homes(
            host_env(p),
            arg(p)?,
            arg(root)?,
            arg(ctx.get(c"names")?)?,
            call(p, c"now", &[])?.explicit_number()? - ttl,
        )?;
        if removed > 0 {
            let msg = multicc_core::js::JsString::concat(&[
                &format!(
                    "[multicc/runtime-homes] cleaned up {removed} stale CLI session home(s) under "
                )
                .as_str()
                .into(),
                &root.coerce_string()?,
            ]);
            call(p, c"log", &[p.from_value(&V::String(msg))?])?;
        }
        num(p, removed as f64)
    })?
    .raw())
}
