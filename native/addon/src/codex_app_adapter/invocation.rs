use super::*;
fn optional_method<'a>(deps: L<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let callback = deps.get(key)?;
    if callback.nullish()? {
        deps.from_value(&V::Undefined)
    } else {
        callback.call(deps, args)
    }
}
pub(crate) fn build<'a>(env: &'a Env, input: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let deps = ports.get(c"deps")?;
    let so = input.get(c"spawnOpts")?;
    let session = object(
        input,
        &[
            (c"effort", so.get(c"rawEffort")?),
            (
                c"model",
                property(so, c"rawModel", || {
                    property(so, c"effectiveModel", || input.from_value(&V::Null))
                })?,
            ),
            (c"effectiveModel", so.get(c"effectiveModel")?),
        ],
    )?;
    let mut prompt = crate::message_composer::render_prompt(env, input)?;
    if input.get(c"historyHandle")?.get(c"isFirstTurn")?.truthy()? {
        let values = array(input)?;
        for value in [
            deps.get(c"multiccImgHint")?,
            deps.get(c"envConstraint")?,
            input.get(c"subagentHint")?,
        ] {
            push(values, &[value])?;
        }
        if input.get(c"rolePrompt")?.truthy()? {
            push(
                values,
                &[concat(
                    input,
                    &[
                        text(input, "[Role prompt]\n")?,
                        input.get(c"rolePrompt")?,
                        text(input, "\n[End of role prompt]")?,
                    ],
                )?],
            )?;
        }
        let kept = array(input)?;
        values.for_each(|value| {
            if value.truthy()? {
                push(kept, &[value])?;
            }
            Ok(())
        })?;
        prompt = concat(input, &[join(kept, "\n\n")?, text(input, "\n\n")?, prompt])?;
    } else if deps.get(c"envConstraint")?.truthy()? {
        prompt = concat(
            input,
            &[deps.get(c"envConstraint")?, text(input, "\n\n")?, prompt],
        )?;
    }
    let args = array(input)?;
    push(
        args,
        &[
            ports.get(c"bridge")?,
            text(input, "--codex-bin")?,
            property(deps, c"codexCmd", || text(input, "codex"))?,
        ],
    )?;
    if input
        .get(c"historyHandle")?
        .get(c"cliSessionId")?
        .truthy()?
    {
        push(
            args,
            &[
                text(input, "--thread-id")?,
                input.get(c"historyHandle")?.get(c"cliSessionId")?,
            ],
        )?;
    }
    if session.get(c"model")?.truthy()? {
        push(args, &[text(input, "--model")?, session.get(c"model")?])?;
    }
    let effort = optional_method(deps, c"codexReasoningLevel", &[session])?;
    if effort.truthy()? {
        push(args, &[text(input, "--effort")?, effort])?;
    }
    let configs = array(input)?;
    push(
        configs,
        &[
            optional_method(deps, c"codexReasoningConfigArg", &[session])?,
            optional_method(deps, c"codexModelConfigArg", &[session])?,
        ],
    )?;
    router(
        input,
        deps.get(c"routerMcpNode")?,
        deps.get(c"routerMcpScript")?,
    )?
    .for_each(|value| push(configs, &[value]))?;
    configs.for_each(|value| {
        if value.truthy()? {
            push(args, &[text(input, "--config")?, value])?;
        }
        Ok(())
    })?;
    let once = array(input)?;
    args.for_each(|value| push(once, &[value]))?;
    push(once, &[text(input, "--")?])?;
    let resident = array(input)?;
    args.for_each(|value| push(resident, &[value]))?;
    push(resident, &[text(input, "--resident")?])?;
    object(
        input,
        &[
            (c"cmd", ports.get(c"executable")?),
            (c"args", once),
            (c"payload", prompt),
            (c"streamArgs", resident),
            (c"streamBackend", text(input, "app-server")?),
            (c"nativeKey", text(input, "cliSessionId")?),
            (c"clientAllocatesNativeId", boolean(input, false)?),
            (
                c"turnOptions",
                object(
                    input,
                    &[
                        (
                            c"model",
                            property(session, c"model", || input.from_value(&V::Null))?,
                        ),
                        (c"effort", or(effort, || input.from_value(&V::Null))?),
                    ],
                )?,
            ),
        ],
    )
}
