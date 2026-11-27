//! The live API uses Node's platform and filesystem primitives. Older native
//! clients may still supply the four callbacks of the original ports contract.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;

#[derive(Clone, Copy)]
enum Host<'a> {
    Live(L<'a>),
    Legacy(L<'a>),
}

fn directory<'a>(ports: L<'a>, target: L<'a>) -> Result<L<'a>> {
    let custom = read(target, c"MULTICC_PORTABLE_GIT_DIR")?;
    if custom.truthy()? {
        return Ok(custom);
    }
    let home = call(ports.get(c"os")?, c"homedir", &[])?;
    call(
        ports.get(c"path")?,
        c"join",
        &[home, text(ports, ".multicc")?, text(ports, "git")?],
    )
}

impl<'a> Host<'a> {
    fn bin(self, target: L<'a>) -> Result<L<'a>> {
        match self {
            Self::Legacy(p) => call(p, c"bin", &[target]),
            Self::Live(p) => call(
                p.get(c"path")?,
                c"join",
                &[directory(p, target)?, text(p, "bin")?],
            ),
        }
    }
    fn installed(self, target: L<'a>) -> Result<bool> {
        Ok(target
            .catch(|| match self {
                Self::Legacy(p) => call(p, c"access", &[target]),
                Self::Live(p) => {
                    let file = call(
                        p.get(c"path")?,
                        c"join",
                        &[self.bin(target)?, text(p, "git")?],
                    )?;
                    let fs = p.get(c"fs")?;
                    call(
                        fs,
                        c"accessSync",
                        &[file, fs.get(c"constants")?.get(c"X_OK")?],
                    )
                }
            })?
            .is_some())
    }
    fn add_to_path(self, target: L<'a>) -> Result<bool> {
        let platform = match self {
            Self::Legacy(p) => p.get(c"platform")?,
            Self::Live(p) => p.get(c"process")?.get(c"platform")?,
        };
        if platform.is_string("win32")? || !self.installed(target)? {
            return Ok(false);
        }
        let bin = self.bin(target)?;
        let dirs = match self {
            Self::Legacy(p) => call(p, c"parts", &[target])?,
            Self::Live(p) => {
                let path = string(fallback(target.get(c"PATH")?, V::from(""))?)?;
                let parts = call(path, c"split", &[p.get(c"path")?.get(c"delimiter")?])?;
                call(parts, c"filter", &[p.global()?.get(c"Boolean")?])?
            }
        };
        if call(dirs, c"includes", &[bin])?.truthy()? {
            return Ok(false);
        }
        let at = call(dirs, c"indexOf", &[text(target, "/usr/bin")?])?.number()?;
        call(
            dirs,
            c"splice",
            &[num(target, at.max(0.))?, num(target, 0.)?, bin],
        )?;
        match self {
            Self::Legacy(p) => {
                call(p, c"set", &[target, dirs])?;
            }
            Self::Live(p) => {
                let joined = call(dirs, c"join", &[p.get(c"path")?.get(c"delimiter")?])?;
                call(p, c"setPath", &[target, joined])?;
            }
        }
        Ok(true)
    }
}

#[napi]
pub fn portable_git_installed(env: Env, ports: Unknown<'_>, target: Unknown<'_>) -> Result<bool> {
    Host::Legacy(L::new(&env, ports)).installed(L::new(&env, target))
}
#[napi]
pub fn portable_git_add_to_path(env: Env, ports: Unknown<'_>, target: Unknown<'_>) -> Result<bool> {
    Host::Legacy(L::new(&env, ports)).add_to_path(L::new(&env, target))
}

fn environment<'a>(p: L<'a>, target: L<'a>) -> Result<L<'a>> {
    if target.undefined()? {
        p.get(c"process")?.get(c"env")
    } else {
        Ok(target)
    }
}
#[napi]
pub fn portable_git_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "portableGitDir",
                function(p, "portableGitDir", 0, 1, |p, a| {
                    directory(p, environment(p, a[0])?)
                })?,
            ),
            (
                "portableGitBin",
                function(p, "portableGitBin", 0, 1, |p, a| {
                    Host::Live(p).bin(environment(p, a[0])?)
                })?,
            ),
            (
                "installScriptPath",
                function(p, "installScriptPath", 0, 0, |p, _| {
                    call(
                        p.get(c"path")?,
                        c"join",
                        &[p.get(c"pkgRoot")?, text(p, "install-git.sh")?],
                    )
                })?,
            ),
            (
                "isInstalled",
                function(p, "isInstalled", 0, 1, |p, a| {
                    flag(p, Host::Live(p).installed(environment(p, a[0])?)?)
                })?,
            ),
            (
                "addToPath",
                function(p, "addToPath", 0, 1, |p, a| {
                    flag(p, Host::Live(p).add_to_path(environment(p, a[0])?)?)
                })?,
            ),
        ],
    )?
    .raw())
}
