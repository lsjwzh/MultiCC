use super::*;

fn arguments(raw: L<'_>) -> Result<L<'_>> {
    if raw.nullish()? || raw.is_string("")? {
        return object(raw, &[]);
    }
    if raw.kind()? == sys::ValueType::napi_object {
        return Ok(raw);
    }
    match raw.catch(|| parse(raw))? {
        Some(parsed) => {
            if parsed.truthy()? && parsed.kind()? == sys::ValueType::napi_object {
                Ok(parsed)
            } else {
                object(raw, &[(c"value", parsed)])
            }
        }
        None => object(raw, &[(c"arguments", string(raw)?)]),
    }
}
fn collab_name(tool: L<'_>) -> Result<L<'_>> {
    for (key, value) in [
        ("spawn_agent", "Agent"),
        ("wait", "Agent Wait"),
        ("send_input", "Agent Input"),
        ("close_agent", "Agent Close"),
    ] {
        if tool.is_string(key)? {
            return text(tool, value);
        }
    }
    concat(
        tool,
        &[text(tool, "Agent ")?, or(tool, || text(tool, "Task"))?],
    )
}
fn collab_input(item: L<'_>) -> Result<L<'_>> {
    let ids = if item.get(c"receiver_thread_ids")?.is_array()? {
        item.get(c"receiver_thread_ids")?
    } else {
        array(item)?
    };
    if item.get(c"tool")?.is_string("wait")? {
        object(
            item,
            &[(
                c"targets",
                if ids.get(c"length")?.truthy()? {
                    ids
                } else {
                    text(item, "任意活跃 Agent")?
                },
            )],
        )
    } else {
        object(
            item,
            &[
                (
                    c"prompt",
                    property(item, c"prompt", || item.from_value(&V::Undefined))?,
                ),
                (c"agentIds", ids),
            ],
        )
    }
}
fn collab_result(item: L<'_>) -> Result<L<'_>> {
    let states = property(item, c"agents_states", || object(item, &[]))?;
    let constructor = item.global()?.get(c"Object")?;
    let entries = constructor.get(c"entries")?.call(constructor, &[states])?;
    let lines = array(item)?;
    entries.for_each(|pair| {
        let id = pair.element(0)?;
        let state = pair.element(1)?;
        let status = if state.truthy()? && state.get(c"status")?.truthy()? {
            state.get(c"status")?
        } else {
            text(item, "unknown")?
        };
        let message = if state.truthy()? && state.get(c"message")?.truthy()? {
            concat(item, &[text(item, ": ")?, state.get(c"message")?])?
        } else {
            text(item, "")?
        };
        push(
            lines,
            &[concat(
                item,
                &[id, text(item, " [")?, status, text(item, "]")?, message],
            )?],
        )
    })?;
    or(join(lines, "\n")?, || {
        property(item, c"status", || text(item, ""))
    })
}
fn filtered_join<'a>(anchor: L<'a>, values: &[L<'a>], separator: &str) -> Result<L<'a>> {
    let out = array(anchor)?;
    for value in values {
        if value.truthy()? {
            push(out, &[*value])?;
        }
    }
    join(out, separator)
}
fn question(item: L<'_>) -> Result<L<'_>> {
    let built = item.catch(|| {
        let parsed = parse(property(item, c"arguments", || text(item, "{}"))?)?;
        let questions = if parsed.get(c"questions")?.is_array()? {
            parsed.get(c"questions")?
        } else {
            array(item)?
        };
        let first = or(questions.element(0)?, || Ok(parsed))?;
        let heading = property(first, c"header", || {
            property(first, c"title", || text(item, ""))
        })?;
        let body = property(first, c"question", || {
            property(first, c"text", || {
                property(parsed, c"question", || text(item, ""))
            })
        })?;
        let question = filtered_join(item, &[heading, body], "\n")?;
        let options = array(item)?;
        let raw_options = if first.get(c"options")?.is_array()? {
            first.get(c"options")?
        } else {
            array(item)?
        };
        raw_options.for_each(|option| {
            let value = if option.kind()? == sys::ValueType::napi_string {
                option
            } else {
                or(
                    if option.truthy()? {
                        property(option, c"label", || option.get(c"text"))?
                    } else {
                        option
                    },
                    || text(item, ""),
                )?
            };
            if value.truthy()? {
                push(options, &[value])?;
            }
            Ok(())
        })?;
        let paragraphs = array(item)?;
        questions.for_each(|q| {
            let heading = property(q, c"header", || property(q, c"title", || text(item, "")))?;
            let body = property(q, c"question", || property(q, c"text", || text(item, "")))?;
            let options = if q.get(c"options")?.is_array()? {
                let lines = array(item)?;
                q.get(c"options")?.for_each(|option| {
                    let label = if option.kind()? == sys::ValueType::napi_string {
                        option
                    } else {
                        property(option, c"label", || {
                            property(option, c"text", || text(item, ""))
                        })?
                    };
                    let description = if option.truthy()? && option.get(c"description")?.truthy()? {
                        concat(item, &[text(item, "：")?, option.get(c"description")?])?
                    } else {
                        text(item, "")?
                    };
                    push(
                        lines,
                        &[concat(item, &[text(item, "  - ")?, label, description])?],
                    )
                })?;
                join(lines, "\n")?
            } else {
                text(item, "")?
            };
            let heading = if heading.truthy()? {
                concat(item, &[text(item, "**")?, heading, text(item, "**\n")?])?
            } else {
                text(item, "")?
            };
            let options = if options.truthy()? {
                concat(item, &[text(item, "\n")?, options])?
            } else {
                text(item, "")?
            };
            push(paragraphs, &[concat(item, &[heading, body, options])?])
        })?;
        Ok((
            question,
            options,
            or(join(paragraphs, "\n\n")?, || Ok(question))?,
        ))
    })?;
    let (question, options, fallback) = match built {
        Some(value) => value,
        None => {
            let fallback = string(property(item, c"arguments", || text(item, ""))?)?;
            (fallback, array(item)?, fallback)
        }
    };
    if !question.truthy()? && !fallback.truthy()? {
        return array(item);
    }
    row(object(
        item,
        &[
            (c"type", text(item, "user_input_signal")?),
            (c"toolName", item.get(c"name")?),
            (c"question", question),
            (c"options", options),
            (c"allowMultiple", boolean(item, false)?),
            (
                c"fallbackText",
                concat(
                    item,
                    &[
                        text(item, "\n\n> [提问工具 ")?,
                        item.get(c"name")?,
                        text(item, " 在非交互环境不可用，已转为文本透传]\n")?,
                        fallback,
                        text(item, "\n")?,
                    ],
                )?,
            ),
            (
                c"log",
                concat(
                    item,
                    &[
                        text(item, "ask-tool ")?,
                        item.get(c"name")?,
                        text(item, " decoded to user_input_signal")?,
                    ],
                )?,
            ),
        ],
    )?)
}
fn select<'a>(
    values: &[(L<'a>, &CStr)],
    fallback: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    for (value, key) in values {
        let next = value.get(key)?;
        if next.truthy()? {
            return Ok(next);
        }
    }
    fallback()
}
fn predicate(ports: L<'_>, key: &CStr, message: L<'_>) -> Result<bool> {
    let callback = ports.get(key)?;
    if callback.undefined()? {
        Ok(false)
    } else {
        callback.call_plain(&[message])?.truthy()
    }
}
fn error<'a>(event: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let detail = if event.get(c"error")?.truthy()?
        && event.get(c"error")?.kind()? == sys::ValueType::napi_object
    {
        event.get(c"error")?
    } else {
        object(event, &[])?
    };
    let original = string(property(event, c"message", || {
        property(detail, c"message", || text(event, "未知错误"))
    })?)?;
    let upstream = port(ports, c"extractUpstreamError", &[original])?;
    let message = property(upstream, c"message", || Ok(original))?;
    let kind = if predicate(ports, c"isResponseCompletedDisconnect", original)?
        || predicate(ports, c"isResponseCompletedDisconnect", message)?
    {
        "response_completed_disconnect"
    } else if predicate(ports, c"isTransportDisconnect", original)?
        || predicate(ports, c"isTransportDisconnect", message)?
    {
        "transport_disconnect"
    } else {
        "provider"
    };
    if event.get(c"type")?.is_string("error")?
        && kind == "provider"
        && matches(
            string(or(message, || text(event, ""))?)?,
            "failed to refresh available models|failed to load skill",
            "i",
        )?
    {
        return array(event);
    }
    let code = select(
        &[
            (upstream, c"code"),
            (detail, c"code"),
            (event, c"code"),
            (upstream, c"type"),
            (detail, c"type"),
        ],
        || event.get(c"type"),
    )?;
    let status = select(
        &[
            (upstream, c"httpStatus"),
            (detail, c"http_status"),
            (detail, c"status_code"),
            (detail, c"status"),
            (event, c"http_status"),
            (event, c"status_code"),
            (event, c"status"),
        ],
        || {
            let regex = event.global()?.get(c"RegExp")?.construct(&[
                text(event, r"(?:status(?: code)?|HTTP)\s*:?\s*([45]\d\d)\b")?,
                text(event, "i")?,
            ])?;
            let found = regex.get(c"exec")?.call(regex, &[original])?;
            let capture = if found.nullish()? {
                event.from_value(&V::Undefined)?
            } else {
                found.element(1)?
            };
            let value = event.from_value(&V::Number(capture.explicit_number()?))?;
            or(value, || event.from_value(&V::Undefined))
        },
    )?;
    let headers = property(detail, c"headers", || event.get(c"headers"))?;
    let request = select(&[(upstream, c"requestId"), (detail, c"request_id")], || {
        event.get(c"request_id")
    })?;
    let data = object(
        event,
        &[
            (c"source", text(event, "codex_event")?),
            (c"provider", text(event, "codex")?),
            (c"code", code),
            (c"httpStatus", status),
            (c"headers", headers),
            (c"requestId", request),
        ],
    )?;
    if upstream.get(c"param")?.truthy()? {
        data.set(c"param", upstream.get(c"param")?)?;
    }
    data.set(c"message", message)?;
    row(object(
        event,
        &[
            (c"type", text(event, "error")?),
            (
                c"label",
                port(ports, c"displayNameOf", &[text(event, "codex")?])?,
            ),
            (c"message", message),
            (c"kind", text(event, kind)?),
            (c"error", data),
        ],
    )?)
}

pub(super) fn decode<'a>(event: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    if !event.truthy()? || event.kind()? != sys::ValueType::napi_object {
        return array(event);
    }
    if event.get(c"type")?.is_string("thread.started")? {
        return if event.get(c"thread_id")?.truthy()? {
            row(object(
                event,
                &[
                    (c"type", text(event, "session_started")?),
                    (c"sessionId", event.get(c"thread_id")?),
                ],
            )?)
        } else {
            array(event)
        };
    }
    if event.get(c"type")?.is_string("turn.started")? {
        return array(event);
    }
    if event.get(c"type")?.is_string("item.started")? {
        let item = property(event, c"item", || object(event, &[]))?;
        if item.get(c"type")?.is_string("mcp_tool_call")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_start")?),
                    (c"id", property(item, c"id", || item.get(c"call_id"))?),
                    (
                        c"name",
                        property(item, c"tool", || {
                            property(item, c"name", || text(event, "MCP Tool"))
                        })?,
                    ),
                    (c"input", arguments(item.get(c"arguments")?)?),
                    (c"status", text(event, "running")?),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("collab_tool_call")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_start")?),
                    (c"id", item.get(c"id")?),
                    (c"name", collab_name(item.get(c"tool")?)?),
                    (c"input", collab_input(item)?),
                    (c"status", text(event, "running")?),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("function_call")?
            || item.get(c"type")?.is_string("custom_tool_call")?
        {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_start")?),
                    (c"id", property(item, c"id", || item.get(c"call_id"))?),
                    (c"name", property(item, c"name", || item.get(c"type"))?),
                    (c"input", arguments(item.get(c"arguments")?)?),
                    (c"status", text(event, "running")?),
                ],
            )?);
        }
        if !item.get(c"type")?.is_string("command_execution")? {
            return array(event);
        }
        return row(object(
            event,
            &[
                (c"type", text(event, "tool_start")?),
                (c"id", item.get(c"id")?),
                (c"name", text(event, "Bash")?),
                (
                    c"input",
                    object(event, &[(c"command", item.get(c"command")?)])?,
                ),
                (c"status", text(event, "running")?),
            ],
        )?);
    }
    if event.get(c"type")?.is_string("item.completed")? {
        let item = property(event, c"item", || object(event, &[]))?;
        if item.get(c"type")?.is_string("mcp_tool_call")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", property(item, c"id", || item.get(c"call_id"))?),
                    (c"content", super::mcp_text(item)?),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"status")?.is_string("failed")?
                                || item.get(c"error")?.truthy()?
                                || item.get(c"result")?.optional(c"isError")?.is_true()?,
                        )?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("collab_tool_call")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", item.get(c"id")?),
                    (c"content", collab_result(item)?),
                    (
                        c"isError",
                        boolean(event, item.get(c"status")?.is_string("failed")?)?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("command_execution")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", item.get(c"id")?),
                    (
                        c"content",
                        property(item, c"aggregated_output", || text(event, ""))?,
                    ),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"exit_code")?.truthy()?
                                && !item.get(c"exit_code")?.is_number(0.0)?,
                        )?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("function_call")?
            && matches(
                property(item, c"name", || text(event, ""))?,
                "^(request_user_input|AskUserQuestion)$",
                "i",
            )?
        {
            return question(item);
        }
        if item.get(c"type")?.is_string("function_call")?
            || item.get(c"type")?.is_string("custom_tool_call")?
        {
            return row(object(
                event,
                &[
                    (c"type", text(event, "tool_result")?),
                    (c"id", property(item, c"id", || item.get(c"call_id"))?),
                    (
                        c"content",
                        property(item, c"output", || {
                            property(item, c"aggregated_output", || {
                                property(item, c"result", || text(event, ""))
                            })
                        })?,
                    ),
                    (
                        c"isError",
                        boolean(
                            event,
                            item.get(c"status")?.is_string("failed")?
                                || (item.get(c"exit_code")?.truthy()?
                                    && !item.get(c"exit_code")?.is_number(0.0)?),
                        )?,
                    ),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("agent_message")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "assistant_text")?),
                    (c"text", property(item, c"text", || text(event, ""))?),
                    (c"forwardSuffix", text(event, "\n\n")?),
                ],
            )?);
        }
        if item.get(c"type")?.is_string("reasoning")? {
            return row(object(
                event,
                &[
                    (c"type", text(event, "thinking")?),
                    (c"id", item.get(c"id")?),
                    (c"text", property(item, c"text", || text(event, ""))?),
                ],
            )?);
        }
        return array(event);
    }
    if event.get(c"type")?.is_string("turn.completed")? {
        return row(object(
            event,
            &[
                (c"type", text(event, "complete")?),
                (c"cost", event.from_value(&V::Null)?),
                (c"usage", super::usage(event.get(c"usage")?)?),
            ],
        )?);
    }
    if event.get(c"type")?.is_string("error")? || event.get(c"type")?.is_string("turn.failed")? {
        return error(event, ports);
    }
    array(event)
}
