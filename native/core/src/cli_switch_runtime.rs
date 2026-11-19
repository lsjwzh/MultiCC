//! Session-switch orchestration policy. The host supplies live process facts
//! and applies these plans to its existing session objects; no process handle
//! or complete session snapshot crosses this boundary.
use crate::cli_capability;
use crate::js::{coerce, js_trim, json_parse, JsValue};
use serde_json::{json, Map, Value};

fn value(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}
fn truth(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn yes(v: &Value, key: &str) -> bool {
    v.get(key) == Some(&Value::Bool(true))
}
fn js_value(v: Option<&Value>) -> JsValue {
    v.and_then(|v| json_parse(&v.to_string()).ok())
        .unwrap_or(JsValue::Undefined)
}
fn text(v: Option<&Value>) -> String {
    coerce::js_to_string(&js_value(v)).to_string_lossy()
}
fn fallback(v: &Value, key: &str, default: Value) -> Value {
    if truth(v.get(key)) {
        value(v, key)
    } else {
        default
    }
}
fn cli(v: &Value) -> String {
    text(Some(&fallback(v, "cli", json!("claude"))))
}
fn copy(out: &mut Map<String, Value>, source: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(v) = source.get(*key) {
            out.insert((*key).into(), v.clone());
        }
    }
}
fn family(cli: &str) -> &str {
    match cli {
        "claude-exp" => "claude",
        "codex-exp" => "codex",
        _ => cli,
    }
}
fn action(name: &str) -> Value {
    json!({ "action": name })
}
fn response(status: u16, body: Value) -> Value {
    json!({ "action": "respond", "status": status, "body": body })
}
fn busy(input: &Value) -> bool {
    yes(input, "observationFailed")
        || yes(input, "chatBusy")
        || truth(input.get("streamBusy"))
        || coerce::js_to_number(&js_value(input.get("streamQueued"))) > 0.0
        || yes(input, "background")
        || matches!(
            input.get("phase").and_then(Value::as_str),
            Some("preparing" | "running")
        )
}
fn current_allowed(input: &Value) -> bool {
    !yes(input, "reservation") && !yes(input, "reservationFailed")
}
fn session_view(input: &Value, out: &mut Map<String, Value>) {
    let session = &input["session"];
    for key in ["provider", "providerSelection", "model", "effort", "agent"] {
        out.insert(key.into(), fallback(session, key, Value::Null));
    }
    copy(
        out,
        input,
        &[
            "providerName",
            "providerBaseUrl",
            "effectiveModel",
            "effectiveEffort",
            "subagent",
        ],
    );
}

