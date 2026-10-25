use multicc_cpr::{observer::Observer, plan};
use serde_json::{json, Value};

fn claude_input(body: &str) -> Value {
    let route = plan::route(
        &json!({"protocol":"claude","url":"/main/session/v1/messages?beta=1","body":body}),
    )
    .unwrap();
    json!({"route":route,"provider":{"settingsConfig":{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid/anthropic","ANTHROPIC_AUTH_TOKEN":"fixture"}}},"body":body,"method":"POST","headers":{}})
}

#[test]
fn unchanged_body_and_path_are_preserved() {
    let raw = "{ \"model\" : \"wire\", \"messages\" : [] }";
    let p = plan::prepare(claude_input(raw)).unwrap();
    assert_eq!(p["plan"]["body"], raw);
    assert_eq!(
        p["plan"]["url"],
        "https://example.invalid/anthropic/v1/messages?beta=1"
    );
}

#[test]
fn alias_and_context_suffix_are_resolved_on_the_routed_provider() {
    let mut input = claude_input(r#"{"model":"cpr:sub:opus","stream":true}"#);
    input["provider"]["settingsConfig"]["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"] =
        json!({"model":"wire[1M]"});
    let p = plan::prepare(input).unwrap();
    assert_eq!(p["plan"]["route"]["providerId"], "sub");
    assert_eq!(p["plan"]["route"]["model"], "wire");
    assert_eq!(p["plan"]["route"]["role"], "sub");
}

#[test]
fn private_credentials_and_connection_headers_are_not_forwarded() {
    let mut input = claude_input(r#"{"model":"wire"}"#);
    input["headers"] = json!({"connection":"x-private", "x-private":"fixture", "authorization":"virtual", "x-api-key":"virtual", "cookie":"private", "proxy-authorization":"private"});
    let p = plan::prepare(input).unwrap();
    let h = &p["plan"]["headers"];
    assert_eq!(h["authorization"], "Bearer fixture");
    for key in [
        "connection",
        "x-private",
        "x-api-key",
        "cookie",
        "proxy-authorization",
    ] {
        assert!(h.get(key).is_none());
    }
}

#[test]
fn unknown_provider_never_borrows_official_credentials() {
    let mut input = claude_input(r#"{"model":"wire"}"#);
    input["provider"] = Value::Null;
    input["officialViaProxy"] = true.into();
    assert!(plan::prepare(input).is_err());
}

#[test]
fn official_body_stays_byte_exact_and_beta_is_deduplicated() {
    let raw = r#"{ "model":"claude-test", "system":[{"text":"固定缓存前缀"}] }"#;
    let mut input = claude_input(raw);
    input["route"]["providerId"] = "claude-official".into();
    input["provider"] = json!({"settingsConfig":{"env":{}}});
    input["officialViaProxy"] = true.into();
    let need = plan::prepare(input.clone()).unwrap();
    assert!(need["credentialRequest"].is_object());
    input["officialToken"] = "test-oauth".into();
    input["headers"] = json!({"anthropic-beta":"oauth-2025-04-20"});
    let p = plan::prepare(input).unwrap();
    assert_eq!(p["plan"]["body"], raw);
    assert_eq!(p["plan"]["headers"]["anthropic-beta"], "oauth-2025-04-20");
}

#[test]
fn bad_upstream_protocols_are_rejected() {
    for url in [
        "file:///etc/passwd",
        "ftp://example.invalid",
        "https://user:password@example.invalid",
    ] {
        let mut input = claude_input(r#"{"model":"wire"}"#);
        input["provider"]["settingsConfig"]["env"]["ANTHROPIC_BASE_URL"] = url.into();
        assert!(plan::prepare(input).is_err());
    }
}

#[test]
fn invalid_roles_and_encoded_paths_are_rejected() {
    for path in [
        "/p/s/aux/responses",
        "/p/s/../responses",
        "/p/s/1bad/responses",
        "/p/s/%ff/responses",
    ] {
        assert!(plan::route(&json!({"protocol":"codex","url":path,"body":"{}"})).is_err());
    }
    let r = plan::route(&json!({"protocol":"codex","url":"/p/s/my_agent/responses","body":"{}"}))
        .unwrap();
    assert_eq!(r.agent_role, "custom");
    assert_eq!(r.route_name, "my_agent");
}

#[test]
fn every_utf8_split_and_multiline_sse_payload_is_equivalent() {
    let stream = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"中文🌏\"}\r\n\r\n";
    for split in 0..stream.len() {
        let mut o = Observer::new(false, true);
        o.feed(&stream.as_bytes()[..split]);
        o.feed(&stream.as_bytes()[split..]);
        o.finish();
        assert_eq!(o.events, vec![json!({"type":"text","text":"中文🌏"})]);
    }
}

#[test]
fn token_totals_are_not_double_counted_and_interleaved_tools_keep_identity() {
    let mut o = Observer::new(true, true);
    let events = vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}),
        json!({"type":"message_delta","usage":{"output_tokens":1}}),
        json!({"type":"message_delta","usage":{"output_tokens":5}}),
        json!({"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}),
        json!({"type":"message_delta","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"one","name":"read"}}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"two","name":"write"}}),
        json!({"type":"content_block_delta","index":1,"delta":{"partial_json":"中文"}}),
        json!({"type":"content_block_delta","index":2,"delta":{"partial_json":"参数"}}),
    ];
    for event in events {
        o.feed(format!("data: {event}\n\n").as_bytes());
    }
    o.finish();
    assert_eq!(
        o.usage,
        Some(json!({"inputTokens":10,"outputTokens":5,"cacheWrite":3,"cacheRead":4}))
    );
    assert_eq!(o.events[0]["toolId"], "one");
    assert_eq!(o.events[1]["toolId"], "two");
}

#[test]
fn oversized_observation_does_not_prevent_later_events() {
    let mut o = Observer::new(false, true);
    o.feed(&vec![b'a'; 2 * 1024 * 1024]);
    o.feed(b"\n\n");
    o.feed(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n");
    o.finish();
    assert_eq!(o.events[0]["text"], "ok");
}

#[test]
fn cached_responses_tokens_and_json_failure_are_observed() {
    let mut o = Observer::new(false, false);
    o.feed(br#"{"type":"response.failed","response":{"error":{"message":"system is busy"},"usage":{"input_tokens":12,"output_tokens":2,"input_tokens_details":{"cached_tokens":5}}}}"#);
    o.finish();
    assert!(o.failed);
    assert!(o.busy());
    assert_eq!(
        o.usage,
        Some(json!({"inputTokens":7,"outputTokens":2,"cacheRead":5,"cacheWrite":0}))
    );
}

#[test]
fn limit_headers_are_parsed_without_credentials() {
    let h = json!({"anthropic-ratelimit-unified-5h-utilization":"0.75","anthropic-ratelimit-unified-5h-status":"allowed_warning","anthropic-ratelimit-unified-5h-reset":"1900000000"});
    assert_eq!(
        plan::rate_limit(h.as_object().unwrap()).unwrap()["utilization"],
        0.75
    );
    assert!(plan::rate_limit(
        json!({"anthropic-ratelimit-unified-5h-utilization":"NaN"})
            .as_object()
            .unwrap()
    )
    .is_none());
}
