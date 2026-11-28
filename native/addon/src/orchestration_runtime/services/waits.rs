use super::*;

pub(in crate::orchestration_runtime) fn register<'a>(
    p: L<'a>,
    options: L<'a>,
    wakeup: L<'a>,
) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(options)?;
        let id = default_id(p, read(o, c"id")?)?;
        let session = read(o, c"sessionId")?;
        let mode = with_default(read(o, c"mode")?, text(p, "callback")?)?;
        let prefix = with_default(read(o, c"injectPrefix")?, text(p, "")?)?;
        let meta = with_default(read(o, c"metadata")?, null(p)?)?;
        for (v, message) in [
            (id, "[wait-service] wait id is required"),
            (session, "[wait-service] sessionId is required"),
        ] {
            if !v.truthy()? || v.kind()? != sys::ValueType::napi_string {
                return Err(p.type_error(message));
            }
        }
        let callback = mode.is_string("callback")?;
        if !callback && !mode.is_string("poll")? && !mode.is_string("delay")? {
            return Err(p.type_error("[wait-service] mode must be callback, poll or delay"));
        }
        let token = if callback {
            string(p.get(c"tokenFactory")?.call_plain(&[])?)?
        } else {
            null(p)?
        };
        if callback && !token.truthy()? {
            return Err(error_value(
                p,
                "[wait-service] callbackTokenFactory returned an empty token",
            )?
            .throw_error());
        }
        let digest = if callback {
            hash(token, p.get(c"cryptoImpl")?, true)?
        } else {
            null(p)?
        };
        let meta = if meta.equals(null(p)?)? {
            meta
        } else {
            normal(meta)?
        };
        let f = fields(p, &[("p", p), ("id", id), ("token", token)])?;
        let written = transaction(
            p,
            &[
                ("id", id),
                ("session", session),
                ("mode", mode),
                ("prefix", prefix),
                ("meta", meta),
                ("digest", digest),
                ("wakeup", wakeup),
            ],
            c"mutate",
            |f, a| {
                let waits = a[0].get(c"waits")?;
                let id = f.get(c"id")?;
                if waits.get_key(id)?.truthy()? {
                    let msg = join(f, &[text(f, "wait ")?, id, text(f, " already exists")?])?;
                    let e = f.global()?.get(c"Error")?.construct(&[msg])?;
                    e.set(c"code", text(f, "WAIT_ALREADY_EXISTS")?)?;
                    e.set(c"statusCode", num(f, 409.)?)?;
                    return Err(e.throw_error());
                }
                let time = at(f.get(c"state")?)?;
                let wait = fields(
                    f,
                    &[
                        ("id", id),
                        ("sessionId", f.get(c"session")?),
                        ("mode", f.get(c"mode")?),
                        ("status", text(f, "pending")?),
                        (
                            "injectPrefix",
                            string(fallback(f.get(c"prefix")?, "".into())?)?,
                        ),
                        ("metadata", f.get(c"meta")?),
                        ("callbackTokenHash", f.get(c"digest")?),
                        ("createdAt", time),
                        ("updatedAt", time),
                        ("resolvedAt", null(f)?),
                        ("cancelledAt", null(f)?),
                        ("resolutionPayloadHash", null(f)?),
                        ("outboxId", null(f)?),
                    ],
                )?;
                write_entry(waits, id, wait)?;
                let wakeup = f.get(c"wakeup")?;
                if wakeup.undefined()? {
                    return public(wait, WAIT_PRIVATE, true);
                }
                let row = waits.get_key(id)?;
                let changes = super::super::wakeups::on_admission(wakeup, a[0], row, false)?;
                let result = public(row, WAIT_PRIVATE, true)?;
                result.set(c"wakeupChanges", changes)?;
                Ok(result)
            },
        )?;
        then(written, f, |f, a| {
            let result = spread(a[0])?;
            let token = f.get(c"token")?;
            if token.truthy()? {
                let p = f.get(c"p")?;
                let id = f.get(c"id")?;
                let factory = p.get(c"urlFactory")?;
                let base = p.get(c"base")?;
                let url = if callable(factory)? {
                    factory.call_plain(&[fields(f, &[("id", id), ("token", token)])?])?
                } else if base.truthy()? {
                    let pattern = p.global()?.get(c"RegExp")?.construct(&[text(p, "/+$")?])?;
                    let base = call(string(base)?, c"replace", &[pattern, text(p, "")?])?;
                    let encode = p.global()?.get(c"encodeURIComponent")?;
                    join(
                        p,
                        &[
                            base,
                            text(p, "/api/orchestration/waits/")?,
                            encode.call_plain(&[id])?,
                            text(p, "/callback?token=")?,
                            encode.call_plain(&[token])?,
                        ],
                    )?
                } else {
                    null(p)?
                };
                result.set(c"token", token)?;
                result.set(c"callbackUrl", url)?;
            }
            Ok(result)
        })
    })
}

