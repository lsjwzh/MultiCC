//! Auxiliary memory jobs retain the live record map and the exact Promise
//! exposed to admission. Each factory owns its own pending and review maps.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use multicc_core::js::JsString;
use napi_derive::napi;
mod entries;
use entries::*;
type Method = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;

fn bind(
    owner: L<'_>,
    api: L<'_>,
    name: &'static str,
    length: usize,
    argc: usize,
    run: Method,
) -> Result<()> {
    api.define_key(text(api, name)?, function(owner, name, length, argc, run)?)
}
fn interval(v: L<'_>) -> Result<f64> {
    let s = if v.nullish()? || v.is_string("")? {
        text(v, "10")?
    } else {
        v
    };
    let n = v
        .global()?
        .get(c"parseInt")?
        .call_plain(&[s, num(v, 10.)?])?
        .number()?;
    Ok(n.max(0.))
}
#[napi]
pub fn session_memory_runtime_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let owner = L::new(&env, anchor);
    let strings = |s: &[&str]| -> Result<L<'_>> {
        array(
            owner,
            &s.iter()
                .map(|v| text(owner, v))
                .collect::<Result<Vec<_>>>()?,
        )?
        .freeze()
    };
    let api = fields(
        owner,
        &[
            ("SESSION_MEMORY_MAX", num(owner, 8000.)?),
            ("MEMORY_REVIEW_MAX_MESSAGES", num(owner, 30.)?),
            ("MEMORY_TYPES", strings(&TYPES)?),
            ("MEMORY_EVICTION_ORDER", strings(&EVICTION)?),
        ],
    )?;
    for (name, len, argc, run) in [
        ("createMemoryRuntime", 1, 1, (|_, a| create(a[0])) as Method),
        ("getMemoryEntries", 1, 1, |_, a| get_entries(a[0])),
        ("memorySimilarity", 2, 2, |o, a| {
            num(o, similarity(a[0], a[1])?)
        }),
        ("mergeMemoryEntries", 2, 2, |_, a| merge(a[0], a[1])),
        ("normalizeManualMemory", 1, 2, |_, a| {
            normalize(a[0], default_object(a[1])?)
        }),
        ("parseMemoryEntries", 1, 2, |_, a| {
            parse(a[0], default_object(a[1])?)
        }),
        ("resolveReviewInterval", 1, 1, |o, a| {
            num(o, interval(a[0])?)
        }),
        ("trimMemoryEntries", 1, 2, |o, a| {
            trim(
                a[0],
                if a[1].undefined()? {
                    num(o, 8000.)?
                } else {
                    a[1]
                },
            )
        }),
    ] {
        bind(owner, api, name, len, argc, run)?
    }
    Ok(api.raw())
}
fn create(deps: L<'_>) -> Result<L<'_>> {
    if deps.kind()? != sys::ValueType::napi_object {
        return Err(deps.type_error("[memory-runtime] dependencies are required"));
    }
    for (name, container, key) in [
        ("records.get", Some(c"records"), c"get"),
        ("auxQueue", Some(c"auxQueue"), c"enqueue"),
        ("loadHistory", None, c"loadHistory"),
        ("writeAutoFile", None, c"writeAutoFile"),
        ("saveBestEffort", None, c"saveBestEffort"),
        ("scanContent", None, c"scanContent"),
        ("appendEvent", None, c"appendEvent"),
        ("workspaceBroadcast", None, c"workspaceBroadcast"),
    ] {
        let host = if let Some(k) = container {
            deps.get(k)?
        } else {
            deps
        };
        if host.optional(key)?.kind()? != sys::ValueType::napi_function {
            return Err(deps.type_error(&format!("[memory-runtime] {name} is required")));
        }
    }
    let logger = deps.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        deps.global()?.get(c"console")?
    };
    let map = deps.global()?.get(c"Map")?;
    let state = fields(
        deps,
        &[
            ("deps", deps),
            ("logger", logger),
            ("now", clock(deps)?),
            ("recordApiError", deps.get(c"recordApiError")?),
            (
                "interval",
                num(deps, interval(deps.get(c"reviewInterval")?)?)?,
            ),
            (
                "maxMessages",
                default_number(deps.get(c"reviewMaxMessages")?, 30.)?,
            ),
            (
                "maxLength",
                default_number(deps.get(c"memoryMaxLength")?, 8000.)?,
            ),
            ("reviews", map.construct(&[])?),
            ("pending", map.construct(&[])?),
        ],
    )?;
    let api = fields(deps, &[])?;
    for (name, len, run) in [
        (
            "distillHistoryIntoMemory",
            2,
            (|s, a| enqueue(s, a[0], Some(a[1]))) as Method,
        ),
        ("getPendingDistill", 1, |s, a| {
            call(s.get(c"pending")?, c"get", &[a[0]])
        }),
        ("maybeSchedulePeriodicMemoryReview", 1, |s, a| {
            schedule(s, a[0])
        }),
        ("reviewConversationIntoMemory", 1, |s, a| {
            enqueue(s, a[0], None)
        }),
        ("trackPendingDistill", 2, |s, a| track(s, a[0], a[1])),
    ] {
        bind(state, api, name, len, len, run)?
    }
    api.freeze()
}
fn record<'a>(state: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(state.get(c"deps")?.get(c"records")?, c"get", &[id])
}
fn excluded(v: L<'_>) -> Result<bool> {
    Ok(
        !v.truthy()?
            || v.get(c"type")?.is_string("aux")?
            || v.get(c"type")?.is_string("gateway")?,
    )
}
fn resolve(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
fn skipped(v: L<'_>) -> Result<L<'_>> {
    resolve(fields(v, &[("updated", flag(v, false)?)])?)
}
fn save(state: L<'_>, reason: &str) -> Result<()> {
    call(
        state.get(c"deps")?,
        c"saveBestEffort",
        &[text(state, reason)?],
    )?;
    Ok(())
}
fn schedule<'a>(state: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let period = state.get(c"interval")?.number()?;
    let nothing = state.from_value(&V::Undefined)?;
    if period == 0. {
        return Ok(nothing);
    }
    let current = record(state, id)?;
    if excluded(current)?
        || (current.get(c"kind")?.truthy()? && !current.get(c"kind")?.is_string("chat")?)
    {
        return Ok(nothing);
    }
    let count = current
        .get(c"memoryReviewTurnCount")?
        .explicit_number()?
        .max(0.)
        + 1.;
    current.set(c"memoryReviewTurnCount", num(state, count)?)?;
    if count < period {
        save(state, "runtime.memory-review-counter")?
    } else {
        current.set(c"memoryReviewTurnCount", num(state, 0.)?)?;
        save(state, "runtime.memory-review-start")?;
        enqueue(state, id, None)?;
    }
    Ok(nothing)
}
fn eligible_messages(history: L<'_>) -> Result<L<'_>> {
    let predicate = function(history, "", 1, 1, |s, args| {
        let message = args[0];
        flag(
            s,
            message.truthy()?
                && (message.get(c"role")?.is_string("user")?
                    || message.get(c"role")?.is_string("assistant")?)
                && message.get(c"content")?.kind()? == sys::ValueType::napi_string
                && call(message.get(c"content")?, c"trim", &[])?.truthy()?,
        )
    })?;
    call(history, c"filter", &[predicate])
}
fn review_window<'a>(history: L<'a>, record: L<'a>) -> Result<L<'a>> {
    let mut start = 0.;
    if record.get(c"memoryReviewCursorId")?.truthy()? {
        let matches = function(record, "", 1, 1, |r, args| {
            let msg = args[0];
            flag(
                r,
                msg.truthy()? && msg.get(c"id")?.equals(r.get(c"memoryReviewCursorId")?)?,
            )
        })?;
        let index = call(history, c"findIndex", &[matches])?.number()?;
        if index >= 0. {
            start = index + 1.;
        }
    }
    eligible_messages(call(history, c"slice", &[num(history, start)?])?)
}
fn transcript(messages: L<'_>, cap: usize) -> Result<JsString> {
    let mut parts = Vec::new();
    messages.for_each(|message| {
        let user = message.get(c"role")?.is_string("user")?;
        let mut line = JsString::from(if user { "用户: " } else { "助手: " });
        line.push(
            &message
                .get(c"content")?
                .coerce_string()?
                .trim()
                .truncate_units(cap),
        );
        parts.push(line);
        Ok(())
    })?;
    Ok(JsString::join(&parts, &JsString::from("\n")))
}
fn prior_lines(entries: L<'_>) -> Result<JsString> {
    let mut lines = Vec::new();
    entries.for_each(|e| {
        let mut line = JsString::from("[");
        line.push(&e.get(c"type")?.coerce_string()?);
        line.push_str("] ");
        line.push(&e.get(c"text")?.coerce_string()?);
        lines.push(line);
        Ok(())
    })?;
    Ok(JsString::join(&lines, &JsString::from("\n")))
}
fn enqueue<'a>(state: L<'a>, id: L<'a>, input: Option<L<'a>>) -> Result<L<'a>> {
    let review = input.is_none();
    let reviews = state.get(c"reviews")?;
    if review && call(reviews, c"has", &[id])?.truthy()? {
        return call(reviews, c"get", &[id]);
    }
    let current = record(state, id)?;
    if excluded(current)? {
        return skipped(state);
    }
    let deps = state.get(c"deps")?;
    let (prompt, last) = if let Some(messages) = input {
        let history = if messages.truthy()? {
            messages
        } else {
            array(state, &[])?
        };
        let list = eligible_messages(history)?;
        let excerpt = transcript(list, 2000)?;
        if excerpt.len() < 40 {
            return skipped(state);
        }
        let entries = get_entries(current)?;
        let mut prompt = JsString::from(DISTILL_HEADER);
        if count(entries)? > 0 {
            prompt.push_str("【已有的会话记忆条目（请与新内容合并去重：语义重复的条目只保留信息更完整的一条）】\n");
            prompt.push(&prior_lines(entries)?);
            prompt.push_str("\n\n");
        }
        prompt.push_str("【待提炼的对话】\n");
        prompt.push(&excerpt.truncate_units(12000));
        prompt.push_str(DISTILL_FOOTER);
        (prompt, null(state)?)
    } else {
        let history = call(deps, c"loadHistory", &[id])?;
        let list = review_window(history, current)?;
        let subset = call(
            list,
            c"slice",
            &[num(state, -state.get(c"maxMessages")?.number()?)?],
        )?;
        let n = count(subset)?;
        if n == 0 {
            return skipped(state);
        }
        let last = fallback(subset.element((n - 1) as u32)?.get(c"id")?, V::Null)?;
        let mut prompt = JsString::from(REVIEW_HEADER);
        prompt.push(&transcript(subset, 1800)?.truncate_units(12000));
        prompt.push_str(REVIEW_FOOTER);
        (prompt, last)
    };
    let request = fields(
        state,
        &[
            (
                "type",
                text(
                    state,
                    if review {
                        "memory_review"
                    } else {
                        "memory_distill"
                    },
                )?,
            ),
            ("prompt", from_js(state, prompt)?),
            ("meta", fields(state, &[("sessionId", id)])?),
        ],
    )?;
    let task = call(deps.get(c"auxQueue")?, c"enqueue", &[request])?;
    let context = fields(state, &[("state", state), ("id", id), ("last", last)])?;
    let done = function(context, "", 1, 1, move |c, a| complete(c, a[0], review))?;
    let failed = function(context, "", 1, 1, move |c, a| {
        failure(c, a[0], if review { Job::Review } else { Job::Distill })
    })?;
    let task = call(call(task, c"then", &[done])?, c"catch", &[failed])?;
    if !review {
        return Ok(task);
    }
    let cleanup = function(context, "", 0, 0, |c, _| {
        call(
            c.get(c"state")?.get(c"reviews")?,
            c"delete",
            &[c.get(c"id")?],
        )
    })?;
    let task = call(task, c"finally", &[cleanup])?;
    call(reviews, c"set", &[id, task])?;
    Ok(task)
}
fn track<'a>(state: L<'a>, id: L<'a>, promise: L<'a>) -> Result<L<'a>> {
    let ctx = fields(state, &[("id", id), ("state", state)])?;
    let failed = function(ctx, "", 1, 1, |c, a| failure(c, a[0], Job::Pending))?;
    let cleanup = function(ctx, "", 0, 0, |c, _| {
        let pending = c.get(c"state")?.get(c"pending")?;
        let id = c.get(c"id")?;
        if call(pending, c"get", &[id])?.equals(c.get(c"tracked")?)? {
            call(pending, c"delete", &[id])?;
        }
        c.from_value(&V::Undefined)
    })?;
    let tracked = call(
        call(resolve(promise)?, c"catch", &[failed])?,
        c"finally",
        &[cleanup],
    )?;
    ctx.set(c"tracked", tracked)?;
    call(state.get(c"pending")?, c"set", &[id, tracked])?;
    Ok(tracked)
}
#[derive(Copy, Clone)]
enum Job {
    Distill,
    Pending,
    Review,
}
fn failure<'a>(c: L<'a>, err: L<'a>, job: Job) -> Result<L<'a>> {
    let state = c.get(c"state")?;
    let id = c.get(c"id")?;
    if matches!(job, Job::Review) {
        let r = record(state, id)?;
        if r.truthy()? {
            r.set(
                c"memoryReviewTurnCount",
                num(c, (state.get(c"interval")?.number()? - 1.).max(0.))?,
            )?;
            save(state, "runtime.memory-review-retry")?;
        }
    }
    let (label, what) = match job {
        Job::Review => ("periodic review", "memory review"),
        Job::Pending => ("pending distill", "pending distill"),
        Job::Distill => ("distill", "distill"),
    };
    let msg = err.get(c"message")?;
    let mut log = JsString::from(format!("[multicc/memory] {label} "));
    log.push(&id.coerce_string()?);
    log.push_str(" failed: ");
    log.push(&msg.coerce_string()?);
    call(state.get(c"logger")?, c"warn", &[from_js(c, log)?])?;
    let policy = state.get(c"recordApiError")?;
    if policy.kind()? == sys::ValueType::napi_function {
        c.catch(|| {
            let source = text(c, "aux_http")?;
            let provider = text(c, "aux")?;
            let message = fallback(err.optional(c"message")?, V::from(format!("{what} failed")))?;
            let raw = fields(
                c,
                &[
                    ("source", source),
                    ("provider", provider),
                    ("message", string(message)?),
                ],
            )?;
            let ctx = fields(
                c,
                &[
                    ("source", source),
                    ("provider", provider),
                    ("sessionId", id),
                ],
            )?;
            policy.call_plain(&[raw, ctx])
        })?;
    }
    fields(
        c,
        &[
            ("updated", flag(c, false)?),
            ("error", err.get(c"message")?),
        ],
    )
}
fn complete<'a>(ctx: L<'a>, result: L<'a>, review: bool) -> Result<L<'a>> {
    let state = ctx.get(c"state")?;
    let id = ctx.get(c"id")?;
    let deps = state.get(c"deps")?;
    let options = fields(
        state,
        &[
            ("scanContent", deps.get(c"scanContent")?),
            ("now", state.get(c"now")?),
        ],
    )?;
    let fresh = parse(
        if result.truthy()? {
            result.get(c"text")?
        } else {
            result
        },
        options,
    )?;
    let current = record(state, id)?;
    let out = if count(fresh)? == 0 || !current.truthy()? {
        fields(
            state,
            &[
                ("updated", flag(state, false)?),
                ("entries", get_entries(current)?),
            ],
        )?
    } else {
        let merged = trim(
            merge(get_entries(current)?, fresh)?,
            state.get(c"maxLength")?,
        )?;
        current.set(c"memory", merged)?;
        call(deps, c"writeAutoFile", &[current, merged])?;
        save(state, "runtime.memory-distill")?;
        let n = count(merged)?;
        let total = total(merged)?;
        let detail = if review {
            "周期记忆复盘"
        } else {
            "已提炼会话记忆"
        };
        call(
            deps,
            c"appendEvent",
            &[
                current.get(c"dirId")?,
                text(state, "memory_updated")?,
                text(state, &format!("{detail}（{n} 条，{total} 字）"))?,
                id,
            ],
        )?;
        call(
            deps,
            c"workspaceBroadcast",
            &[
                current.get(c"dirId")?,
                fields(
                    state,
                    &[("type", text(state, "memory")?), ("sessionId", id)],
                )?,
            ],
        )?;
        if !review {
            let mut log = JsString::from("[multicc/memory] distilled ");
            log.push(&id.coerce_string()?);
            log.push_str(&format!(": memory now {n} entries / {total} chars"));
            call(state.get(c"logger")?, c"log", &[from_js(state, log)?])?;
        }
        fields(
            state,
            &[
                ("updated", flag(state, true)?),
                ("entries", merged),
                ("totalLen", num(state, total)?),
            ],
        )?
    };
    if review {
        let current = record(state, id)?;
        let last = ctx.get(c"last")?;
        if current.truthy()? && last.truthy()? {
            current.set(c"memoryReviewCursorId", last)?;
            current.set(c"memoryReviewAt", state.get(c"now")?.call_plain(&[])?)?;
            save(state, "runtime.memory-review-cursor")?;
        }
    }
    Ok(out)
}

