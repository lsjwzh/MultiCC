//! Supervise an ordered set of host-owned Codex refreshers. The account IDs and
//! refresher objects remain live V8 values, including when the host edits the Map.
use crate::{
    host_methods::{async_result, default_object, function},
    js_iteration::read,
    route_response::*,
};
use napi_derive::napi;

fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}

fn caught<'a>(p: L<'a>, error: napi::Error) -> Result<L<'a>> {
    if let Some(exception) = p.exception_value()? {
        return Ok(exception);
    }
    p.global()?
        .get(c"Error")?
        .construct(&[text(p, &error.reason)?])
}

fn warn<'a>(s: L<'a>, event: &str, id: L<'a>, error: L<'a>) -> Result<()> {
    let detail = fields(s, &[("accountId", id), ("error", read(error, c"message")?)])?;
    call(s.get(c"logger")?, c"warn", &[text(s, event)?, detail])?;
    Ok(())
}

fn make_refresher<'a>(s: L<'a>, account: L<'a>) -> Result<L<'a>> {
    let factory = s.get(c"makeRefresher")?;
    if factory.kind()? == sys::ValueType::napi_function {
        return factory.call_plain(&[account]);
    }
    let accounts = s.get(c"accounts")?;
    let auth_file = call(accounts, c"codexAuthFile", &[account.get(c"id")?])?;
    let host = s.get(c"host")?;
    let context = fields(
        s,
        &[("host", host), ("account", account), ("accounts", accounts)],
    )?;
    let build_env = function(context, "buildEnv", 0, 0, |ctx, _| {
        let host = ctx.get(c"host")?;
        let source = crate::js_live::spread(host.get(c"process")?.get(c"env")?)?;
        let env = host.get(c"stripOpenAiEnv")?.call_plain(&[source])?;
        let dir = call(
            ctx.get(c"accounts")?,
            c"codexDir",
            &[ctx.get(c"account")?.get(c"id")?],
        )?;
        env.set(c"CODEX_HOME", dir)?;
        Ok(env)
    })?;
    let options = fields(
        s,
        &[
            ("logger", s.get(c"logger")?),
            ("authFile", auth_file),
            ("buildEnv", build_env),
        ],
    )?;
    host.get(c"createCodexOAuthRefresher")?
        .call_plain(&[options])
}

fn sync(s: L<'_>) -> Result<()> {
    let Some(list) = s.catch(|| call(s.get(c"accounts")?, c"listCodexAccounts", &[]))? else {
        return Ok(());
    };
    let seen = s.global()?.get(c"Set")?.construct(&[])?;
    let refreshers = s.get(c"refreshers")?;
    let copies = s.get(c"cliCopies")?;
    call(copies, c"clear", &[])?;
    list.for_each(|account| {
        call(seen, c"add", &[read(account, c"id")?])?;
        if account.get(c"cliCopy")?.truthy()? {
            call(copies, c"add", &[account.get(c"id")?])?;
        }
        if !account.get(c"loggedIn")?.truthy()?
            || call(refreshers, c"has", &[account.get(c"id")?])?.truthy()?
        {
            return Ok(());
        }
        let install = || {
            let set = refreshers.get(c"set")?;
            let id = account.get(c"id")?;
            set.call(refreshers, &[id, make_refresher(s, account)?])
        };
        if let Err(error) = install() {
            let cause = caught(s, error)?;
            warn(
                s,
                "codex_account_refresher_create_failed",
                account.get(c"id")?,
                cause,
            )?;
        }
        Ok(())
    })?;
    let keys = call(
        s.global()?.get(c"Array")?,
        c"from",
        &[call(refreshers, c"keys", &[])?],
    )?;
    keys.for_each(|id| {
        if !call(seen, c"has", &[id])?.truthy()? {
            call(refreshers, c"delete", &[id])?;
        }
        Ok(())
    })
}

fn push_result<'a>(run: L<'a>, id: L<'a>, outcome: L<'a>) -> Result<()> {
    let row = fields(run, &[("accountId", id), ("outcome", outcome)])?;
    call(run.get(c"results")?, c"push", &[row])?;
    Ok(())
}

