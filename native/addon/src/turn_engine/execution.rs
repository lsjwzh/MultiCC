//! 单次回合从准入、认领、等待落盘到交付运行器；只在宿主确实返回异步结果时让出执行。
use super::{admission_finish, claim, invocation, preflight, preparation, task_start};
use crate::{host_methods::method, route_response::*};
use napi_derive::napi;

type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
fn then<'a>(owner: L<'a>, pending: L<'a>, count: usize, run: Handler) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let f = method(&env, owner, "", count, count, run)?;
    let result = call(pending, c"then", &[f])?;
    Ok(L::from_raw(owner.env(), result.raw()))
}
fn permit<'a>(p: L<'a>, session: L<'a>, opts: L<'a>) -> Result<()> {
    let get = p.get(c"getWorkspaceAdmission")?;
    if !get.nullish()? {
        let workspace = get.call_plain(&[])?;
        if !workspace.nullish()? {
            call(workspace, c"assertPermit", &[session, opts])?;
        }
    }
    Ok(())
}

fn after_configuration<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if a[0].is_false()? {
        return fields(
            s,
            &[
                ("blocked", flag(s, true)?),
                ("code", text(s, "turn_configuration_pending")?),
            ],
        );
    }
    admission_finish::finish(
        s.get(c"ports")?,
        &mut [
            s.get(c"session")?,
            s.get(c"message")?,
            s.get(c"opts")?,
            s.get(c"persisted")?,
            s.get(c"replay")?,
        ],
    )
}

fn after_probe<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    s.set(c"replay", flag(s, a[0].is_true()?)?)?;
    let configured = preflight::configuration(
        s.get(c"ports")?,
        &mut [
            s.get(c"session")?,
            s.get(c"opts")?,
            s.get(c"message")?,
            s.get(c"delivery")?,
            a[0],
        ],
    )?;
    if configured.truthy()? && configured.get(c"then")?.kind()? == sys::ValueType::napi_function {
        then(s, configured, 1, after_configuration)
    } else {
        after_configuration(s, &mut [configured])
    }
}

fn gate<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    permit(p, a[0], a[2])?;
    let state = preflight::start(p, a)?;
    if state.get(c"blocked")?.truthy()? {
        return Ok(state);
    }
    state.set(c"ports", p)?;
    state.set(c"session", a[0])?;
    state.set(c"message", a[1])?;
    let delivery = state.get(c"delivery")?;
    if !delivery.truthy()? {
        return after_probe(state, &mut [flag(p, false)?]);
    }
    let service = p.get(c"getChatHistoryService")?.call_plain(&[])?;
    let saved = call(service, c"hasPersistedDelivery", &[a[0], delivery])?;
    let pending = call(p.global()?.get(c"Promise")?, c"resolve", &[saved])?;
    then(state, pending, 1, after_probe)
}

fn outcome(value: L<'_>) -> Result<L<'_>> {
    fields(value, &[("result", value)])
}
fn begin<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (session, opts, gate) = (a[0], a[1], a[2]);
    permit(p, session, opts)?;
    if gate.get(c"blocked")?.truthy()? {
        return outcome(preflight::guard_failure(p, a)?);
    }
    if gate.has(c"delegated")? {
        return outcome(gate.get(c"delegated")?);
    }
    let record = gate.get(c"persisted")?;
    let request = gate.get(c"turnRequest")?;
    let msg = request.get(c"text")?;
    let client = fallback(request.get(c"identity")?.get(c"clientMsgId")?, "".into())?;
    let delivery = fallback(request.get(c"identity")?.get(c"deliveryId")?, "".into())?;
    let dispatch = request.get(c"origin")?.get(c"operationId")?;
    let continuing = request
        .get(c"launch")?
        .get(c"reason")?
        .is_string("continue")?;
    let direct = opts.get(c"directUserInput")?.is_true()?;
    let tasks = request.get(c"background")?.get(c"taskIds")?;
    let tools = request.get(c"background")?.get(c"toolUseIds")?;
    let requested = task_start::select_task(p, &mut [request.get(c"task")?, msg, record, session])?;
    let claimed = claim::claim(p, &mut [session, opts, gate, request, client, delivery])?;
    if claimed.has(c"accepted")? {
        return outcome(claimed.get(c"accepted")?);
    }
    let id = claimed.get(c"turnId")?;
    let prep = preparation::start(p, &mut [session, id, client, delivery])?;
    let context = fields(
        p,
        &[
            ("sessionName", session),
            ("text", msg),
            ("opts", opts),
            ("persisted", record),
            ("turnRequest", request),
            ("cs", gate.get(c"existingCs")?),
            ("initialHistory", gate.get(c"initialHistory")?),
            ("turn", claimed.get(c"turn")?),
            ("turnId", id),
            ("preparation", prep),
            ("originContinue", flag(p, continuing)?),
            ("directUserInput", flag(p, direct)?),
            ("clientMsgId", client),
            ("deliveryId", delivery),
            ("originDispatchId", dispatch),
            ("bgTaskIds", tasks),
            ("bgToolUseIds", tools),
            ("requestedTask", requested),
            (
                "reexecutePersistedDelivery",
                claimed.get(c"reexecutePersistedDelivery")?,
            ),
            ("deliveryPersisted", gate.get(c"deliveryPersisted")?),
        ],
    )?;
    fields(p, &[("context", context)])
}