const DISTILL_HEADER: &str = r#"你是会话记忆提炼器。下面是一段即将被清理/丢弃的对话。请只提炼出「值得长期记住的关键信息」，每条一行，格式为 `[类型] 内容`。

类型必须是以下 5 种之一：
- [decision] 确认过的技术决策或方案选择
- [gotcha] 踩过的坑、错误做法与对应的正确做法
- [preference] 用户明确表达的偏好或约束
- [todo] 尚未完成、需后续跟进的事项
- [fact] 关键的技术事实或项目状态

忽略普通的任务过程、寒暄、可重新获得的中间步骤。每条内容精炼（不超过 100 字），动词或名词开头。若这段对话没有任何值得长期记住的，只输出一个减号 "-"。

"#;

const DISTILL_FOOTER: &str = r#"

请直接输出合并后的所有记忆条目（每行一条），不要解释、不要加标题。"#;

const REVIEW_HEADER: &str = r#"你是 MultiCC 的周期记忆复盘器。审查下面最近一段对话，只输出真正值得跨后续对话保留的稳定事实，每条一行，格式为 [类型] 内容。

允许类型：
- [preference] 用户明确且可复用的偏好、沟通方式、工作约束
- [gotcha] 反复可能踩到的环境或工具陷阱，以及正确做法
- [decision] 会长期影响后续工作的已确认方案或约定
- [fact] 稳定的项目/环境事实

不要保存任务进度、已完成工作日志、临时路径、一次性 TODO、普通过程或可轻易重新发现的知识。内容应是陈述性事实，不要写成命令。没有值得保存的内容时只输出 "-"。

【最近对话】
"#;

const REVIEW_FOOTER: &str = r#"

直接输出条目，不要标题或解释。"#;