pub fn plan(op: &str, input: &Value) -> Result<Value, String> {
    Ok(match op {
        "handoffSummary" => {
            let handoff = &input["handoff"];
            if !truth(Some(handoff)) {
                Value::Null
            } else {
                let mut out = Map::new();
                copy(
                    &mut out,
                    handoff,
                    &["id", "fromCli", "toCli", "status", "createdAt"],
                );
                out.insert("reason".into(), fallback(handoff, "reason", Value::Null));
                out.insert(
                    "reusedTarget".into(),
                    json!(truth(handoff.get("reusedTarget"))),
                );
                Value::Object(out)
            }
        }
        "defaults" => {
            let lane = text(input.get("cli"));
            json!({ "needsCodexEffort": family(&lane) == "codex", "fields": {
                "provider": fallback(&input["providerDefaults"], family(&lane), Value::Null),
                "model": null, "effort": null, "subagent": null, "agent": null } })
        }
        "subagentCandidate" => {
            let sub = &input["subagent"];
            if !yes(input, "bindings")
                || yes(input, "ephemeral")
                || truth(input.get("loginFlow"))
                || (truth(Some(sub)) && !yes(sub, "inherited"))
            {
                action("keep")
            } else if input.get("providerDefaults").is_none() {
                action("defaults")
            } else {
                let lane = cli(input);
                let family = family(&lane);
                let route = &input["providerDefaults"]["subagent"][family];
                let empty = route.as_object().is_some_and(|v| v.is_empty())
                    || route.as_array().is_some_and(|v| v.is_empty());
                if !matches!(family, "claude" | "codex")
                    || !truth(Some(route))
                    || empty
                    || !(route.is_object() || route.is_array())
                {
                    json!({ "action": "set", "value": null })
                } else {
                    json!({ "action": "validate", "family": family,
                        "providerId": js_trim(&text(Some(&fallback(route, "providerId", json!(""))))),
                        "model": fallback(route, "model", json!("")), "mainProvider": input["provider"], "needsProxy": family == "codex" })
                }
            }
        }
        "subagentResult" => {
            let candidate = &input["candidate"];
            let model = js_trim(&text(candidate.get("model"))).to_string();
            if !truth(input["checked"].get("ok"))
                || model.is_empty()
                || yes(candidate, "needsProxy") && !truth(candidate.get("mainProvider"))
            {
                json!({ "action": "set", "value": null })
            } else if yes(candidate, "needsProxy") && input.get("proxyable").is_none() {
                action("proxy")
            } else {
                json!({ "action": "set", "value": if yes(candidate, "needsProxy") && !truth(input.get("proxyable")) { Value::Null }
                else { json!({ "providerId": input["checked"]["value"], "model": model, "inherited": true }) } })
            }
        }
        "busy" => json!(busy(input)),
        "resetPlan" => {
            json!({ "refreshCwd": input["workspaceState"] == "awake" && truth(input.get("worktreePath")),
            "fields": { "cli": input["cli"], "chatTurnCount": if truth(input.get("cliSessionId")) || truth(input.get("streamSessionId")) { 1 } else { 0 },
                "lineBuf": "", "currentAssistantText": "", "currentToolCalls": [], "currentCost": null,
                "isStreaming": false, "streamReplay": [], "_adapterError": null, "_activeRunner": null,
                "_activeTurn": null, "_continuationLineage": null, "_resultSaved": false, "_sawApiError": false } })
        }
        "prepareRoute" => {
            json!({ "cli": input["targetCli"], "logicalSessionId": input["sessionId"], "fresh": yes(input, "fresh"),
            "nativeSessionId": fallback(&input["target"], "cliSessionId", Value::Null),
            "fromProviderId": fallback(&input["target"], "provider", Value::Null),
            "toProviderId": if yes(input, "providerSupplied") { value(input, "provider") } else { fallback(&input["target"], "provider", Value::Null) } })
        }
        "handoff" => {
            json!({ "id": input["id"], "fromCli": input["fromCli"], "toCli": input["targetCli"],
            "createdAt": input["checkpoint"]["createdAt"], "status": "pending", "reusedTarget": input["reused"], "checkpoint": input["checkpoint"] })
        }
        "switchNotice" | "switchEvent" => {
            let from = text(input.get("fromCli"));
            let to = text(input.get("targetCli"));
            let mut chat = Map::new();
            chat.extend(json!({ "type": "cli_switched", "cli": to, "fromCli": from,
                "handoffId": input["handoffId"], "reusedTarget": input["reused"], "fresh": yes(input, "fresh") }).as_object().unwrap().clone());
            session_view(input, &mut chat);
            chat.remove("agent");
            // 继承的子 agent 路由在切换时被改（清掉或换成目标家族默认）时透传给
            // 前端：只认 {from,to} 对象，其余形状（null/缺失）= 没变化。
            let change = input.get("subagentChange").filter(|v| v.is_object());
            if let Some(change) = change {
                chat.insert("subagentChange".into(), change.clone());
            }
            if op == "switchEvent" {
                return Ok(Value::Object(chat));
            }
            let mut content = format!("CLI switched from {from} to {to}. A structured handoff checkpoint will be delivered with the next message.");
            if let Some(change) = change {
                let from_route = change.get("from").filter(|v| v.is_object());
                let to_route = change.get("to").filter(|v| v.is_object());
                match (from_route, to_route) {
                    (Some(_), None) => content.push_str(
                        " The inherited sub-agent route was dropped: the new lane's family has no sub-agent default, so sub-agents now follow the main line."),
                    (_, Some(route)) => {
                        // js_to_string 把缺省 name 变成 "undefined"：只有真实名字才用，否则回退 providerId。
                        let raw_name = route.get("name").and_then(Value::as_str).unwrap_or("");
                        let label = if raw_name.trim().is_empty() { text(route.get("providerId")) } else { raw_name.trim().to_string() };
                        let model = text(route.get("model"));
                        if from_route.is_some() {
                            content.push_str(&format!(
                                " The inherited sub-agent route was replaced with the new lane's family default ({label}, model {model})."));
                        } else {
                            content.push_str(&format!(
                                " Sub-agents now use the new lane's family default route ({label}, model {model})."));
                        }
                    }
                    (None, None) => {}
                }
            }
            json!({ "message": { "role": "system", "content": content,
                "ts": input["now"], "cliSwitch": { "handoffId": input["handoffId"], "fromCli": from, "toCli": to, "reusedTarget": input["reused"] } },
                "eventText": format!("{}: {from} → {to}", text(Some(&fallback(&input["session"], "label", value(&input["session"], "id"))))),
                "chat": chat, "workspace": { "type": "session_cli_changed", "sessionId": input["session"]["id"], "cli": to },
                "forced": if yes(input, "forced") { json!({ "type": "stream_end", "reason": "cli_switch" }) } else { Value::Null } })
        }
        "consume" => {
            let h = &input["handoff"];
            if h["status"] != "pending" {
                Value::Null
            } else {
                let mut last = Map::new();
                copy(&mut last, h, &["id", "fromCli", "toCli", "createdAt"]);
                last.insert("consumedAt".into(), value(input, "nowIso"));
                let from = text(h.get("fromCli"));
                let to = text(h.get("toCli"));
                let retained = matches!(
                    h.get("reason").and_then(Value::as_str),
                    Some(
                        "history_clear_keep"
                            | "manual_native_context_rotate"
                            | "auto_native_context_rotate"
                    )
                );
                let mut event = Map::new();
                event.insert("type".into(), json!("system"));
                event.insert("subtype".into(), json!("cli_handoff_applied"));
                copy(&mut event, h, &["fromCli", "toCli", "reason"]);
                event.insert(
                    "message".into(),
                    json!(if retained {
                        format!("✓ 保留的上下文 checkpoint 已由 {to} 的新原生会话接收")
                    } else {
                        format!("✓ {from} → {to} 的上下文交接已由目标 CLI 接收")
                    }),
                );
                json!({ "last": last, "event": event })
            }
        }
        "stagePlan" => {
            let pending = &input["pending"];
            if truth(Some(pending))
                && pending["cli"] == input["targetCli"]
                && pending["fresh"] == input["fresh"]
            {
                action("desired")
            } else if cli(input) != text(input.get("targetCli")) || yes(input, "fresh") {
                action("activate")
            } else {
                action("keep")
            }
        }
        "stageConfiguration" => {
            let mut profile = Map::new();
            for key in [
                "provider",
                "providerSelection",
                "model",
                "effort",
                "agent",
                "subagent",
                "rolePrompt",
            ] {
                profile.insert(key.into(), value(&input["draft"], key));
            }
            json!({ "cli": cli(&input["draft"]), "fresh": yes(input, "fresh"), "profile": profile, "updatedAt": input["nowIso"] })
        }
        "currentAllowed" => json!(current_allowed(input)),
        "autoGate" => {
            let pool = &input["pool"];
            if pool["mode"] != "auto" {
                action("clear")
            } else if !truth(pool.get("cliSwitch")) {
                if input.get("reservation").is_none() && !yes(input, "reservationFailed") {
                    action("observeReservation")
                } else {
                    action(if yes(input, "reservation") {
                        "clear"
                    } else {
                        "skip"
                    })
                }
            } else if !yes(input, "planner") {
                action("skip")
            } else if input.get("busy").is_none() {
                action("observeBusy")
            } else if yes(input, "busy") || yes(input, "reservationFailed") {
                action("skip")
            } else if yes(input, "pending") {
                if input.get("reservation").is_none() {
                    action("observeReservation")
                } else {
                    action(if yes(input, "reservation") {
                        "plan"
                    } else {
                        "allow"
                    })
                }
            } else {
                action("plan")
            }
        }
        "autoPlanGate" => {
            json!({ "prepare": truth(input["plan"].get("cli")) && input["plan"]["cli"] != input["cli"] && yes(input, "available") })
        }
        "preparedGate" => json!(!yes(input, "changed") && !yes(input, "busy")),
        "autoCommit" => {
            let p = &input["plan"];
            let model = if truth(p.get("model")) {
                format!(" · {}", text(p.get("model")))
            } else {
                String::new()
            };
            json!({ "restorePool": true, "fields": { "provider": if yes(input, "nativeVendor") { Value::Null } else { value(p, "providerId") }, "model": null },
                "reason": "auto_provider_cli_switch", "event": { "type": "system", "subtype": "warning",
                    "message": format!("Auto Provider：{} → {}（{}{model}）。", text(input.get("fromCli")), text(p.get("cli")), text(Some(&fallback(p, "providerName", value(p, "providerId"))))) } })
        }
        "pendingGate" => {
            let opts = &input["options"];
            let background = truth(opts.get("bgTaskIds"))
                && opts["bgTaskIds"].as_array().is_some_and(|a| !a.is_empty())
                || truth(opts.get("bgToolUseIds"))
                    && opts["bgToolUseIds"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty());
            if !yes(input, "pending")
                || truth(opts.get("originContinue")) && !truth(opts.get("directUserInput"))
                || background
            {
                action("allow")
            } else if !yes(input, "observed") {
                action("observe")
            } else if yes(input, "busy") {
                action(
                    if truth(opts.get("originContinue"))
                        && truth(opts.get("directUserInput"))
                        && yes(input, "chatBusy")
                    {
                        "allow"
                    } else {
                        "deny"
                    },
                )
            } else if input.get("available").is_none() {
                action("observeAvailability")
            } else if !yes(input, "available") {
                action("deny")
            } else {
                action("prepare")
            }
        }
        "pendingCommit" => {
            json!({ "switch": input["pending"]["cli"] != input["cli"] || truth(input["pending"].get("fresh")) || input["nativeSessionExists"] == false,
            "closeStream": input["cli"] == "claude",
            "event": { "type": "session_configuration_applied", "sessionId": input["sessionId"] } })
        }
        "configurationChanged" => json!(input["before"] != input["after"]),
        "manualGate" => {
            let session = &input["session"];
            if !yes(input, "exists") {
                response(404, json!({ "error": "session not found" }))
            } else if matches!(
                session.get("type").and_then(Value::as_str),
                Some("aux" | "gateway")
            ) {
                response(
                    400,
                    json!({ "error": "system session must be switched by its bridge controller" }),
                )
            } else if session["kind"] != "chat" {
                response(400, json!({ "error": "only chat sessions can switch CLI" }))
            } else {
                let requested = js_trim(&text(Some(&fallback(&input["body"], "cli", json!("")))))
                    .to_lowercase();
                let supported = input["supported"].as_array().cloned().unwrap_or_default();
                if !supported.iter().any(|v| v == &requested) {
                    response(
                        400,
                        json!({ "error": format!("cli must be one of: {}", supported.iter().map(|v| text(Some(v))).collect::<Vec<_>>().join(", ")) }),
                    )
                } else {
                    let target = cli_capability::name_of(&requested);
                    let fresh = truth(input["body"].get("fresh"));
                    json!({ "action": if cli(session) == target && !fresh && !truth(session.get("pendingConfiguration")) { "noop" } else { "switch" }, "targetCli": target, "fresh": fresh })
                }
            }
        }
        "manualReady" => {
            if !yes(input, "available") {
                response(
                    400,
                    json!({ "error": format!("{} CLI is not installed or not executable", text(input.get("targetCli"))) }),
                )
            } else if yes(input, "pending") || yes(input, "preparing") || yes(input, "busy") {
                action("queue")
            } else if input.get("busy").is_none() {
                action("observeBusy")
            } else {
                action("prepare")
            }
        }
        "manualConflict" => response(
            409,
            json!({ "error": "Session changed during CLI switch preparation; retry the switch.", "code": "cli_switch_changed" }),
        ),
        "response" => {
            let mut out = Map::new();
            out.insert("ok".into(), json!(true));
            let mode = input["mode"].as_str().unwrap_or_default();
            out.insert("changed".into(), json!(mode == "switched"));
            out.insert("cli".into(), json!(cli(&input["session"])));
            copy(&mut out, input, &["cliStates", "cliAvailability"]);
            if mode == "noop" {
                out.insert(
                    "pendingCliHandoff".into(),
                    value(input, "pendingCliHandoff"),
                );
            } else {
                session_view(input, &mut out);
                if mode == "staged" {
                    out.insert("deferred".into(), json!(true));
                    out.insert("appliesOn".into(), json!("next_turn"));
                    out.insert(
                        "pendingConfiguration".into(),
                        value(&input["session"], "pendingConfiguration"),
                    );
                } else {
                    copy(
                        &mut out,
                        input,
                        &["fromCli", "handoffId", "reusedTarget", "fresh"],
                    );
                    out.insert("forced".into(), json!(false));
                }
            }
            Value::Object(out)
        }
        _ => return Err(format!("unknown cli switch runtime operation: {op}")),
    })
}

