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
