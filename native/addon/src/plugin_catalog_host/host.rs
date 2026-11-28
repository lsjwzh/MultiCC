use super::*;
use std::path::Path;
fn run<'a>(p: L<'a>, file: &str, args: L<'a>) -> Result<L<'a>> {
    let ctx = fields(
        p,
        &[
            ("exec", p.get(c"execFile")?),
            ("file", text(p, file)?),
            ("args", args),
        ],
    )?;
    p.global()?
        .get(c"Promise")?
        .construct(&[function(ctx, "", 2, 2, |c, a| {
            let cb = function(a[0], "", 2, 2, |resolve, a| {
                let value = if a[0].truthy()? {
                    text(resolve, "")?
                } else {
                    call(string(a[1])?, c"trim", &[])?
                };
                resolve.call_plain(&[value])
            })?;
            c.get(c"exec")?.call_plain(&[
                c.get(c"file")?,
                c.get(c"args")?,
                fields(
                    c,
                    &[
                        ("windowsHide", flag(c, true)?),
                        ("timeout", num(c, 3000.)?),
                        ("encoding", text(c, "utf8")?),
                    ],
                )?,
                cb,
            ])
        })?])
}
fn plutil<'a>(p: L<'a>, key: &str, path: L<'a>) -> Result<L<'a>> {
    let args = strings(p, &["-extract", key, "raw", "-o", "-"])?;
    push(args, path)?;
    run(p, "/usr/bin/plutil", args)
}
fn next_candidate(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"ports")?;
    let paths = ctx.get(c"paths")?;
    let mut i = ctx.get(c"i")?.number()? as u32;
    while i < (paths.get(c"length")?.number()? as u32) {
        let path = paths.element(i)?;
        i += 1;
        let plist = call(
            p.get(c"path")?,
            c"join",
            &[path, text(p, "Contents")?, text(p, "Info.plist")?],
        )?;
        if !Path::new(&text_of(plist)?).exists() {
            continue;
        }
        ctx.set(c"i", num(p, i as f64)?)?;
        ctx.set(c"plist", plist)?;
        ctx.set(c"path", path)?;
        return then(plutil(p, "CFBundleIdentifier", plist)?, ctx, |c, a| {
            if !a[0].equals(c.get(c"id")?)? {
                return next_candidate(c);
            }
            then(
                plutil(
                    c.get(c"ports")?,
                    "CFBundleShortVersionString",
                    c.get(c"plist")?,
                )?,
                c,
                |c, a| fields(c, &[("path", c.get(c"path")?), ("version", or_null(a[0])?)]),
            )
        });
    }
    null(p)
}
fn mac_app<'a>(p: L<'a>, app: L<'a>) -> Result<L<'a>> {
    let id = app.get(c"id")?;
    let paths = string_list(app.get(c"macosPaths")?)?;
    let q = format!("kMDItemCFBundleIdentifier == \"{}\"", text_of(id)?);
    let ctx = fields(
        p,
        &[
            ("ports", p),
            ("id", id),
            ("paths", paths),
            ("i", num(p, 0.)?),
        ],
    )?;
    then(
        run(p, "/usr/bin/mdfind", strings(p, &[&q])?)?,
        ctx,
        |c, a| {
            for line in text_of(a[0])?.split('\n').filter(|s| s.ends_with(".app")) {
                push(c.get(c"paths")?, text(c, line)?)?;
            }
            next_candidate(c)
        },
    )
}
fn fetch_next(c: L<'_>) -> Result<L<'_>> {
    let owner = c.get(c"owner")?;
    let p = owner.get(c"ports")?;
    let opts = owner.get(c"opts")?;
    let apps = c.get(c"apps")?;
    let i = c.get(c"i")?.number()? as u32;
    let darwin = owner.get(c"os")?.is_string("darwin")?;
    if i < (apps.get(c"length")?.number()? as u32) {
        let app = apps.element(i)?;
        c.set(c"i", num(c, (i + 1) as f64)?)?;
        c.set(c"app", app)?;
        let probe = opts.get(c"appVersion")?;
        let hit = if !probe.undefined()? {
            probe.call_plain(&[app])?
        } else if darwin {
            mac_app(p, app)?
        } else {
            null(c)?
        };
        return then(hit, c, |c, a| {
            if a[0].truthy()? {
                c.get(c"found")?
                    .define_key(c.get(c"app")?.get(c"id")?, a[0])?;
            }
            fetch_next(c)
        });
    }
    let probe = opts.get(c"osVersion")?;
    let version = if !probe.undefined()? {
        probe.call_plain(&[])?
    } else if darwin {
        run(p, "/usr/bin/sw_vers", strings(p, &["-productVersion"])?)?
    } else {
        call(p.get(c"os")?, c"release", &[])?
    };
    then(version, c, |c, a| {
        let o = c.get(c"owner")?;
        let opts = o.get(c"opts")?;
        let p = o.get(c"ports")?;
        let probe = opts.get(c"agentBuild")?;
        c.set(c"osVersion", or_null(a[0])?)?;
        let build = if !probe.undefined()? {
            probe.call_plain(&[])?
        } else if o.get(c"os")?.is_string("darwin")? {
            p.catch(|| {
                let seen = p.get(c"agent")?.call_plain(&[o.get(c"rootDir")?])?;
                let installed = seen.get(c"installed")?;
                if installed.truthy()? {
                    installed.get(c"build")
                } else {
                    null(c)
                }
            })?
            .unwrap_or(null(c)?)
        } else {
            null(c)?
        };
        then(build, c, |c, a| {
            let o = c.get(c"owner")?;
            let facts = fields(
                c,
                &[
                    ("os", o.get(c"os")?),
                    ("arch", o.get(c"arch")?),
                    ("osVersion", c.get(c"osVersion")?),
                    ("multicc", o.get(c"version")?),
                    ("pluginApi", num(c, 2.)?),
                    ("agentBuild", a[0]),
                    ("apps", c.get(c"found")?),
                ],
            )?;
            o.set(
                c"cached",
                fields(
                    c,
                    &[
                        ("key", c.get(c"key")?),
                        ("at", o.get(c"now")?.call_plain(&[])?),
                        ("facts", facts),
                    ],
                )?,
            )?;
            Ok(facts)
        })
    })
}
pub(super) fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let process = p.get(c"process")?;
    let owner = fields(
        p,
        &[
            ("ports", p),
            ("opts", opts),
            (
                "os",
                default_to(opts.get(c"platform")?, process.get(c"platform")?)?,
            ),
            (
                "arch",
                default_to(opts.get(c"arch")?, process.get(c"arch")?)?,
            ),
            (
                "version",
                fallback_to(opts.get(c"multiccVersion")?, p.get(c"version")?)?,
            ),
            (
                "rootDir",
                default_to(opts.get(c"rootDir")?, p.get(c"rootDir")?)?,
            ),
            (
                "now",
                default_to(
                    opts.get(c"now")?,
                    function(p, "now", 0, 0, |p, _| now_js(p))?,
                )?,
            ),
        ],
    )?;
    function(owner, "hostFacts", 0, 1, |o, a| {
        async_result(o, || {
            let apps = default_to(a[0], array(o)?)?;
            let ids = array(o)?;
            for app in items(apps)? {
                push(ids, app.get(c"id")?)?;
            }
            call(ids, c"sort", &[])?;
            let key = call(ids, c"join", &[text(o, ",")?])?;
            let cached = o.get(c"cached")?;
            if cached.truthy()?
                && key.equals(cached.get(c"key")?)?
                && o.get(c"now")?.call_plain(&[])?.number()? - cached.get(c"at")?.number()? < 60000.
            {
                return cached.get(c"facts");
            }
            fetch_next(fields(
                o,
                &[
                    ("owner", o),
                    ("apps", apps),
                    ("found", fields(o, &[])?),
                    ("key", key),
                    ("i", num(o, 0.)?),
                ],
            )?)
        })
    })
}
