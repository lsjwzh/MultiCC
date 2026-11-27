//! Read-only Claude CLI usage. The caller injects the outbound transport and the credential store.
use crate::quota_host::*;
use napi_derive::napi;
const SKEW: f64 = 60_000.;
const SERVICE: &str = "Claude Code-credentials";
fn parse<'a>(p: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    call(
        p.get(c"credentials")?,
        c"credential",
        &[fields(
            p,
            &[
                ("operation", text(p, "parseCli")?),
                ("raw", string(fallback(raw, "".into())?)?),
            ],
        )?],
    )
}
fn stored<'a>(parsed: L<'a>, name: &str) -> Result<L<'a>> {
    let out = spread(parsed)?;
    out.set(c"store", text(out, name)?)?;
    Ok(out)
}
fn file(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"ports")?;
    let options = ctx.get(c"options")?;
    let result = async_result(p, || {
        let read = with_default(options.get(c"readFile")?, p.get(c"readFile")?)?;
        let output = read.call_plain(&[with_default(
            options.get(c"credentialsFile")?,
            p.get(c"file")?,
        )?])?;
        then(output, p, |p, a| stored(parse(p, a[0])?, "file"))
    })?;
    recover(result, ctx, |ctx, _| {
        fields(
            ctx,
            &[
                ("ok", flag(ctx, false)?),
                ("reason", text(ctx, "unreadable")?),
                (
                    "store",
                    text(
                        ctx,
                        if ctx.get(c"platform")?.is_string("darwin")? {
                            "keychain"
                        } else {
                            "file"
                        },
                    )?,
                ),
            ],
        )
    })
}
fn read<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let options = default_object(o)?;
        let keychain = options.get(c"readKeychain")?;
        let platform = options.get(c"platform")?;
        if !keychain.truthy()? && !options.get(c"readFile")?.truthy()? {
            let file = options.get(c"credentialsFile")?;
            return call(
                p.get(c"credentials")?,
                c"readCli",
                &[fields(
                    p,
                    &[
                        (
                            "platform",
                            if platform.truthy()? {
                                platform
                            } else {
                                p.get(c"platform")?
                            },
                        ),
                        (
                            "file",
                            if file.truthy()? {
                                file
                            } else {
                                p.get(c"file")?
                            },
                        ),
                        (
                            "service",
                            fallback(options.get(c"keychainService")?, SERVICE.into())?,
                        ),
                    ],
                )?],
            );
        }
        let platform = with_default(platform, p.get(c"platform")?)?;
        let ctx = fields(
            p,
            &[("ports", p), ("options", options), ("platform", platform)],
        )?;
        if platform.is_string("darwin")? && !keychain.undefined()? {
            return then(keychain.call_plain(&[])?, ctx, |ctx, a| {
                if a[0].truthy()? {
                    let parsed = parse(ctx.get(c"ports")?, a[0])?;
                    if parsed.get(c"ok")?.truthy()? {
                        return stored(parsed, "keychain");
                    }
                }
                file(ctx)
            });
        }
        file(ctx)
    })
}
fn fetch<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let options = default_object(a[0])?;
        let reader = options.get(c"readCredentials")?;
        let ctx = fields(p, &[("ports", p), ("options", options)])?;
        let credentials = async_result(p, || {
            if reader.undefined()? {
                read(p, undef(p)?)
            } else {
                reader.call_plain(&[])
            }
        })?;
        let credentials = recover(credentials, p, |p, _| null(p))?;
        then(credentials, ctx, |ctx, a| {
            let p = ctx.get(c"ports")?;
            let options = ctx.get(c"options")?;
            let cred = a[0];
            if !cred.optional(c"ok")?.truthy()? || !cred.get(c"accessToken")?.truthy()? {
                return null(p);
            }
            let expiry = cred.get(c"expiresAt")?;
            if !expiry.nullish()?
                && expiry.number()?
                    <= with_default(options.get(c"now")?, p.get(c"now")?)?
                        .call_plain(&[])?
                        .number()?
                        + SKEW
            {
                return null(p);
            }
            let response = async_result(p, || {
                call(
                    p,
                    c"fetchUsage",
                    &[
                        with_default(options.get(c"fetchImpl")?, p.get(c"outboundFetch")?)?,
                        cred.get(c"accessToken")?,
                    ],
                )
            })?;
            let response = recover(response, p, |p, _| null(p))?;
            then(response, cred, |cred, a| {
                if !object(a[0])? {
                    return null(cred);
                }
                fields(
                    cred,
                    &[
                        ("usage", a[0]),
                        (
                            "account",
                            fields(
                                cred,
                                &[
                                    ("id", text(cred, "cli")?),
                                    ("label", text(cred, "Claude Code CLI")?),
                                    ("email", text(cred, "")?),
                                    (
                                        "subscriptionType",
                                        fallback(cred.get(c"subscriptionType")?, "".into())?,
                                    ),
                                    ("store", fallback(cred.get(c"store")?, "".into())?),
                                ],
                            )?,
                        ),
                    ],
                )
            })
        })
    })
}
#[napi]
pub fn cli_usage_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = methods(
        p,
        &[
            ("parseCredentials", 1, |p, a| parse(p, a[0])),
            ("fetchCliUsage", 1, fetch),
            ("readCliCredentials", 1, |p, a| read(p, a[0])),
        ],
    )?;
    api.set(c"KEYCHAIN_SERVICE", text(p, SERVICE)?)?;
    api.set(c"CREDENTIALS_FILE", p.get(c"file")?)?;
    api.set(c"EXPIRY_SKEW_MS", num(p, SKEW)?)?;
    Ok(api.raw())
}
