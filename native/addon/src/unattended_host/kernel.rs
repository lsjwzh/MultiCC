use super::*;
use multicc_core::unattended as core;
#[napi]
pub fn unattended_kernel_api(env: Env) -> Result<sys::napi_value> {
    let api = L::from_raw(env.raw(), {
        let mut v = std::ptr::null_mut();
        napi::check_status!(unsafe { sys::napi_create_object(env.raw(), &mut v) })?;
        v
    });
    api.set(
        c"LIMITS",
        fields(
            api,
            &[
                (
                    "maxDurationMinutesDefault",
                    num(api, core::MAX_DURATION_DEFAULT as f64)?,
                ),
                (
                    "maxDurationMinutesMin",
                    num(api, core::MAX_DURATION_MIN as f64)?,
                ),
                (
                    "maxDurationMinutesMax",
                    num(api, core::MAX_DURATION_LIMIT as f64)?,
                ),
            ],
        )?
        .freeze()?,
    )?;
    for name in [
        "armDeadline",
        "bootRecover",
        "buildVerdictPrompt",
        "clampDuration",
        "deadlineExpired",
        "decide",
        "decideClear",
        "decideTurnEnd",
        "deferEvaluation",
        "deliveryRetryDecision",
        "faultInstruction",
        "normalizeConfig",
        "parseVerdict",
        "selectQueued",
        "tag",
    ] {
        let n = usize::from(!matches!(name, "tag" | "faultInstruction"));
        let f = function(api, name, n, n, move |p, a| {
            if name == "tag" {
                return text(p, core::UNATTENDED_TAG);
            }
            if name == "faultInstruction" {
                return text(p, &core::fault_instruction());
            }
            let json = p.global()?.get(c"JSON")?;
            let v = a[0];
            let input = if name == "parseVerdict" {
                if v.nullish()? {
                    String::new()
                } else {
                    js(v)?
                }
            } else {
                let encoded = call(json, c"stringify", &[or(v, obj(p)?)?])?;
                if encoded.undefined()? {
                    return Err(napi::Error::new(
                        napi::Status::StringExpected,
                        "Failed to convert JavaScript value `Undefined` into rust type `String`",
                    ));
                }
                encoded.coerce_string()?.to_string_lossy()
            };
            let out = match name {
                "armDeadline" => core::arm_deadline(&input),
                "bootRecover" => core::boot_recover(&input),
                "buildVerdictPrompt" => core::build_verdict_prompt(&input),
                "clampDuration" => core::clamp_duration(&input),
                "deadlineExpired" => core::deadline_expired(&input),
                "decide" => core::decide(&input),
                "decideClear" => core::decide_clear(&input),
                "decideTurnEnd" => core::decide_turn_end(&input),
                "deferEvaluation" => core::defer_evaluation(&input),
                "deliveryRetryDecision" => core::delivery_retry_decision(&input),
                "normalizeConfig" => core::normalize_config(&input),
                "parseVerdict" => core::parse_verdict(&input),
                "selectQueued" => core::select_queued(&input),
                _ => unreachable!(),
            }
            .map_err(napi::Error::from_reason)?;
            let v = call(json, c"parse", &[text(p, &out)?])?;
            if name == "buildVerdictPrompt" {
                v.get(c"prompt")
            } else {
                Ok(v)
            }
        })?;
        api.set_key(text(api, name)?, f)?;
    }
    call(
        api.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            api,
            text(api, "TAG")?,
            fields(
                api,
                &[
                    (
                        "get",
                        function(api, "get TAG", 0, 0, |p, _| text(p, core::UNATTENDED_TAG))?,
                    ),
                    ("enumerable", flag(api, true)?),
                    ("configurable", flag(api, true)?),
                ],
            )?,
        ],
    )?;
    Ok(api.raw())
}
