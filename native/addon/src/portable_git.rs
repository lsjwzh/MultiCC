//! PATH priority for the bundled Git. Node resolves platform-specific paths
//! and performs the strict assignment to the caller's environment object.
use crate::route_response::*;
use napi_derive::napi;

fn installed<'a>(p: L<'a>, target: L<'a>) -> Result<bool> {
    Ok(p.catch(|| call(p, c"access", &[target]))?.is_some())
}
#[napi]
pub fn portable_git_installed(env: Env, ports: Unknown<'_>, target: Unknown<'_>) -> Result<bool> {
    installed(L::new(&env, ports), L::new(&env, target))
}
#[napi]
pub fn portable_git_add_to_path(env: Env, ports: Unknown<'_>, target: Unknown<'_>) -> Result<bool> {
    let p = L::new(&env, ports);
    let target = L::new(&env, target);
    if p.get(c"platform")?.is_string("win32")? || !installed(p, target)? {
        return Ok(false);
    }
    let bin = call(p, c"bin", &[target])?;
    let dirs = call(p, c"parts", &[target])?;
    if call(dirs, c"includes", &[bin])?.truthy()? {
        return Ok(false);
    }
    let at = call(dirs, c"indexOf", &[text(p, "/usr/bin")?])?.number()?;
    call(dirs, c"splice", &[num(p, at.max(0.))?, num(p, 0.)?, bin])?;
    call(p, c"set", &[target, dirs])?;
    Ok(true)
}
