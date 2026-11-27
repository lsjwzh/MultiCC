//! Keep table and result identity in the caller's V8 environment.
use crate::{host_methods::function, route_response::*};
use multicc_core::classify_vocab as core;
use napi_derive::napi;

fn json_parse<'a>(s: L<'a>, encoded: &str) -> Result<L<'a>> {
    call(s.global()?.get(c"JSON")?, c"parse", &[text(s, encoded)?])
}

fn request<'a>(s: L<'a>, op: &str, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let json = s.global()?.get(c"JSON")?;
    let encoded = call(json, c"stringify", &[fields(s, args)?])?;
    let result =
        super::classify_vocab_request(op.to_owned(), encoded.coerce_string()?.to_string_lossy())?;
    json_parse(s, &result)
}

fn nullable(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        null(v)
    } else {
        Ok(v)
    }
}

fn display<'a>(s: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let table = s.get(c"classifyDisplay")?;
    let row = table.get_key(key)?;
    if row.truthy()? {
        Ok(row)
    } else {
        table.get(c"W")
    }
}

#[napi]
pub fn classify_vocab_api(env: Env, signatures: Unknown<'_>) -> Result<sys::napi_value> {
    let signatures = L::new(&env, signatures);
    let s = json_parse(signatures, &super::classify_vocab_catalog()?)?;
    s.set(c"signatures", signatures)?;
    let api = fields(s, &[])?;
    let parse = function(s, "parseClassifyResult", 1, 1, |s, a| {
        let input = if a[0].nullish()? {
            String::new()
        } else {
            string(a[0])?.coerce_string()?.to_string_lossy()
        };
        json_parse(s, &super::parse_classify_result(input)?)
    })?;
    api.set(c"parseClassifyResult", parse)?;
    api.set(
        c"buildClassifySystemPrompt",
        function(s, "buildClassifySystemPrompt", 1, 1, |s, a| {
            request(
                s,
                "buildSystemPrompt",
                &[
                    ("priorGoal", nullable(a[0])?),
                    ("errorSignatures", s.get(c"signatures")?.call_plain(&[])?),
                ],
            )?
            .get(c"prompt")
        })?,
    )?;
    api.set(
        c"classifyDisplay",
        function(s, "classifyDisplay", 1, 1, |s, a| display(s, a[0]))?,
    )?;
    api.set(
        c"runStateForClassify",
        function(s, "runStateForClassify", 1, 1, |s, a| {
            crate::js_iteration::read(display(s, a[0])?, c"cardStatus")
        })?,
    )?;
    api.set(
        c"phaseLabel",
        function(s, "phaseLabel", 1, 1, |s, a| {
            fallback(s.get(c"phaseLabels")?.get_key(a[0])?, "".into())
        })?,
    )?;
    api.set(
        c"applyUserInputEvidence",
        function(s, "applyUserInputEvidence", 2, 2, |s, a| {
            if !a[1].truthy()? || a[1].get(c"resolved")?.is_true()? {
                return Ok(a[0]);
            }
            request(
                s,
                "applyUserInputEvidence",
                &[("result", a[0]), ("pendingUserInput", a[1])],
            )
        })?,
    )?;
    api.set(
        c"userInputDegraded",
        function(s, "userInputDegraded", 3, 3, |s, a| {
            request(
                s,
                "userInputDegraded",
                &[
                    ("pendingUserInput", a[0]),
                    ("state", a[1]),
                    ("currentTask", a[2]),
                ],
            )
        })?,
    )?;
    for (name, predicate) in [
        (
            "isProcessingLetter",
            core::is_processing_letter as fn(&str) -> bool,
        ),
        ("isWaitForUserLetter", |v| v == "W"),
        ("isBackgroundLetter", |v| v == "B"),
        ("isTerminalLetter", core::is_terminal_letter),
        ("isAbnormalLetter", core::is_abnormal_letter),
        ("isSettledLetter", |v| matches!(v, "D" | "W")),
        ("isParkedLetter", |v| matches!(v, "W" | "B")),
        ("isOutcomeLetter", |v| {
            core::is_terminal_letter(v) || core::is_abnormal_letter(v)
        }),
    ] {
        let f = function(s, name, 1, 1, move |s, a| {
            flag(
                s,
                a[0].string()?
                    .is_some_and(|v| predicate(&v.to_string_lossy())),
            )
        })?;
        api.set_key(text(s, name)?, f)?;
    }
    api.set(
        c"turnOutcomeForClassify",
        function(s, "turnOutcomeForClassify", 1, 1, |s, a| {
            fallback(
                s.get(c"classifyTurnOutcome")?.get_key(a[0])?,
                "waiting_user".into(),
            )
        })?,
    )?;
    api.set(
        c"goalStateForClassify",
        function(s, "goalStateForClassify", 1, 1, |s, a| {
            request(s, "goalStateForClassify", &[("result", nullable(a[0])?)])
        })?,
    )?;
    api.set(
        c"resolveGoalState",
        function(s, "resolveGoalState", 3, 3, |s, a| {
            request(
                s,
                "resolveGoalState",
                &[
                    ("state", nullable(a[0])?),
                    ("modelValue", nullable(a[1])?),
                    ("result", nullable(a[2])?),
                ],
            )
        })?,
    )?;
    api.set(
        c"isGoalState",
        function(s, "isGoalState", 1, 1, |s, a| {
            flag(
                s,
                a[0].string()?
                    .is_some_and(|v| core::is_goal_state(&v.to_string_lossy())),
            )
        })?,
    )?;
    api.set(
        c"classifyGroupKey",
        function(s, "classifyGroupKey", 2, 2, |s, a| {
            request(
                s,
                "classifyGroupKey",
                &[("state", nullable(a[0])?), ("goalState", nullable(a[1])?)],
            )
        })?,
    )?;
    api.set(c"GOAL_STATES", s.get(c"goalStates")?.freeze()?)?;
    api.set(c"CLASSIFY_DISPLAY", s.get(c"classifyDisplay")?)?;
    api.set(
        c"CLASSIFY_STATES",
        s.global()?
            .get(c"Set")?
            .construct(&[s.get(c"classifyStates")?])?,
    )?;
    api.set(
        c"CLASSIFY_TURN_OUTCOME",
        s.get(c"classifyTurnOutcome")?.freeze()?,
    )?;
    api.set(c"TURN_RUN_STATES", s.get(c"turnRunStates")?.freeze()?)?;
    api.set(c"OPEN_RUN_STATES", s.get(c"openRunStates")?.freeze()?)?;
    api.set(
        c"isOpenRunState",
        function(s, "isOpenRunState", 1, 1, |s, a| {
            call(s.get(c"openRunStates")?, c"includes", &[a[0]])
        })?,
    )?;
    api.set(c"PHASE_LABELS", s.get(c"phaseLabels")?)?;
    Ok(api.raw())
}