pub fn request(op: &str, input: &str) -> Result<String, String> {
    let input = crate::json_lenient::from_str(input)
        .map_err(|e| format!("cli_switch_runtime_invalid_input: {e}"))?;
    serde_json::to_string(&plan(op, &input)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_noop_precedes_availability_and_aliases_are_canonical() {
        let input = json!({ "exists": true, "session": { "kind": "chat", "cli": "claude" }, "body": { "cli": " CLAUDE-EXP " }, "supported": ["claude", "claude-exp"] });
        let p = plan("manualGate", &input).unwrap();
        assert_eq!(p["action"], "noop");
        assert_eq!(p["targetCli"], "claude");
    }
    #[test]
    fn continuation_preserves_manual_configuration_and_finishes_auto_reservation() {
        assert_eq!(
            plan(
                "pendingGate",
                &json!({ "pending": true, "options": { "originContinue": true }, "busy": true })
            )
            .unwrap()["action"],
            "allow"
        );
        assert_eq!(plan("autoGate", &json!({ "pool": { "mode": "auto", "cliSwitch": "failover" }, "pending": true, "reservation": true, "planner": true, "busy": false })).unwrap()["action"], "plan");
        assert_eq!(
            plan("currentAllowed", &json!({ "reservation": true })).unwrap(),
            false
        );
    }
    #[test]
    fn explicit_null_provider_and_missing_reason_keep_their_boundary_semantics() {
        let p = plan("prepareRoute", &json!({ "target": { "provider": "remembered" }, "providerSupplied": true, "provider": null })).unwrap();
        assert!(p["toProviderId"].is_null());
        let p = plan("consume", &json!({ "handoff": { "status": "pending", "fromCli": "claude", "toCli": "codex" }, "nowIso": "now" })).unwrap();
        assert!(p["event"].get("reason").is_none());
    }
    #[test]
    fn switch_notice_surfaces_subagent_route_change() {
        let base = json!({ "fromCli": "claude", "targetCli": "codex", "handoffId": "h1",
            "reused": false, "session": { "id": "s1", "label": "demo" }, "now": 0 });
        // 无变化：chat 不带字段，文案保持原样
        let notice = plan("switchNotice", &base).unwrap();
        assert!(notice["chat"].get("subagentChange").is_none());
        assert_eq!(notice["message"]["content"],
            "CLI switched from claude to codex. A structured handoff checkpoint will be delivered with the next message.");
        // 继承路由被清：说明改走主线路
        let mut cleared = base.clone();
        cleared["subagentChange"] = json!({ "family": "codex",
            "from": { "providerId": "p1", "model": "opus", "name": "DeepSeek Flash" }, "to": null });
        let notice = plan("switchNotice", &cleared).unwrap();
        assert!(notice["message"]["content"]
            .as_str()
            .unwrap()
            .contains("inherited sub-agent route was dropped"));
        assert_eq!(notice["chat"]["subagentChange"]["from"]["providerId"], "p1");
        // 换成目标家族默认：带名字与模型
        let mut replaced = base.clone();
        replaced["subagentChange"] = json!({ "family": "codex",
            "from": { "providerId": "p1", "model": "opus" },
            "to": { "providerId": "p2", "model": "deepseek-v4-flash", "name": "DeepSeek" } });
        let notice = plan("switchNotice", &replaced).unwrap();
        assert!(notice["message"]["content"].as_str().unwrap().contains(
            "replaced with the new lane's family default (DeepSeek, model deepseek-v4-flash)"
        ));
        // 从无到有（原随主，目标家族有默认）
        let mut applied = base.clone();
        applied["subagentChange"] = json!({ "family": "codex", "from": null,
            "to": { "providerId": "p2", "model": "m2" } });
        let notice = plan("switchNotice", &applied).unwrap();
        assert!(notice["message"]["content"]
            .as_str()
            .unwrap()
            .contains("Sub-agents now use the new lane's family default route (p2, model m2)"));
        // switchEvent 透传同一字段
        let event = plan("switchEvent", &replaced).unwrap();
        assert_eq!(event["subagentChange"]["to"]["providerId"], "p2");
        // 畸形（非对象）输入视为无变化
        let mut malformed = base.clone();
        malformed["subagentChange"] = json!("cleared");
        let notice = plan("switchNotice", &malformed).unwrap();
        assert!(notice["chat"].get("subagentChange").is_none());
    }
}
