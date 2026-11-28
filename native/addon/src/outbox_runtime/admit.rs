//! Common admission transaction for direct writes, waits, and dispatch requests.
use super::*;
use crate::operation_admit_live::{hash, normal};

#[allow(clippy::too_many_arguments)]
pub(crate) fn insert<'a>(
    draft: L<'a>,
    id: L<'a>,
    session: L<'a>,
    payload: L<'a>,
    source: L<'a>,
    at: L<'a>,
    available: L<'a>,
    (crypto, conflict): (L<'a>, L<'a>),
) -> Result<(L<'a>, bool)> {
    if !draft.truthy()?
        || !object(draft)?
        || !draft.get(c"outbox")?.truthy()?
        || !object(draft.get(c"outbox")?)?
    {
        return Err(draft.type_error("outbox mutation requires an orchestration/store draft"));
    }
    if !safe_integer(draft.get(c"nextOutboxSequence")?)?
        || draft.get(c"nextOutboxSequence")?.explicit_number()? < 1.0
    {
        return Err(draft.type_error("outbox draft has an invalid sequence"));
    }
    for (value, error) in [
        (id, "outbox item requires id"),
        (session, "outbox item requires sessionId"),
    ] {
        if !value.truthy()? || value.kind()? != sys::ValueType::napi_string {
            return Err(value.type_error(error));
        }
    }
    if !finite(at)? || !finite(available)? {
        return Err(at.type_error("outbox timestamps must be finite numbers"));
    }
    let payload = normal(payload)?;
    let digest = hash(payload, crypto, false)?;
    let source = if source.kind()? == sys::ValueType::napi_null {
        source
    } else {
        normal(source)?
    };
    let existing = draft.get(c"outbox")?.get_key(id)?;
    if existing.truthy()? {
        if existing.get(c"sessionId")?.equals(session)?
            && existing.get(c"payloadHash")?.equals(digest)?
        {
            return Ok((existing, true));
        }
        return Err(conflict.construct(&[id])?.throw_error());
    }
    let sequence = increment_sequence(draft)?;
    let nil = null(draft)?;
    let item = fields(
        draft,
        &[
            ("id", id),
            ("sessionId", session),
            ("sequence", sequence),
            ("state", text(draft, "pending")?),
            ("payload", payload),
            ("payloadHash", digest),
            ("source", source),
            ("attempts", num(draft, 0.)?),
            ("availableAt", available),
            ("createdAt", at),
            ("updatedAt", at),
            ("leasedAt", nil),
            ("leasedUntil", nil),
            ("leaseOwner", nil),
            ("leaseTokenHash", nil),
            ("deliveredAt", nil),
            ("deadLetterAt", nil),
            ("lastError", nil),
        ],
    )?;
    draft.get(c"outbox")?.set_key(id, item)?;
    Ok((item, false))
}

// A proxy may change the counter between validation and the postfix increment.
fn increment_sequence(draft: L<'_>) -> Result<L<'_>> {
    let value = draft.get(c"nextOutboxSequence")?;
    let value = match value.kind()? {
        sys::ValueType::napi_object | sys::ValueType::napi_function => {
            value.number_hint_primitive()?
        }
        _ => value,
    };
    let (previous, next) = if value.kind()? == sys::ValueType::napi_bigint {
        let big = unsafe {
            <napi::bindgen_prelude::BigInt as napi::bindgen_prelude::FromNapiValue>::from_napi_value(value.env(), value.raw())?
        };
        let mut words = big.words;
        if big.sign_bit {
            for word in &mut words {
                let (new, borrow) = word.overflowing_sub(1);
                *word = new;
                if !borrow {
                    break;
                }
            }
            while words.last() == Some(&0) {
                words.pop();
            }
        } else {
            let mut carry = true;
            for word in &mut words {
                let (new, overflow) = word.overflowing_add(1);
                *word = new;
                carry = overflow;
                if !carry {
                    break;
                }
            }
            if carry {
                words.push(1);
            }
        }
        let next = napi::bindgen_prelude::BigInt {
            sign_bit: big.sign_bit && !words.is_empty(),
            words,
        };
        let raw = unsafe {
            <napi::bindgen_prelude::BigInt as napi::bindgen_prelude::ToNapiValue>::to_napi_value(
                value.env(),
                next,
            )?
        };
        (value, L::from_raw(value.env(), raw))
    } else {
        let n = value.number()?;
        (num(value, n)?, num(value, n + 1.)?)
    };
    draft.assign(c"nextOutboxSequence", next)?;
    Ok(previous)
}

pub(super) fn direct<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[1])?;
    let id = read(opts, c"id")?;
    let session = read(opts, c"sessionId")?;
    let payload = read(opts, c"payload")?;
    let source = with_default(read(opts, c"source")?, null(p)?)?;
    let at = read(opts, c"now")?;
    let available = with_default(read(opts, c"availableAt")?, at)?;
    let (item, was_present) = insert(
        a[0],
        id,
        session,
        payload,
        source,
        at,
        available,
        (p.get(c"crypto")?, p.get(c"conflict")?),
    )?;
    fields(p, &[("item", item), ("idempotent", flag(p, was_present)?)])
}
