//! Rust-owned outbox claim state machine over a transaction-local host view.
//! The host supplies only clock, selection/grouping, token and crypto ports.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cmp::Ordering, ffi::CString, ptr};

unsafe extern "C" fn compare_sequence(
    env: sys::napi_env,
    info: sys::napi_callback_info,
) -> sys::napi_value {
    let mut argc = 2usize;
    let mut args = [ptr::null_mut(); 2];
    if unsafe {
        sys::napi_get_cb_info(
            env,
            info,
            &mut argc,
            args.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    } != sys::Status::napi_ok
    {
        return ptr::null_mut();
    }
    let result = std::panic::catch_unwind(|| -> Result<f64> {
        let a = L::from_raw(env, args[0]);
        let b = L::from_raw(env, args[1]);
        Ok(a.get(c"sequence")?.number()? - b.get(c"sequence")?.number()?)
    });
    match result {
        Ok(Ok(number)) => {
            let mut out = ptr::null_mut();
            if unsafe { sys::napi_create_double(env, number, &mut out) } == sys::Status::napi_ok {
                out
            } else {
                ptr::null_mut()
            }
        }
        other => {
            let mut pending = false;
            unsafe {
                sys::napi_is_exception_pending(env, &mut pending);
            }
            if !pending {
                let message = match other {
                    Ok(Err(error)) => error.to_string(),
                    _ => "outbox sequence comparator panicked".into(),
                };
                let message = CString::new(message.replace('\0', "\\0")).expect("NUL removed");
                unsafe {
                    sys::napi_throw_error(env, ptr::null(), message.as_ptr());
                }
            }
            ptr::null_mut()
        }
    }
}
fn sorted<'a>(root: L<'a>, items: L<'a>) -> Result<L<'a>> {
    let mut callback = ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_function(
            root.env(),
            ptr::null(),
            0,
            Some(compare_sequence),
            ptr::null_mut(),
            &mut callback,
        )
    })?;
    items
        .get(c"sort")?
        .call(items, &[L::from_raw(root.env(), callback)])
}
fn terminal(value: L<'_>) -> Result<bool> {
    Ok(value.is_string("delivered")?
        || value.is_string("dead-letter")?
        || value.is_string("cancelled")?)
}
fn rows<'a>(draft: L<'a>, leased: bool) -> Result<L<'a>> {
    let preselected = draft.optional(c"claimSelect")?;
    if preselected.kind()? == sys::ValueType::napi_function {
        let result = preselected.call(draft, &[draft.from_value(&V::Bool(leased))?])?;
        if !result.nullish()? {
            return Ok(result);
        }
    }
    let select = draft.get(c"select")?;
    if select.kind()? == sys::ValueType::napi_function {
        let filter = if leased {
            V::string("leased")
        } else {
            V::object(vec![(
                "$nin",
                V::Array(vec![
                    V::string("delivered"),
                    V::string("dead-letter"),
                    V::string("cancelled"),
                ]),
            )])
        };
        let options = V::object(vec![("where", V::object(vec![("state", filter)]))]);
        select.call(
            draft,
            &[
                draft.from_value(&V::string("outbox"))?,
                draft.from_value(&options)?,
            ],
        )
    } else {
        let object = draft.global()?.get(c"Object")?;
        object
            .get(c"values")?
            .call(object, &[draft.get(c"outbox")?])
    }
}
fn now<'a>(policy: L<'a>) -> Result<L<'a>> {
    let at = policy.get(c"now")?.call_plain(&[])?.explicit_number()?;
    policy.from_value(&V::Number(at))
}
fn has_expired(draft: L<'_>, at: L<'_>) -> Result<bool> {
    let leased = rows(draft, true)?;
    let len = leased.get(c"length")?.number()? as u32;
    for index in 0..len {
        let item = leased.element(index)?;
        if item.get(c"state")?.is_string("leased")?
            && item
                .get(c"leasedUntil")?
                .number()?
                .partial_cmp(&at.number()?)
                != Some(Ordering::Greater)
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn recover<'a>(draft: L<'a>, policy: L<'a>, at: L<'a>) -> Result<()> {
    let leased = sorted(draft, rows(draft, true)?)?;
    leased.for_each(|item| {
        if !item.get(c"state")?.is_string("leased")?
            || item.get(c"leasedUntil")?.number()? > at.number()?
        {
            return Ok(());
        }
        item.assign(
            c"lastError",
            draft.from_value(&V::string("delivery lease expired"))?,
        )?;
        item.assign(c"updatedAt", at)?;
        let null = draft.from_value(&V::Null)?;
        for key in [
            c"leasedAt",
            c"leasedUntil",
            c"leaseOwner",
            c"leaseTokenHash",
        ] {
            item.assign(key, null)?;
        }
        if item.get(c"attempts")?.number()? >= policy.get(c"maxAttempts")?.number()? {
            item.assign(c"state", draft.from_value(&V::string("dead-letter"))?)?;
            item.assign(c"deadLetterAt", at)?;
        } else {
            item.assign(c"state", draft.from_value(&V::string("pending"))?)?;
            let delay = policy
                .get(c"retryDelay")?
                .call_plain(&[item.get(c"attempts")?])?
                .explicit_number()?;
            item.assign(
                c"availableAt",
                draft.from_value(&V::Number(at.number()? + delay))?,
            )?;
        }
        Ok(())
    })
}
fn candidates<'a>(draft: L<'a>, policy: L<'a>, at: L<'a>) -> Result<Vec<L<'a>>> {
    let ordered = sorted(draft, rows(draft, false)?)?;
    let groups = draft.global()?.get(c"Map")?.construct(&[])?;
    ordered.for_each(|item| {
        if terminal(item.get(c"state")?)? {
            return Ok(());
        }
        let session = item.get(c"sessionId")?;
        if !groups.get(c"has")?.call(groups, &[session])?.truthy()? {
            groups
                .get(c"set")?
                .call(groups, &[session, draft.from_value(&V::Array(Vec::new()))?])?;
        }
        let list = groups.get(c"get")?.call(groups, &[session])?;
        list.get(c"push")?.call(list, &[item])?;
        Ok(())
    })?;
    let selector = policy.get(c"selectSessionItem")?;
    let values = groups.get(c"values")?.call(groups, &[])?;
    let mut selected = Vec::new();
    values.for_each(|items| {
        let item = if selector.kind()? == sys::ValueType::napi_function {
            selector.call_plain(&[items, draft, at])?
        } else {
            items.element(0)?
        };
        if item.truthy()? {
            selected.push(item);
        }
        Ok(())
    })?;
    let array = draft.from_value(&V::Array(Vec::new()))?;
    let mut count = 0;
    for item in selected {
        if item.get(c"state")?.is_string("pending")?
            && item.get(c"availableAt")?.number()? <= at.number()?
        {
            array.set_element(count, item)?;
            count += 1;
        }
    }
    let array = sorted(draft, array)?;
    let seen = draft.global()?.get(c"Set")?.construct(&[])?;
    let group = policy.get(c"sessionGroup")?;
    let mut result = Vec::new();
    array.for_each(|item| {
        let key = group.call_plain(&[item.get(c"sessionId")?])?;
        if !seen.get(c"has")?.call(seen, &[key])?.truthy()? {
            seen.get(c"add")?.call(seen, &[key])?;
            result.push(item);
        }
        Ok(())
    })?;
    let limit = policy.get(c"limit")?.number()? as usize;
    result.truncate(limit);
    Ok(result)
}
fn hash<'a>(root: L<'a>, policy: L<'a>, token: L<'a>) -> Result<L<'a>> {
    let crypto = policy.get(c"cryptoImpl")?;
    let h = crypto
        .get(c"createHash")?
        .call(crypto, &[root.from_value(&V::string("sha256"))?])?;
    let h = h
        .get(c"update")?
        .call(h, &[token, root.from_value(&V::string("utf8"))?])?;
    h.get(c"digest")?
        .call(h, &[root.from_value(&V::string("hex"))?])
}
#[napi]
pub fn outbox_claim_live(
    env: Env,
    snapshot: Unknown<'_>,
    draft: Unknown<'_>,
    policy: Unknown<'_>,
) -> Result<sys::napi_value> {
    let snapshot = L::new(&env, snapshot);
    let draft = L::new(&env, draft);
    let policy = L::new(&env, policy);
    let first = now(policy)?;
    if !has_expired(snapshot, first)? && candidates(snapshot, policy, first)?.is_empty() {
        return Ok(draft.from_value(&V::Array(Vec::new()))?.raw());
    }
    let at = now(policy)?;
    recover(draft, policy, at)?;
    let candidates = candidates(draft, policy, at)?;
    let output = draft.from_value(&V::Array(Vec::new()))?;
    for (index, item) in candidates.iter().enumerate() {
        let token = policy.get(c"leaseTokenFactory")?.call_plain(&[])?;
        let token = draft.global()?.get(c"String")?.call_plain(&[token])?;
        if !token.truthy()? {
            return Err(napi::Error::from_reason(
                "[outbox] leaseTokenFactory returned an empty token",
            ));
        }
        item.assign(c"state", draft.from_value(&V::string("leased"))?)?;
        item.assign(
            c"attempts",
            crate::schedule_note_queued_live::plus_one(item.get(c"attempts")?)?,
        )?;
        item.assign(c"leasedAt", at)?;
        item.assign(
            c"leasedUntil",
            draft.from_value(&V::Number(
                at.number()? + policy.get(c"leaseForMs")?.explicit_number()?,
            ))?,
        )?;
        item.assign(c"leaseOwner", policy.get(c"workerId")?)?;
        item.assign(c"leaseTokenHash", hash(draft, policy, token)?)?;
        item.assign(c"updatedAt", at)?;
        let json = draft.global()?.get(c"JSON")?;
        let encoded = json.get(c"stringify")?.call(json, &[*item])?;
        let copy = json.get(c"parse")?.call(json, &[encoded])?;
        copy.delete(c"leaseTokenHash")?;
        let result = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        result.spread_from(copy)?;
        result.set(c"leaseToken", token)?;
        output.set_element(index as u32, result)?;
    }
    Ok(output.raw())
}
