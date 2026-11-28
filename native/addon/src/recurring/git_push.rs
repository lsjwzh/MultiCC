//! Push probes share the resident RepoActor queue. Cache publication happens
//! only on completed probes; stale readers never acquire another git lane.
use super::*;
use napi_derive::napi;
fn key<'a>(p: L<'a>, cwd: L<'a>, branch: L<'a>) -> Result<L<'a>> {
    text(
        p,
        &format!(
            "{}\0{}",
            strval(cwd)?,
            strval(either(branch, text(p, "")?)?)?
        ),
    )
}
fn args<'a>(p: L<'a>, parts: &[&str]) -> Result<L<'a>> {
    p.from_value(&V::Array(parts.iter().map(|s| V::from(*s)).collect()))
}
fn probe<'a>(
    f: L<'a>,
    argv: &[&str],
    exists: bool,
    step: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    let q = fields(f, &[("frame", f), ("exists", flag(f, exists)?)])?;
    let pending = async_result(f, || {
        f.get(c"owner")?
            .get(c"runGit")?
            .call_plain(&[f.get(c"cwd")?, args(f, argv)?])
    })?;
    let answer = then(pending, q, |q, v| {
        if q.get(c"exists")?.truthy()? {
            flag(q, true)
        } else {
            call(v, c"trim", &[])
        }
    })?;
    let answer = caught(answer, q, |q, _| {
        if q.get(c"exists")?.truthy()? {
            flag(q, false)
        } else {
            text(q, "")
        }
    })?;
    then(answer, f, step)
}
fn base<'a>(f: L<'a>, available: bool, remote: bool, reason: Option<&str>) -> Result<L<'a>> {
    let out = fields(
        f,
        &[
            ("available", flag(f, available)?),
            ("hasRemote", flag(f, remote)?),
        ],
    )?;
    if let Some(reason) = reason {
        if available {
            out.set(c"branch", f.get(c"branch")?)?;
        }
        out.set(c"ahead", num(f, 0.)?)?;
        out.set(c"behind", num(f, 0.)?)?;
        out.set(c"dirty", either(f.get(c"dirty")?, num(f, 0.)?)?)?;
        out.set(c"reason", text(f, reason)?)?;
    }
    Ok(out)
}
fn compute<'a>(o: L<'a>, cwd: L<'a>, branch: L<'a>) -> Result<L<'a>> {
    let f = fields(o, &[("owner", o), ("cwd", cwd), ("requested", branch)])?;
    probe(f, &["rev-parse", "--is-inside-work-tree"], false, |f, v| {
        if !v.is_string("true")? {
            return base(f, false, false, Some("not-a-git-repository"));
        }
        probe(f, &["status", "--porcelain"], false, |f, v| {
            let dirty = strval(v)?.split('\n').filter(|s| !s.is_empty()).count();
            f.set(c"dirty", num(f, dirty as f64)?)?;
            if f.get(c"requested")?.truthy()? {
                branch_received(f, f.get(c"requested")?)
            } else {
                probe(
                    f,
                    &["symbolic-ref", "--short", "HEAD"],
                    false,
                    branch_received,
                )
            }
        })
    })
}
fn branch_received<'a>(f: L<'a>, v: L<'a>) -> Result<L<'a>> {
    f.set(c"branch", v)?;
    if !v.truthy()? {
        return base(f, false, false, Some("no-branch"));
    }
    let reference = format!("refs/heads/{}", strval(v)?);
    probe(f, &["rev-parse", "--verify", &reference], true, |f, v| {
        if !v.truthy()? {
            return base(f, false, false, Some("no-branch"));
        }
        probe(f, &["remote"], false, |f, v| {
            let remotes = strval(v)?
                .split('\n')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if remotes.is_empty() {
                return base(f, true, false, Some("no-remote"));
            }
            let remote = if remotes.iter().any(|s| s == "origin") {
                "origin"
            } else {
                &remotes[0]
            };
            f.set(c"remote", text(f, remote)?)?;
            let reference = format!("refs/heads/{}", strval(f.get(c"branch")?)?);
            probe(
                f,
                &["for-each-ref", "--format=%(upstream:short)", &reference],
                false,
                upstream,
            )
        })
    })
}
fn upstream<'a>(f: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let upstream = strval(v)?;
    f.set(c"upstream", v)?;
    let (remote, branch) = if let Some((r, b)) = upstream.split_once('/') {
        (r.to_owned(), b.to_owned())
    } else if !upstream.is_empty() {
        (upstream.clone(), String::new())
    } else {
        (strval(f.get(c"remote")?)?, strval(f.get(c"branch")?)?)
    };
    f.set(c"remote", text(f, &remote)?)?;
    f.set(c"remoteBranch", text(f, &branch)?)?;
    let reference = if upstream.is_empty() {
        format!("{remote}/{branch}")
    } else {
        upstream
    };
    f.set(c"remoteRef", text(f, &reference)?)?;
    probe(f, &["rev-parse", "--verify", &reference], true, |f, v| {
        f.set(c"remoteBranchExists", v)?;
        let branch = strval(f.get(c"branch")?)?;
        let remote = strval(f.get(c"remoteRef")?)?;
        let range = if v.truthy()? {
            format!("{remote}..{branch}")
        } else {
            branch
        };
        probe(f, &["rev-list", "--count", &range], false, |f, v| {
            let count = call(
                f.global()?.get(c"parseInt")?,
                c"call",
                &[undefined(f)?, either(v, text(f, "0")?)?, num(f, 10.)?],
            )?
            .number()?;
            f.set(
                c"ahead",
                num(f, if count.is_finite() { count } else { 0. })?,
            )?;
            if !f.get(c"remoteBranchExists")?.truthy()? {
                return finish(f, num(f, 0.)?);
            }
            let range = format!(
                "{}..{}",
                strval(f.get(c"branch")?)?,
                strval(f.get(c"remoteRef")?)?
            );
            probe(f, &["rev-list", "--count", &range], false, |f, v| {
                let n = f
                    .global()?
                    .get(c"parseInt")?
                    .call_plain(&[either(v, text(f, "0")?)?, num(f, 10.)?])?
                    .number()?;
                finish(f, num(f, if n.is_finite() { n } else { 0. })?)
            })
        })
    })
}
fn finish<'a>(f: L<'a>, behind: L<'a>) -> Result<L<'a>> {
    let out = base(f, true, true, None)?;
    for k in [c"branch", c"remote", c"remoteBranch"] {
        out.set(k, f.get(k)?)?;
    }
    out.set(c"upstream", either(f.get(c"upstream")?, null(f)?)?)?;
    out.set(
        c"upstreamConfigured",
        flag(f, f.get(c"upstream")?.truthy()?)?,
    )?;
    out.set(c"remoteBranchExists", f.get(c"remoteBranchExists")?)?;
    out.set(c"ahead", f.get(c"ahead")?)?;
    out.set(c"behind", behind)?;
    out.set(c"dirty", f.get(c"dirty")?)?;
    Ok(out)
}
fn refresh<'a>(o: L<'a>, key: L<'a>, cwd: L<'a>, branch: L<'a>) -> Result<L<'a>> {
    let flights = o.get(c"inflight")?;
    let existing = call(flights, c"get", &[key])?;
    if existing.truthy()? {
        return Ok(existing);
    }
    let f = fields(o, &[("owner", o), ("key", key)])?;
    let p = then(compute(o, cwd, branch)?, f, |f, v| {
        let o = f.get(c"owner")?;
        call(
            o.get(c"cache")?,
            c"set",
            &[f.get(c"key")?, fields(f, &[("value", v), ("ts", now(f)?)])?],
        )?;
        call(o.get(c"inflight")?, c"delete", &[f.get(c"key")?])?;
        Ok(v)
    })?;
    let p = caught(p, f, |f, e| {
        call(
            f.get(c"owner")?.get(c"inflight")?,
            c"delete",
            &[f.get(c"key")?],
        )?;
        Err(e.throw_error())
    })?;
    call(flights, c"set", &[key, p])?;
    Ok(p)
}
fn state<'a>(o: L<'a>, cwd: L<'a>, branch: L<'a>, force: bool) -> Result<L<'a>> {
    let k = key(o, cwd, branch)?;
    if force {
        return refresh(o, k, cwd, branch);
    }
    let hit = call(o.get(c"cache")?, c"get", &[k])?;
    if hit.truthy()? && now(o)?.number()? - hit.get(c"ts")?.number()? < 10_000. {
        return resolve(hit.get(c"value")?);
    }
    let p = refresh(o, k, cwd, branch)?;
    if hit.truthy()? {
        caught(p, o, |o, _| undefined(o))?;
        resolve(hit.get(c"value")?)
    } else {
        Ok(p)
    }
}
fn push<'a>(o: L<'a>, cwd: L<'a>, branch: L<'a>) -> Result<L<'a>> {
    let f = fields(o, &[("owner", o), ("cwd", cwd), ("requested", branch)])?;
    then(state(o, cwd, branch, true)?, f, |f, before| {
        if !before.get(c"available")?.truthy()? {
            return Err(failure(f, "", "当前目录没有可推送的分支")?);
        }
        if !before.get(c"hasRemote")?.truthy()? {
            return Err(failure(f, "", "未设置 remote")?);
        }
        f.set(c"before", before)?;
        if before.get(c"ahead")?.is_number(0.)? {
            return fields(
                f,
                &[
                    ("pushed", flag(f, false)?),
                    ("before", before),
                    ("after", before),
                ],
            );
        }
        let remote = strval(before.get(c"remote")?)?;
        let b = strval(before.get(c"branch")?)?;
        let argv = if before.get(c"upstreamConfigured")?.truthy()? {
            vec![
                "push".to_owned(),
                remote,
                format!("{b}:{}", strval(before.get(c"remoteBranch")?)?),
            ]
        } else {
            vec!["push".to_owned(), "--set-upstream".to_owned(), remote, b]
        };
        let argv = argv.iter().map(String::as_str).collect::<Vec<_>>();
        let q = async_result(f, || {
            f.get(c"owner")?
                .get(c"runGit")?
                .call_plain(&[f.get(c"cwd")?, args(f, &argv)?])
        })?;
        let q = caught(q, f, |f, e| {
            let detail = call(
                string(either(
                    e.optional(c"stderr")?,
                    either(e.optional(c"message")?, text(f, "")?)?,
                )?)?,
                c"trim",
                &[],
            )?;
            let e = f
                .global()?
                .get(c"Error")?
                .construct(&[either(detail, text(f, "git push failed")?)?])?;
            Err(e.throw_error())
        })?;
        then(q, f, |f, _| {
            then(
                state(
                    f.get(c"owner")?,
                    f.get(c"cwd")?,
                    f.get(c"before")?.get(c"branch")?,
                    true,
                )?,
                f,
                |f, after| {
                    fields(
                        f,
                        &[
                            ("pushed", flag(f, true)?),
                            ("before", f.get(c"before")?),
                            ("after", after),
                        ],
                    )
                },
            )
        })
    })
}
#[napi]
pub fn directory_push_api(env: Env, run_git: Unknown<'_>) -> Result<sys::napi_value> {
    let port = L::new(&env, run_git);
    let o = fields(
        port,
        &[
            ("runGit", port),
            ("cache", map(port)?),
            ("inflight", map(port)?),
        ],
    )?;
    let api = fields(o, &[])?;
    api.set(
        c"directoryPushState",
        function(o, "directoryPushState", 2, 3, |o, a| {
            let opts = default_object(a[2])?;
            state(o, a[0], a[1], opts.get(c"force")?.truthy()?)
        })?,
    )?;
    api.set(
        c"invalidate",
        function(o, "invalidate", 2, 2, |o, a| {
            call(o.get(c"cache")?, c"delete", &[key(o, a[0], a[1])?])?;
            undefined(o)
        })?,
    )?;
    api.set(
        c"pushDirectory",
        function(o, "pushDirectory", 2, 2, |o, a| {
            async_result(o, || push(o, a[0], a[1]))
        })?,
    )?;
    Ok(api.raw())
}
