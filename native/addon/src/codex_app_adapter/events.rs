use super::*;

fn listed<'a>(key: L<'a>, entries: &[(&str, &str)], fallback: &str) -> Result<L<'a>> {
    // Object lookup preserves prototype properties, just like the original label table.
    let labels = object(key, &[])?;
    for (name, value) in entries {
        labels.define_key(text(key, name)?, text(key, value)?)?;
    }
    or(labels.get_key(key)?, || text(key, fallback))
}
fn optional_array<'a>(value: L<'a>, key: &std::ffi::CStr) -> Result<L<'a>> {
    if value.optional(key)?.is_array()? {
        value.get(key)
    } else {
        array(value)
    }
}
fn filtered_join<'a>(anchor: L<'a>, values: &[L<'a>], separator: &str) -> Result<L<'a>> {
    let kept = array(anchor)?;
    for value in values {
        if value.truthy()? {
            push(kept, &[*value])?;
        }
    }
    join(kept, separator)
}
// Array.map skips holes and snapshots length. Keep those observable semantics,
// including getters and reentrant decodes, without retaining an owner borrow.
fn map<'a>(values: L<'a>, mut visit: impl FnMut(L<'a>) -> Result<L<'a>>) -> Result<L<'a>> {
    let out = array(values)?;
    let length = values.get(c"length")?.number()? as u32;
    out.assign(c"length", values.from_value(&V::Number(length as f64))?)?;
    let reflect = values.global()?.get(c"Reflect")?;
    for index in 0..length {
        let key = values.from_value(&V::Number(index as f64))?;
        if reflect
            .get(c"has")?
            .call(reflect, &[values, key])?
            .truthy()?
        {
            out.set_element(index, visit(values.element(index)?)?)?;
        }
    }
    Ok(out)
}
pub(super) fn question(params: L<'_>) -> Result<L<'_>> {
    let questions = optional_array(params, c"questions")?;
    let first = questions.element(0)?;
    if !first.truthy()? {
        return params.from_value(&V::Null);
    }
    let prompt = filtered_join(
        params,
        &[first.get(c"header")?, first.get(c"question")?],
        "\n",
    )?;
    let options = array(params)?;
    let mapped = map(optional_array(first, c"options")?, |option| {
        if option.truthy()? {
            option.get(c"label")
        } else {
            Ok(option)
        }
    })?;
    mapped.for_each(|value| {
        if value.truthy()? {
            push(options, &[value])?;
        }
        Ok(())
    })?;
    let paragraphs = map(questions, |item| {
        let heading = if item.get(c"header")?.truthy()? {
            concat(
                params,
                &[
                    text(params, "**")?,
                    item.get(c"header")?,
                    text(params, "**\n")?,
                ],
            )?
        } else {
            text(params, "")?
        };
        let choices = map(optional_array(item, c"options")?, |option| {
            let label = option.get(c"label")?;
            let description = if option.get(c"description")?.truthy()? {
                concat(params, &[text(params, "：")?, option.get(c"description")?])?
            } else {
                text(params, "")?
            };
            concat(params, &[text(params, "  - ")?, label, description])
        })?;
        let choices = join(choices, "\n")?;
        let body = property(item, c"question", || text(params, ""))?;
        let choices = if choices.truthy()? {
            concat(params, &[text(params, "\n")?, choices])?
        } else {
            text(params, "")?
        };
        concat(params, &[heading, body, choices])
    })?;
    object(
        params,
        &[
            (c"type", text(params, "user_input_signal")?),
            (c"toolName", text(params, "request_user_input")?),
            (c"question", prompt),
            (c"options", options),
            (c"allowMultiple", boolean(params, false)?),
            (c"fallbackText", join(paragraphs, "\n\n")?),
            (
                c"log",
                text(
                    params,
                    "native requestUserInput decoded to user_input_signal",
                )?,
            ),
        ],
    )
}
fn label(ports: L<'_>) -> Result<L<'_>> {
    ports.get(c"displayName")
}
fn collab_result(item: L<'_>) -> Result<L<'_>> {
    let constructor = item.global()?.get(c"Object")?;
    let entries = constructor.get(c"entries")?.call(
        constructor,
        &[property(item, c"agentsStates", || object(item, &[]))?],
    )?;
    let lines = map(entries, |pair| {
        let id = pair.element(0)?;
        let state = pair.element(1)?;
        let status = listed(
            state.optional(c"status")?,
            &[
                ("pendingInit", "正在初始化"),
                ("running", "正在执行"),
                ("completed", "已完成"),
                ("errored", "执行失败"),
                ("interrupted", "已中断"),
                ("shutdown", "已关闭"),
                ("notFound", "未找到"),
            ],
            "状态未知",
        )?;
        let message = if state.optional(c"message")?.truthy()? {
            concat(item, &[text(item, "\n")?, state.get(c"message")?])?
        } else {
            text(item, "")?
        };
        concat(item, &[id, text(item, "：")?, status, message])
    })?;
    or(join(lines, "\n")?, || text(item, "Agent 工具调用结束"))
}
fn mcp_content(item: L<'_>) -> Result<L<'_>> {
    if item.get(c"result")?.optional(c"content")?.is_array()? {
        let blocks = array(item)?;
        // filter runs before map, so all type getters precede text getters.
        map(item.get(c"result")?.get(c"content")?, |block| {
            if block.optional(c"type")?.is_string("text")? {
                push(blocks, &[block])?;
            }
            Ok(block)
        })?;
        join(
            map(blocks, |block| property(block, c"text", || text(item, "")))?,
            "\n",
        )
    } else {
        or(item.get(c"error")?.optional(c"message")?, || text(item, ""))
    }
}
pub(super) fn decode<'a>(owner: &RustCodexAppAdapter, event: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let method = event.optional(c"method")?;
    let params = or(event.optional(c"params")?, || object(event, &[]))?;
    let storage = ports.get(c"storage")?;
    if !method.truthy()? {
        return array(event);
    }
    if method.is_string("item/tool/requestUserInput")? {
        let signal = question(params)?;
        return if signal.truthy()? {
            row(signal)
        } else {
            array(event)
        };
    }
    if !event.get(c"id")?.undefined()? && matches(method, "(?:requestApproval|Approval)$", "")? {
        return row(object(event, &[(c"type", text(event, "error")?), (c"label", label(ports)?), (c"kind", text(event, "provider")?),
            (c"message", text(event, "Codex v1 does not support interactive approvals; the request was cancelled.")?)])?);
    }
    if method.is_string("multicc/native_session_missing")? {
        return row(object(
            event,
            &[
                (c"type", text(event, "native_session_missing")?),
                (c"sessionId", params.get(c"threadId")?),
            ],
        )?);
    }
    if method.is_string("thread/started")? {
        let thread = property(params, c"thread", || object(event, &[]))?;
        return row(object(
            event,
            &[
                (c"type", text(event, "session_started")?),
                (
                    c"sessionId",
                    property(thread, c"id", || thread.get(c"sessionId"))?,
                ),
            ],
        )?);
    }
    if method.is_string("thread/status/changed")? {
        return row(object(
            event,
            &[
                (c"type", text(event, "status")?),
                (
                    c"status",
                    text(
                        event,
                        if params
                            .get(c"status")?
                            .optional(c"type")?
                            .is_string("idle")?
                        {
                            "thinking"
                        } else {
                            "running"
                        },
                    )?,
                ),
            ],
        )?);
    }
    if method.is_string("turn/started")? {
        if params.get(c"turn")?.optional(c"id")?.truthy()? {
            owner.put(
                ACTIVE,
                params.get(c"turn")?.get(c"id")?,
                boolean(event, true)?,
                storage,
            )?;
        }
        return array(event);
    }
    if method.is_string("item/agentMessage/delta")? {
        owner.put(
            DELTA,
            params.get(c"itemId")?,
            boolean(event, true)?,
            storage,
        )?;
        return row(object(
            event,
            &[
                (c"type", text(event, "assistant_text")?),
                (c"text", property(params, c"delta", || text(event, ""))?),
                (c"delta", boolean(event, true)?),
            ],
        )?);
    }
    if method.is_string("item/reasoning/textDelta")?
        || method.is_string("item/reasoning/summaryTextDelta")?
    {
        let current = concat(
            event,
            &[
                or(
                    owner.get(REASONING, params.get(c"itemId")?, storage)?,
                    || text(event, ""),
                )?,
                property(params, c"delta", || text(event, ""))?,
            ],
        )?;
        owner.put(REASONING, params.get(c"itemId")?, current, storage)?;
        return row(object(
            event,
            &[
                (c"type", text(event, "thinking")?),
                (c"id", params.get(c"itemId")?),
                (c"text", current),
                (c"snapshot", boolean(event, true)?),
                (c"delta", boolean(event, true)?),
            ],
        )?);
    }
    if method.is_string("item/started")? {
        let item = property(params, c"item", || object(event, &[]))?;
        let (id, name, input) = if item.get(c"type")?.is_string("collabAgentToolCall")? {
            (
                item.get(c"id")?,
                listed(
                    item.get(c"tool")?,
                    &[
                        ("spawnAgent", "Agent"),
                        ("wait", "Agent Wait"),
                        ("sendInput", "Agent Input"),
                        ("closeAgent", "Agent Close"),
                        ("followupTask", "Agent Followup"),
                        ("sendMessage", "Agent Message"),
                        ("resumeAgent", "Agent Resume"),
                        ("interruptAgent", "Agent Interrupt"),
                        ("listAgents", "Agent List"),
                    ],
                    "Agent",
                )?,
                object(
                    event,
                    &[
                        (
                            c"prompt",
                            property(item, c"prompt", || event.from_value(&V::Undefined))?,
                        ),
                        (
                            c"agentIds",
                            property(item, c"receiverThreadIds", || array(event))?,
                        ),
                    ],
                )?,
            )
        } else if item.get(c"type")?.is_string("commandExecution")? {
            (
                item.get(c"id")?,
                text(event, "Bash")?,
                object(
                    event,
                    &[
                        (c"command", item.get(c"command")?),
                        (c"cwd", item.get(c"cwd")?),
                    ],
                )?,
            )
        } else if item.get(c"type")?.is_string("mcpToolCall")? {
            (
                item.get(c"id")?,
                property(item, c"tool", || text(event, "MCP Tool"))?,
                property(item, c"arguments", || object(event, &[]))?,
            )
        } else {
            return array(event);
        };
        return row(object(
            event,
            &[
                (c"type", text(event, "tool_start")?),
                (c"id", id),
                (c"name", name),
                (c"input", input),
                (c"status", text(event, "running")?),
            ],
        )?);
    }
    if method.is_string("item/commandExecution/outputDelta")? {
        return row(object(
            event,
            &[
                (c"type", text(event, "tool_update")?),
                (c"id", params.get(c"itemId")?),
                (c"name", text(event, "Bash")?),
                (c"content", property(params, c"delta", || text(event, ""))?),
                (c"completed", boolean(event, false)?),
            ],
        )?);
    }
    if method.is_string("item/mcpToolCall/progress")? {
        return row(object(
            event,
            &[
                (c"type", text(event, "activity")?),
                (c"phase", text(event, "tool")?),
                (c"toolKind", text(event, "mcp")?),
                (
                    c"message",
                    property(params, c"message", || text(event, ""))?,
                ),
            ],
        )?);
    }
    if method.is_string("item/completed")? {
        let item = property(params, c"item", || object(event, &[]))?;
        if item.get(c"type")?.is_string("collabAgentToolCall")? {
            let content = collab_result(item)?;
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", item.get(c"id")?),
                    (c"content", content),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"status")?.is_string("failed")?
                                || item.get(c"status")?.is_string("interrupted")?,
                        )?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("agentMessage")? {
            return if owner.remove(DELTA, item.get(c"id")?, storage)? {
                array(event)
            } else {
                row(object(
                    event,
                    &[
                        (c"type", text(event, "assistant_text")?),
                        (c"text", property(item, c"text", || text(event, ""))?),
                    ],
                )?)
            };
        }
        if item.get(c"type")?.is_string("reasoning")? {
            let summary = if item.get(c"summary")?.is_array()? {
                join(item.get(c"summary")?, "\n")?
            } else {
                text(event, "")?
            };
            let content = or(summary, || {
                if item.get(c"content")?.is_array()? {
                    join(item.get(c"content")?, "\n")
                } else {
                    text(event, "")
                }
            })?;
            let content = or(content, || {
                or(owner.get(REASONING, item.get(c"id")?, storage)?, || {
                    text(event, "")
                })
            })?;
            owner.remove(REASONING, item.get(c"id")?, storage)?;
            return if content.truthy()? {
                row(object(
                    event,
                    &[
                        (c"type", text(event, "thinking")?),
                        (c"id", item.get(c"id")?),
                        (c"text", content),
                        (c"snapshot", boolean(event, true)?),
                        (c"completed", boolean(event, true)?),
                    ],
                )?)
            } else {
                array(event)
            };
        }
        if item.get(c"type")?.is_string("commandExecution")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", item.get(c"id")?),
                    (
                        c"content",
                        property(item, c"aggregatedOutput", || text(event, ""))?,
                    ),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"status")?.is_string("failed")?
                                || item.get(c"exitCode")?.explicit_number()? != 0.0,
                        )?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("mcpToolCall")? {
            let content = mcp_content(item)?;
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", item.get(c"id")?),
                    (c"content", content),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"status")?.is_string("failed")?
                                || item.get(c"error")?.truthy()?,
                        )?,
                    ),
                ],
            )?);
        }
        return array(event);
    }

    if method.is_string("thread/tokenUsage/updated")? {
        if params.get(c"turnId")?.truthy()?
            && owner
                .find(ACTIVE, params.get(c"turnId")?, storage)?
                .is_some()
        {
            // Map.set evaluates its key before the usage expression; preserve it across reentry.
            let key = params.get(c"turnId")?;
            let previous = owner.get(USAGE, params.get(c"turnId")?, storage)?;
            let next = app_usage(params.get(c"tokenUsage")?)?;
            let current = if previous.undefined()? {
                object(event, &[])?
            } else {
                previous
            };
            owner.put(USAGE, key, add_usage(current, next)?, storage)?;
        }
        return array(event);
    }
    if method.is_string("turn/completed")? {
        let turn = property(params, c"turn", || object(event, &[]))?;
        let usage = or(owner.get(USAGE, turn.get(c"id")?, storage)?, || {
            object(event, &[])
        })?;
        owner.remove(USAGE, turn.get(c"id")?, storage)?;
        owner.remove(ACTIVE, turn.get(c"id")?, storage)?;
        if !turn.get(c"status")?.is_string("completed")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "error")?),
                    (c"label", label(ports)?),
                    (
                        c"message",
                        or(turn.get(c"error")?.optional(c"message")?, || {
                            concat(event, &[text(event, "turn ")?, turn.get(c"status")?])
                        })?,
                    ),
                    (
                        c"kind",
                        text(
                            event,
                            if turn.get(c"status")?.is_string("interrupted")? {
                                "cancelled"
                            } else {
                                "provider"
                            },
                        )?,
                    ),
                ],
            )?);
        }
        return row(object(
            event,
            &[
                (c"type", text(event, "complete")?),
                (c"cost", event.from_value(&V::Null)?),
                (c"usage", usage),
            ],
        )?);
    }
    if method.is_string("error")? {
        let message = or(params.get(c"error")?.optional(c"message")?, || {
            property(params, c"message", || text(event, "app-server error"))
        })?;
        return if reconnect(message)? {
            row(object(
                event,
                &[
                    (c"type", text(event, "activity")?),
                    (c"phase", text(event, "recovering")?),
                    (c"message", message),
                ],
            )?)
        } else {
            row(object(
                event,
                &[
                    (c"type", text(event, "error")?),
                    (c"label", label(ports)?),
                    (c"message", message),
                    (c"kind", text(event, "provider")?),
                    (c"error", params.get(c"error")?),
                ],
            )?)
        };
    }
    if method.is_string("warning")?
        || method.is_string("configWarning")?
        || method.is_string("deprecationNotice")?
    {
        return row(object(
            event,
            &[
                (c"type", text(event, "activity")?),
                (c"phase", text(event, "warning")?),
                (
                    c"message",
                    property(params, c"message", || {
                        property(params, c"summary", || text(event, ""))
                    })?,
                ),
            ],
        )?);
    }
    array(event)
}