fn route<'a>(p: L<'a>, c: L<'a>, auto: L<'a>) -> Result<L<'a>> {
    let launch = invocation::route(p, c, auto)?;
    if launch.is_true()? {
        return outcome(launch);
    }
    if !launch.is_false()? {
        let child = p.get(c"spawnProcessTurn")?.call_plain(&[c, launch, auto])?;
        let cs = c.get(c"cs")?;
        cs.assign(c"claudeProc", child)?;
        if cs.get(c"claudeProc")?.truthy()? {
            let accepted =
                preparation::handed_off(p, &mut [c.get(c"preparation")?, text(c, "cli-process")?])?;
            return outcome(accepted);
        }
        c.get(c"preparation")?
            .set(c"failure", text(c, "process-runner-rejected")?)?;
    }
    fields(
        c,
        &[("settle", flag(c, true)?), ("result", flag(c, false)?)],
    )
}

fn next<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let c = a[0];
    if c.get(c"awaitingQuota")?.is_true()? {
        return route(p, c, a[1]);
    }
    let step = task_start::prepare(p, a)?;
    if step.get(c"waiting")?.is_true()? {
        return Ok(step);
    }
    if !step.get(c"accepted")?.truthy()? {
        return outcome(flag(c, false)?);
    }
    c.set(c"durableMessageProof", step.get(c"proof")?)?;
    let quota = invocation::begin(p, c)?;
    if !quota.truthy()? {
        return fields(
            c,
            &[("settle", flag(c, true)?), ("result", flag(c, false)?)],
        );
    }
    let value = quota.get(c"value")?;
    if quota.get(c"asynchronous")?.truthy()? {
        c.set(c"awaitingQuota", flag(c, true)?)?;
        fields(c, &[("waiting", flag(c, true)?), ("pending", value)])
    } else {
        route(p, c, value)
    }
}

#[napi]
pub fn chat_turn_execution(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    task_start::configure(p)?;
    Ok(fields(
        p,
        &[
            ("gate", method(&env, p, "gate", 3, 3, gate)?),
            ("begin", method(&env, p, "begin", 3, 3, begin)?),
            ("next", method(&env, p, "next", 1, 2, next)?),
            (
                "settle",
                method(&env, p, "settle", 1, 1, |p, a| {
                    preparation::settle(p, &mut [a[0].get(c"preparation")?, a[0].get(c"cs")?])
                })?,
            ),
            (
                "settleFailed",
                method(&env, p, "settleFailed", 2, 2, |p, a| {
                    preparation::settle_failed(p, &mut [a[0].get(c"preparation")?, a[1]])
                })?,
            ),
            (
                "failed",
                method(&env, p, "failed", 2, 2, |p, a| {
                    preparation::failed(p, &mut [a[0].get(c"preparation")?, a[0].get(c"cs")?, a[1]])
                })?,
            ),
            (
                "release",
                method(&env, p, "release", 1, 1, |p, a| {
                    preparation::release(p, &mut [a[0].get(c"preparation")?])
                })?,
            ),
        ],
    )?
    .raw())
}
