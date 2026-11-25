//! Describe post-turn deliveries. The host persists receipts and performs the I/O.
use crate::{js_iteration::read, js_live::LiveValue};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn frozen<'a>(anchor: LiveValue<'a>, fields: &[(&CStr, LiveValue<'a>)]) -> Result<LiveValue<'a>> {
    let object = anchor.from_value(&JsValue::Object(vec![]))?;
    for (key, value) in fields {
        object.set(key, *value)?;
    }
    object.freeze()
}

fn receipt_set(receipts: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let global = receipts.global()?;
    let set = global.get(c"Set")?;
    let ids = if receipts.is_array()? {
        let map = receipts.get(c"map")?;
        if map.kind()? != sys::ValueType::napi_function {
            return Err(receipts.type_error("receipts.map is not a function"));
        }
        map.call(receipts, &[global.get(c"String")?])?
    } else {
        receipts.from_value(&JsValue::Array(vec![]))?
    };
    set.construct(&[ids])
}

/// IDs are UTF-16 strings in the host, including lone surrogate code units.
fn pending_id<'a>(
    receipts: LiveValue<'a>,
    prefix: &str,
    id: LiveValue<'a>,
) -> Result<Option<LiveValue<'a>>> {
    if !id.truthy()? {
        return Ok(None);
    }
    let mut units = multicc_core::js::JsString::from_rust_str(prefix);
    units.push(&id.coerce_string()?);
    let key = id.from_value(&JsValue::String(units))?;
    let delivered = receipts.get(c"has")?.call(receipts, &[key])?.truthy()?;
    Ok((!delivered).then_some(key))
}

fn add_effect<'a>(
    effects: LiveValue<'a>,
    kind: &str,
    id: LiveValue<'a>,
    fields: &[(&CStr, LiveValue<'a>)],
) -> Result<()> {
    let effect = effects.from_value(&JsValue::Object(vec![]))?;
    effect.set(c"type", effects.from_value(&kind.into())?)?;
    effect.set(c"effectId", id)?;
    effect.set(c"requiresDeliveryProof", effects.from_value(&true.into())?)?;
    for (key, value) in fields {
        effect.set(key, *value)?;
    }
    effects.get(c"push")?.call(effects, &[effect.freeze()?])?;
    Ok(())
}

#[napi]
pub fn chat_route_post_turn(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = LiveValue::new(&env, input);
    let turn = read(input, c"turnId")?.clean_text()?;
    let session = input.get(c"sessionId")?.clean_text()?;
    let final_text = input.get(c"finalText")?;
    let final_text = if final_text.truthy()? {
        input.global()?.get(c"String")?.call_plain(&[final_text])?
    } else {
        input.from_value(&"".into())?
    };
    let receipts = receipt_set(input.get(c"receipts")?)?;
    // Preserve repeated getter reads in the compatibility API.
    let handoff = if input.get(c"handoff")?.truthy()?
        && matches!(
            input.get(c"handoff")?.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_null
        ) {
        Some(input.get(c"handoff")?)
    } else {
        None
    };
    let effects = input.from_value(&JsValue::Array(vec![]))?;
    if input.get(c"handoffResumeFailure")?.is_true()? {
        return Ok(frozen(
            input,
            &[
                (c"route", input.from_value(&"handoff-failed".into())?),
                (c"effects", effects.freeze()?),
                (c"reason", input.from_value(&"fail-closed".into())?),
            ],
        )?
        .raw());
    }

    if let Some(handoff) = handoff {
        if handoff.truthy()?
            && handoff.get(c"status")?.is_string("pending")?
            && handoff.get(c"completed")?.is_true()?
        {
            let id = handoff.get(c"id")?.clean_text()?;
            if let Some(key) = pending_id(receipts, "handoff:", id)? {
                add_effect(
                    effects,
                    "ack-handoff",
                    key,
                    &[
                        (c"handoffId", id),
                        (c"sessionId", session),
                        (c"requiresResultProof", input.from_value(&true.into())?),
                    ],
                )?;
            }
        }
    }

    let dispatch = input.get(c"originDispatchId")?.clean_text()?;
    let route = if dispatch.truthy()? {
        if let Some(key) = pending_id(receipts, "dispatch-return:", dispatch)? {
            add_effect(
                effects,
                "complete-dispatch",
                key,
                &[
                    (c"operationId", dispatch),
                    (c"sessionId", session),
                    (c"finalText", final_text),
                ],
            )?;
        }
        "dispatch-return"
    } else if input.get(c"sessionType")?.is_string("gateway")? {
        if let Some(key) = pending_id(receipts, "gateway-turn:", turn)? {
            add_effect(
                effects,
                "gateway-turn-complete",
                key,
                &[
                    (c"sessionId", session),
                    (c"turnId", turn),
                    (c"finalText", final_text),
                    (c"requestId", input.get(c"requestId")?.clean_text()?),
                ],
            )?;
        }
        "gateway"
    } else if input.get(c"sessionType")?.is_string("aux")? {
        "aux"
    } else if input.get(c"sessionType")?.is_string("commander")? {
        "commander"
    } else {
        "normal"
    };
    Ok(frozen(
        input,
        &[
            (c"route", input.from_value(&route.into())?),
            (c"effects", effects.freeze()?),
        ],
    )?
    .raw())
}

#[napi]
pub fn chat_create_delivery_proof(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = LiveValue::new(&env, input);
    Ok(frozen(
        input,
        &[
            (c"kind", input.from_value(&"delivery-proof".into())?),
            (c"effectId", read(input, c"effectId")?.clean_text()?),
            (c"deliveryId", input.get(c"deliveryId")?.clean_text()?),
            (
                c"durable",
                input.from_value(&input.get(c"durable")?.is_true()?.into())?,
            ),
            (
                c"delivered",
                input.from_value(&input.get(c"delivered")?.is_true()?.into())?,
            ),
        ],
    )?
    .raw())
}

#[napi]
pub fn chat_acknowledge_delivered_effect(
    env: Env,
    effect: Unknown<'_>,
    proof: Unknown<'_>,
) -> Result<sys::napi_value> {
    let effect = LiveValue::new(&env, effect);
    let proof = LiveValue::new(&env, proof);
    let code = if !effect.truthy()? || !effect.get(c"requiresDeliveryProof")?.is_true()? {
        "effect_not_delivery_bound"
    } else if !proof.truthy()?
        || !proof.get(c"kind")?.is_string("delivery-proof")?
        || !proof.get(c"effectId")?.equals(effect.get(c"effectId")?)?
        || !proof.get(c"deliveryId")?.truthy()?
        || !proof.get(c"durable")?.is_true()?
        || !proof.get(c"delivered")?.is_true()?
    {
        "delivery_proof_required"
    } else {
        let receipt = frozen(
            effect,
            &[
                (c"type", effect.from_value(&"ack-delivery".into())?),
                (c"effectId", effect.get(c"effectId")?),
                (c"deliveryId", proof.get(c"deliveryId")?),
            ],
        )?;
        return Ok(frozen(
            effect,
            &[
                (c"ok", effect.from_value(&true.into())?),
                (c"receipt", receipt),
            ],
        )?
        .raw());
    };
    Ok(frozen(
        effect,
        &[
            (c"ok", effect.from_value(&false.into())?),
            (c"code", effect.from_value(&code.into())?),
        ],
    )?
    .raw())
}