fn check_next(run: L<'_>) -> Result<L<'_>> {
    let state = run.get(c"state")?;
    let it = run.get(c"iterator")?;
    while let Some(entry) = it.iterator_step(run.get(c"next")?)? {
        let (id, refresher) = entry.iterator_pair()?;
        if call(state.get(c"cliCopies")?, c"has", &[id])?.truthy()? {
            // A CLI import shares its one-time refresh token with the CLI. Never rotate it here.
            push_result(run, id, text(run, "cli_copy")?)?;
            continue;
        }
        let pending = match call(refresher, c"check", &[run.get(c"reason")?]) {
            Ok(value) => call(run.global()?.get(c"Promise")?, c"resolve", &[value])?,
            Err(error) => {
                warn(
                    state,
                    "codex_account_refresh_check_failed",
                    id,
                    caught(run, error)?,
                )?;
                continue;
            }
        };
        run.set(c"accountId", id)?;
        let ok = function(run, "", 1, 1, |run, args| {
            let id = run.get(c"accountId")?;
            let append = || {
                let outcome = if args[0].truthy()? {
                    args[0].get(c"outcome")?
                } else {
                    args[0]
                };
                push_result(run, id, fallback(outcome, V::Null)?)
            };
            if let Err(error) = append() {
                let cause = caught(run, error)?;
                warn(
                    run.get(c"state")?,
                    "codex_account_refresh_check_failed",
                    id,
                    cause,
                )?;
            }
            check_next(run)
        })?;
        let fail = function(run, "", 1, 1, |run, args| {
            warn(
                run.get(c"state")?,
                "codex_account_refresh_check_failed",
                run.get(c"accountId")?,
                args[0],
            )?;
            check_next(run)
        })?;
        return call(pending, c"then", &[ok, fail]);
    }
    run.get(c"results")
}

fn supervisor<'a>(host: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let accounts = read(options, c"accounts")?;
    if !accounts.truthy()? {
        return Err(host.type_error("[codex-accounts-refresh] accounts store is required"));
    }
    let logger = options.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        host.get(c"quietLogger")?
    };
    let refreshers = host.global()?.get(c"Map")?.construct(&[])?;
    let s = fields(
        host,
        &[
            ("accounts", accounts),
            ("logger", logger),
            ("host", host),
            ("makeRefresher", options.get(c"makeRefresher")?),
            ("refreshers", refreshers),
            ("cliCopies", host.global()?.get(c"Set")?.construct(&[])?),
        ],
    )?;
    fields(
        s,
        &[
            (
                "sync",
                function(s, "sync", 0, 0, |s, _| {
                    sync(s)?;
                    undefined(s)
                })?,
            ),
            (
                "checkAll",
                function(s, "checkAll", 0, 1, |s, args| {
                    async_result(s, || {
                        let reason = if args[0].undefined()? {
                            text(s, "periodic")?
                        } else {
                            args[0]
                        };
                        sync(s)?;
                        let (iterator, next) = s.get(c"refreshers")?.iterator()?;
                        let run = fields(
                            s,
                            &[
                                ("state", s),
                                ("reason", reason),
                                ("iterator", iterator),
                                ("next", next),
                                ("results", s.from_value(&V::Array(vec![]))?),
                            ],
                        )?;
                        check_next(run)
                    })
                })?,
            ),
            (
                "status",
                function(s, "status", 1, 1, |s, args| {
                    let refresher = call(s.get(c"refreshers")?, c"get", &[args[0]])?;
                    if refresher.truthy()? {
                        call(refresher, c"status", &[])
                    } else {
                        null(s)
                    }
                })?,
            ),
            ("refreshers", refreshers),
        ],
    )?
    .freeze()
}

#[napi]
pub fn codex_account_refresh_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, ports);
    Ok(fields(
        host,
        &[(
            "createCodexAccountRefreshSupervisor",
            function(
                host,
                "createCodexAccountRefreshSupervisor",
                0,
                1,
                |host, a| supervisor(host, a[0]),
            )?,
        )],
    )?
    .raw())
}
