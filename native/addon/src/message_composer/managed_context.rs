//! A turn retains its prepared plan across attempts. The JS closures keep the
//! state alive; each native call only borrows it for the duration of the call.
use super::{render_prompt, text, Env, Result, Unknown, L, V};
use crate::js_iteration::read;
use napi::{bindgen_prelude::ToNapiValue, sys};
use napi_derive::napi;

fn fields<'a>(anchor: L<'a>, entries: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let out = anchor.from_value(&V::Object(vec![]))?;
    for (key, value) in entries {
        out.define_key(text(out, key)?, *value)?;
    }
    Ok(out)
}

fn spread(value: L<'_>) -> Result<L<'_>> {
    let copy = fields(value, &[])?;
    copy.spread_from(value)?;
    Ok(copy)
}

fn invoke<'a>(receiver: L<'a>, method: L<'a>, args: &[L<'a>], site: &str) -> Result<L<'a>> {
    if method.kind()? != sys::ValueType::napi_function {
        return Err(receiver.type_error(&format!("{site} is not a function")));
    }
    method.call(receiver, args)
}

fn prepare<'a>(host: L<'a>, session: L<'a>, input: L<'a>) -> Result<L<'a>> {
    invoke(
        host,
        read(host, c"prepareTaskContext")?,
        &[session, input],
        "host.prepareTaskContext",
    )
}

#[napi]
pub fn managed_context_prepare(
    env: Env,
    ports: Unknown<'_>,
    assign: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let host = ports.get(c"host")?;
    let memory = ports.get(c"memory")?;
    let session = ports.get(c"sessionName")?;
    let turn = ports.get(c"turn")?;
    let opts = ports.get(c"opts")?;
    let input = fields(
        ports,
        &[
            ("receiptId", read(opts, c"taskShellReceiptId")?),
            ("turnId", read(turn, c"turnId")?),
            ("text", ports.get(c"text")?),
            ("isFirstTurn", ports.get(c"isFirstTurn")?),
            ("fallback", read(opts, c"taskContextSeed")?),
            ("memory", memory),
        ],
    )?;
    if !input.get(c"receiptId")?.truthy()? || !host.optional(c"prepareTaskContext")?.truthy()? {
        return Ok(ports.from_value(&V::Null)?.raw());
    }
    let plan = prepare(host, session, input)?;
    if !plan.truthy()? {
        return Ok(ports.from_value(&V::Null)?.raw());
    }
    let reference = fields(
        turn,
        &[
            ("receiptId", input.get(c"receiptId")?),
            ("sessionName", session),
            ("host", host),
        ],
    )?;
    L::new(&env, assign).call_plain(&[turn, text(turn, "managedContext")?, reference])?;
    Ok(fields(
        ports,
        &[
            ("seed", plan.get(c"text")?),
            ("plan", plan),
            ("input", input),
            ("host", host),
            ("sessionName", session),
        ],
    )?
    .raw())
}

#[napi]
pub fn managed_context_role(
    env: Env,
    memory: Unknown<'_>,
    record: Unknown<'_>,
) -> Result<sys::napi_value> {
    let memory = L::new(&env, memory);
    let resolve = read(memory, c"resolveRolePrompt")?;
    let options = fields(memory, &[("managed", memory.from_value(&V::Bool(true))?)])?;
    Ok(invoke(
        memory,
        resolve,
        &[L::new(&env, record), options],
        "memory.resolveRolePrompt",
    )?
    .raw())
}

#[napi]
pub fn managed_context_attempt(
    env: Env,
    state: Unknown<'_>,
    envelope: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let state = L::new(&env, state);
    let options = L::new(&env, options);
    if !read(options, c"firstTurn")?.is_true()? {
        return Ok(options.raw());
    }
    if !read(state.get(c"plan")?, c"initial")?.truthy()? {
        let host = state.get(c"host")?;
        let prepare = read(host, c"prepareTaskContext")?;
        let input = spread(state.get(c"input")?)?;
        let yes = state.from_value(&V::Bool(true))?;
        input.define_key(text(input, "isFirstTurn")?, yes)?;
        input.define_key(text(input, "force")?, yes)?;
        let plan = invoke(
            host,
            prepare,
            &[state.get(c"sessionName")?, input],
            "host.prepareTaskContext",
        )?;
        state.set(c"plan", plan)?;
    }
    let envelope = L::new(&env, envelope);
    let updated = spread(envelope)?;
    let layers = read(envelope, c"contextLayers")?;
    let filter = read(layers, c"filter")?;
    let keep = env.create_function_from_closure::<Unknown<'_>, bool, _>("", |ctx| {
        let layer = L::new(ctx.env, ctx.get(0)?);
        Ok(!read(layer, c"kind")?.is_string("task-context")?)
    })?;
    let kept = invoke(
        layers,
        filter,
        &[L::new(&env, keep.into_unknown(&env)?)],
        "envelope.contextLayers.filter",
    )?;
    updated.define_key(text(updated, "contextLayers")?, kept)?;
    if read(state.get(c"plan")?, c"text")?.truthy()? {
        let push = read(kept, c"push")?;
        let layer = fields(
            state,
            &[
                ("kind", text(state, "task-context")?),
                ("order", state.from_value(&V::Number(12.0))?),
                ("text", read(state.get(c"plan")?, c"text")?),
            ],
        )?;
        invoke(kept, push, &[layer], "updated.contextLayers.push")?;
    }
    let result = spread(options)?;
    result.define_key(text(result, "bareText")?, render_prompt(&env, updated)?)?;
    Ok(result.raw())
}

#[napi]
pub fn managed_context_sent(env: Env, turn: Unknown<'_>) -> Result<()> {
    let turn = L::new(&env, turn);
    let reference = read(turn, c"managedContext")?;
    if reference.truthy()? {
        let host = read(reference, c"host")?;
        let sent = read(host, c"taskContextSent")?;
        invoke(
            host,
            sent,
            &[
                read(reference, c"sessionName")?,
                read(reference, c"receiptId")?,
                read(turn, c"turnId")?,
            ],
            "ref.host.taskContextSent",
        )?;
    }
    Ok(())
}

#[napi]
pub fn managed_context_completed(
    env: Env,
    context: Unknown<'_>,
    resolved: Unknown<'_>,
) -> Result<()> {
    let context = L::new(&env, context);
    let turn = read(context, c"turn")?;
    let reference = read(turn, c"managedContext")?;
    if !reference.truthy()? {
        return Ok(());
    }
    let success = if read(context, c"terminalBlocked")?.truthy()? {
        context.from_value(&V::Bool(false))?
    } else {
        let effects = read(L::new(&env, resolved), c"effects")?;
        let some = read(effects, c"some")?;
        let succeeded = env.create_function_from_closure::<Unknown<'_>, bool, _>("", |ctx| {
            let effect = L::new(ctx.env, ctx.get(0)?);
            Ok(read(effect, c"type")?.is_string("classify-turn-end")?
                && read(effect, c"classification")?.is_string("succeeded")?)
        })?;
        invoke(
            effects,
            some,
            &[L::new(&env, succeeded.into_unknown(&env)?)],
            "resolved.effects.some",
        )?
    };
    let host = read(reference, c"host")?;
    let complete = read(host, c"taskContextComplete")?;
    invoke(
        host,
        complete,
        &[
            read(reference, c"sessionName")?,
            read(reference, c"receiptId")?,
            read(turn, c"turnId")?,
            success,
        ],
        "ref.host.taskContextComplete",
    )?;
    Ok(())
}
