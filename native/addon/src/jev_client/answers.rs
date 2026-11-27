use super::*;

// Evaluate each prefix again, as in obj && obj.path && obj.path.value.
// A registry or SDK response may expose observable getters.
fn guarded<'a>(root: L<'a>, path: &[&CStr]) -> Result<L<'a>> {
    let mut result = root;
    for end in 1..=path.len() {
        if !result.truthy()? {
            break;
        }
        result = root;
        for key in &path[..end] {
            result = result.get(key)?;
        }
    }
    Ok(result)
}
pub(super) fn read(payload: L<'_>) -> Result<L<'_>> {
    for candidate in [
        guarded(payload, &[c"answers"])?,
        guarded(payload, &[c"result", c"answers"])?,
        guarded(payload, &[c"output", c"answers"])?,
        guarded(payload, &[c"data", c"answers"])?,
    ] {
        if object(candidate)? && !candidate.is_array()? {
            return Ok(candidate);
        }
    }
    null(payload)
}
pub(super) fn confidence(payload: L<'_>, id: L<'_>) -> Result<Option<f64>> {
    let nested = guarded(payload, &[c"providerMetadata", c"typesafe", c"confidence"])?;
    let direct = guarded(payload, &[c"confidence"])?;
    let answers = read(payload)?;
    let scoped = if answers.truthy()? {
        answers.get_key(id)?
    } else {
        answers
    };
    let absent = null(payload)?;
    ratio(first(
        payload,
        &[
            if object(scoped)? {
                scoped.get(c"confidence")?
            } else {
                absent
            },
            if object(nested)? {
                nested.get_key(id)?
            } else {
                absent
            },
            if object(direct)? {
                direct.get_key(id)?
            } else {
                absent
            },
        ],
    )?)
}
fn choice(answer: L<'_>) -> Result<L<'_>> {
    if !object(answer)? {
        return null(answer);
    }
    let value = first(
        answer,
        &[
            answer.get(c"choice")?,
            answer.get(c"value")?,
            answer.get(c"answer")?,
            answer.get(c"label")?,
        ],
    )?;
    if value.nullish()? || object(value)? {
        null(answer)
    } else {
        call(string(value)?, c"trim", &[])
    }
}
fn probabilities(answer: L<'_>) -> Result<L<'_>> {
    let raw = first(
        answer,
        &[
            guarded(answer, &[c"probabilities"])?,
            guarded(answer, &[c"probability"])?,
        ],
    )?;
    if !object(raw)? || raw.is_array()? {
        return null(answer);
    }
    let map = answer.global()?.get(c"Map")?.construct(&[])?;
    let entries = call(answer.global()?.get(c"Object")?, c"entries", &[raw])?;
    entries.for_each(|pair| {
        if let Some(p) = ratio(pair.element(1)?)? {
            call(
                map,
                c"set",
                &[
                    call(pair.element(0)?, c"toLowerCase", &[])?,
                    num(answer, p)?,
                ],
            )?;
        }
        Ok(())
    })?;
    if map.get(c"size")?.truthy()? {
        Ok(map)
    } else {
        null(answer)
    }
}
pub(super) fn detail(payload: L<'_>) -> Result<L<'_>> {
    let v = first(
        payload,
        &[
            guarded(payload, &[c"error", c"message"])?,
            guarded(payload, &[c"error"])?,
            guarded(payload, &[c"message"])?,
        ],
    )?;
    if v.nullish()? || object(v)? {
        null(v)
    } else {
        slice(string(v)?, 200.)
    }
}
pub(super) fn failure<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("code", text(p, code)?)])
}

pub(super) fn verdict<'a>(
    tiers: L<'a>,
    escalation: L<'a>,
    answers: L<'a>,
    payload: L<'a>,
) -> Result<L<'a>> {
    if !tiers.get(c"length")?.truthy()? {
        return failure(tiers, "jev_no_tiers")?.freeze();
    }
    let top = (tiers.get(c"length")?.number()? - 1.) as usize;
    let chosen = tier_index(tiers, choice(answers.get(c"tier")?)?)?;
    let probs = if chosen.is_some() {
        probabilities(answers.get(c"tier")?)?
    } else {
        null(tiers)?
    };
    let chosen_prob = if !probs.nullish()? {
        let index = chosen.expect("probability map requires chosen tier");
        let key = call(
            tiers.element(index as u32)?.get(c"key")?,
            c"toLowerCase",
            &[],
        )?;
        number_or_none(call(probs, c"get", &[key])?)?
    } else {
        None
    };
    let conf = match confidence(payload, text(tiers, "tier")?)? {
        Some(n) => Some(n),
        None => confidence(payload, text(tiers, "complexity")?)?,
    };
    let answer = answers.get(c"complexity")?;
    let score = if object(answer)? {
        number_or_none(first(
            answer,
            &[answer.get(c"score")?, answer.get(c"value")?],
        )?)?
    } else {
        None
    };
    let complexity = match score {
        Some(n) => Some(
            (call(tiers.global()?.get(c"Math")?, c"round", &[num(tiers, n)?])?.number()? as usize)
                .min(top),
        ),
        None => None,
    };
    if chosen.is_none() && complexity.is_none() {
        return failure(tiers, "jev_unreadable_answers")?.freeze();
    }
    let low_conf = match conf {
        Some(n) => Some(n < escalation.get(c"minConfidence")?.explicit_number()?),
        None => None,
    };
    let low_prob = match chosen_prob {
        Some(n) => n < escalation.get(c"minTierProbability")?.explicit_number()?,
        None => false,
    };
    let (i, reason) = routing::choose_routing_tier(top, chosen, complexity, low_conf, low_prob);
    let key = tiers.element(i as u32)?.get(c"key")?;
    let chosen_key = match chosen {
        Some(i) => tiers.element(i as u32)?.get(c"key")?,
        None => null(tiers)?,
    };
    let distribution = if probs.nullish()? {
        null(tiers)?
    } else {
        call(tiers.global()?.get(c"Object")?, c"fromEntries", &[probs])?.freeze()?
    };
    fields(
        tiers,
        &[
            ("ok", flag(tiers, true)?),
            ("tierIndex", num(tiers, i as f64)?),
            ("tier", key),
            ("reasonCode", text(tiers, reason)?),
            ("escalated", flag(tiers, chosen.is_none_or(|c| i > c))?),
            ("chosenTier", chosen_key),
            ("chosenProbability", option_num(tiers, chosen_prob)?),
            ("tierProbabilities", distribution),
            ("complexityScore", option_num(tiers, score)?),
            (
                "complexityIndex",
                option_num(tiers, complexity.map(|v| v as f64))?,
            ),
            ("confidence", option_num(tiers, conf)?),
        ],
    )?
    .freeze()
}
