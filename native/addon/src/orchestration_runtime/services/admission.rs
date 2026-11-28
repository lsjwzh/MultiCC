use super::*;

fn admitted<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let r = a[0];
    if r.get(c"legacy")?.truthy()? {
        return r.get(c"value");
    }
    let kind = r.get(c"errorKind")?;
    if kind.is_string("type")? {
        return Err(p
            .global()?
            .get(c"TypeError")?
            .construct(&[r.get(c"message")?])?
            .throw_error());
    }
    if kind.is_string("operation")? {
        return Err(p
            .get(c"OperationConflictError")?
            .construct(&[
                r.get(c"message")?,
                json_call(p, c"parse", r.get(c"idJson")?)?,
            ])?
            .throw_error());
    }
    if kind.is_string("outbox")? {
        return Err(p
            .get(c"outboxConflict")?
            .construct(&[json_call(p, c"parse", r.get(c"idJson")?)?])?
            .throw_error());
    }
    let value = r.get(c"resultJson")?;
    if value.truthy()? {
        json_call(p, c"parse", value)
    } else {
        Ok(r)
    }
}
fn mutate<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = f.get(c"state")?;
    let draft = a[0];
    let input = f.get(c"input")?;
    let kind = f.get(c"kind")?;
    let clock = p.get(c"now")?;
    let crypto = p.get(c"cryptoImpl")?;
    let default = p.get(c"crypto")?;
    let conflict = p.get(c"OperationConflictError")?;
    let outbox = p.get(c"outboxConflict")?;
    let injected = p.get(c"overrideAddon")?.call_plain(&[])?;
    if !injected.undefined()? {
        return call(
            injected,
            c"operationAdmitLive",
            &[draft, kind, input, clock, crypto, default, conflict, outbox],
        );
    }
    Ok(raw(
        p,
        crate::operation_admit_live::operation_admit_live(
            env(p),
            arg(draft)?,
            fold_string(kind)?,
            arg(input)?,
            arg(clock)?,
            arg(crypto)?,
            arg(default)?,
            arg(conflict)?,
            arg(outbox)?,
        )?,
    ))
}

pub(super) fn admit<'a>(p: L<'a>, options: L<'a>, detached: bool) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(options)?;
        let id = default_id(p, read(o, c"operationId")?)?;
        let owner = read(
            o,
            if detached {
                c"sessionId"
            } else {
                c"ownerSessionId"
            },
        )?;
        let dest = if detached {
            owner
        } else {
            read(o, c"resultSessionId")?
        };
        let key = with_default(read(o, c"idempotencyKey")?, null(p)?)?;
        let spec = read(o, c"spec")?;
        if detached && !owner.truthy()? {
            return Err(p.type_error("detached operation requires sessionId"));
        }
        if !detached
            && (!owner.truthy()?
                || !spec.truthy()?
                || !read(spec, c"chatId")?.truthy()?
                || !read(spec, c"targetId")?.truthy()?
                || !read(spec, c"message")?.truthy()?)
        {
            return Err(p.type_error("dispatch operation requires owner, target chat and message"));
        }
        let input = fields(p, &[("operationId", id)])?;
        if detached {
            input.set(c"sessionId", owner)?;
        } else {
            input.set(c"ownerSessionId", owner)?;
            input.set(c"resultSessionId", dest)?;
        }
        input.set(c"idempotencyKey", key)?;
        input.set(c"spec", spec)?;
        let kind = text(p, if detached { "detached" } else { "dispatch" })?;
        let f = fields(p, &[("state", p), ("input", input), ("kind", kind)])?;
        let action = function(f, "mutate", 1, 1, mutate)?;
        let store = p.get(c"store")?;
        if callable(store.get(c"executeOperationAdmit")?)? {
            let params = fields(
                p,
                &[
                    ("id", id),
                    ("kind", kind),
                    ("ownerSessionId", owner),
                    ("resultSessionId", if dest.truthy()? { dest } else { owner }),
                    ("idempotencyKey", key),
                    ("spec", spec),
                    ("now", p.get(c"now")?),
                    (
                        "customCrypto",
                        flag(p, !p.get(c"cryptoImpl")?.equals(p.get(c"crypto")?)?)?,
                    ),
                ],
            )?;
            then(
                call(store, c"executeOperationAdmit", &[params, action])?,
                p,
                admitted,
            )
        } else {
            call(store, c"mutate", &[action])
        }
    })
}