fn resolve<'a>(p: L<'a>, a: &mut [L<'a>], mode: &str) -> Result<L<'a>> {
    async_result(p, || {
        let id = a[0];
        let callback = mode == "callback";
        let (payload, token, delivery, work) = if callback {
            (a[2], a[1], undef(p)?, null(p)?)
        } else {
            let o = default_object(a[2])?;
            (
                a[1],
                undef(p)?,
                read(o, c"deliveryText")?,
                if mode == "delay" {
                    with_default(read(o, c"sessionWork")?, null(p)?)?
                } else {
                    null(p)?
                },
            )
        };
        if !id.truthy()? || id.kind()? != sys::ValueType::napi_string {
            return Err(p.type_error("[wait-service] resolve requires wait id"));
        }
        let input = fields(
            p,
            &[
                ("callbackToken", token),
                ("expectedMode", text(p, mode)?),
                ("deliveryText", delivery),
                ("sessionWork", work),
            ],
        )?;
        let clock = p.get(c"now")?;
        let crypto = p.get(c"cryptoImpl")?;
        let default = p.get(c"crypto")?;
        let conflict = p.get(c"outboxConflict")?;
        let store = p.get(c"store")?;
        if callable(store.get(c"runNativeCommandSync")?)? {
            let result = call(
                store,
                c"runNativeCommandSync",
                &[
                    text(p, "waitResolve")?,
                    id,
                    payload,
                    input,
                    clock,
                    crypto,
                    default,
                    conflict,
                ],
            )?;
            return then(result, p, |_, a| a[0].get(c"value"));
        }
        transaction(
            p,
            &[("id", id), ("payload", payload), ("input", input)],
            c"mutate",
            |f, a| {
                let s = f.get(c"state")?;
                let draft = a[0];
                let id = f.get(c"id")?;
                let payload = f.get(c"payload")?;
                let input = f.get(c"input")?;
                let clock = s.get(c"now")?;
                let crypto = s.get(c"cryptoImpl")?;
                let default = s.get(c"crypto")?;
                let conflict = s.get(c"outboxConflict")?;
                let injected = s.get(c"overrideAddon")?.call_plain(&[])?;
                if !injected.undefined()? {
                    return call(
                        injected,
                        c"waitResolveLive",
                        &[draft, id, payload, input, clock, crypto, default, conflict],
                    );
                }
                Ok(raw(
                    draft,
                    crate::wait_resolve_live::wait_resolve_live(
                        env(draft),
                        arg(draft)?,
                        arg(id)?,
                        arg(payload)?,
                        arg(input)?,
                        arg(clock)?,
                        arg(crypto)?,
                        arg(default)?,
                        arg(conflict)?,
                    )?,
                ))
            },
        )
    })
}
fn cancel<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let id = a[0];
        let f = fields(p, &[("p", p), ("id", id)])?;
        let mutate = function(f, "mutate", 1, 1, |f, a| {
            let p = f.get(c"p")?;
            let id = f.get(c"id")?;
            let clock = p.get(c"now")?;
            let injected = p.get(c"overrideAddon")?.call_plain(&[])?;
            if !injected.undefined()? {
                return call(injected, c"waitCancelLive", &[a[0], id, clock]);
            }
            Ok(raw(
                p,
                crate::wait_cancel_live::wait_cancel_live(
                    env(p),
                    arg(a[0])?,
                    arg(id)?,
                    arg(clock)?,
                )?,
            ))
        })?;
        let store = p.get(c"store")?;
        if callable(store.get(c"cancelWait")?)? {
            call(store, c"cancelWait", &[id, p.get(c"now")?, mutate])
        } else {
            call(store, c"mutate", &[mutate])
        }
    })
}
fn cancel_for<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        transaction(p, &[("session", a[0])], c"mutate", |f, a| {
            let session = f.get(c"session")?;
            let time = at(f.get(c"state")?)?;
            let filter = fields(
                f,
                &[("sessionId", session), ("status", text(f, "pending")?)],
            )?;
            let mut count = 0;
            candidates(a[0], c"waits", filter)?.for_each(|w| {
                if w.get(c"sessionId")?.equals(session)?
                    && w.get(c"status")?.is_string("pending")?
                {
                    w.assign(c"status", text(f, "cancelled")?)?;
                    w.assign(c"cancelledAt", time)?;
                    w.assign(c"updatedAt", time)?;
                    count += 1;
                }
                Ok(())
            })?;
            fields(
                f,
                &[("ok", flag(f, true)?), ("cancelled", num(f, count as f64)?)],
            )
        })
    })
}
pub(in crate::orchestration_runtime) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    api(state(ports, a[0], true)?)
}

pub(in crate::orchestration_runtime) fn api(p: L<'_>) -> Result<L<'_>> {
    defaulted_methods(
        p,
        &[
            ("register", 0, 1, |p, a| register(p, a[0], undef(p)?)),
            ("resolveCallback", 3, 3, |p, a| resolve(p, a, "callback")),
            ("resolvePoll", 2, 3, |p, a| resolve(p, a, "poll")),
            ("resolveDelay", 2, 3, |p, a| resolve(p, a, "delay")),
            ("cancel", 1, 1, cancel),
            ("cancelForSession", 1, 1, cancel_for),
            ("get", 1, 1, |p, a| queries::get(p, a[0], true)),
            ("list", 0, 1, |p, a| {
                queries::list(p, a[0], queries::Subject::Wait)
            }),
        ],
    )?
    .freeze()
}
