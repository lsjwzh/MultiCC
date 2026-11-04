use super::*;

fn event(value: Value) -> Option<Diagnosis> {
    diagnose("opencode", Origin::Event, &value)
}

#[test]
fn structured_type_is_independent_of_prose_and_keeps_evidence_path() {
    for message in [
        "Internal error",
        "本地化后的错误",
        "",
        "HTTP 401 Unauthorized",
    ] {
        let d = event(json!({"code":-32603,"message":message,
            "data":{"errorName":"ContextOverflowError"}}))
        .unwrap();
        assert_eq!(d.category, Category::ContextTokenLimit);
        assert_eq!(d.reason, Reason::ContextOverflow);
        assert_eq!(d.evidence.path, "$.data.errorName");
        assert!(!d.recovery.retry_same_request);
        assert!(d.should_rotate_context());
    }
}

#[test]
fn transport_code_alone_has_no_domain_meaning() {
    assert!(event(json!({"code":-32603,"message":"Internal error"})).is_none());
    assert!(event(json!({"status":500})).is_none());
}

#[test]
fn structured_auth_cancel_and_unknown_types_cannot_be_overwritten_by_prose() {
    for (fields, expected) in [
        (
            json!({"code":"unauthorized"}),
            Category::AuthenticationPermission,
        ),
        (
            json!({"data":{"errorName":"ProviderAuthError"}}),
            Category::AuthenticationPermission,
        ),
        (json!({"code":"user_cancel"}), Category::CancelShutdown),
        (
            json!({"name":"MessageAbortedError"}),
            Category::CancelShutdown,
        ),
        (json!({"category":"tool_protocol"}), Category::ToolProtocol),
        (json!({"name":"FutureProviderError"}), Category::Unknown),
        (
            json!({"statusCode":401}),
            Category::AuthenticationPermission,
        ),
        (json!({"statusCode":429}), Category::RateLimit),
    ] {
        let mut value = fields;
        value["message"] = json!("Conversation history too large to compact");
        let d = event(value).unwrap();
        assert_eq!(d.category, expected);
        assert!(!d.should_rotate_context());
    }
}

#[test]
fn outer_authoritative_type_wins_and_cancellation_wins_over_nested_causes() {
    for code in ["unauthorized", "user_cancel"] {
        let d = event(json!({"code":code, "rpcError":{"code":-32603,
            "data":{"errorName":"ContextOverflowError"}}}))
        .unwrap();
        assert_ne!(d.category, Category::ContextTokenLimit);
    }
}

#[test]
fn protocol_envelopes_share_recovery_but_preserve_the_cause_location() {
    for (value, path) in [
        (
            json!({"name":"ContextOverflowError","data":{"message":"localized"}}),
            "$.name",
        ),
        (
            json!({"rpcError":{"code":-32603,"data":{"errorName":"ContextOverflowError"}}}),
            "$.rpcError.data.errorName",
        ),
        (
            json!({"message": r#"{"error":{"code":"context_length_exceeded"}}"#}),
            "$.message.error.code",
        ),
        (
            json!({"response":{"error":{"code":"context_window_exceeded"}}}),
            "$.response.error.code",
        ),
    ] {
        let d = event(value).unwrap();
        assert_eq!(d.evidence.path, path);
        assert!(d.should_rotate_context());
    }
}

#[test]
fn output_limit_and_generic_context_category_do_not_authorize_history_rotation() {
    for value in [
        json!({"code":"max_tokens_exceeded"}),
        json!({"category":"context_token_limit"}),
    ] {
        let d = event(value).unwrap();
        assert!(!d.should_rotate_context());
        assert!(!d.recovery.retry_same_request);
    }
}

#[test]
fn legacy_wording_only_allows_review_while_verified_budget_can_rotate() {
    let d = event(json!({"message":"Internal error: Conversation history too large to compact - exceeds model context limit"})).unwrap();
    assert_eq!(d.evidence.kind, EvidenceKind::LegacyMessage);
    assert_eq!(d.recovery.context, ContextAction::Review);
    for (input, expected) in [(900, false), (1000, false), (1001, true)] {
        let d = event(json!({"name":"UnknownError","data":{"message":format!(
            "This model's maximum context length is 1100 tokens. However, you requested 100 output tokens and your prompt contains at least {input} input tokens."
        )}}));
        assert_eq!(d.is_some_and(|d| d.should_rotate_context()), expected);
    }
}

#[test]
fn request_echoes_and_logs_are_not_domain_evidence() {
    for value in [
        json!({"prompt":{"name":"ContextOverflowError"}}),
        json!({"data":{"details":{"code":"context_length_exceeded"}}}),
        json!({"message":"用户说 prompt too long"}),
        json!({"message":"prompt: [{message: 'Conversation history too large to compact'}]"}),
    ] {
        assert!(event(value).is_none());
    }
    let logs = json!({"message":"prompt: [{message: 'context window exceeded'}]\nstack frame"});
    assert!(diagnose("opencode", Origin::Stderr, &logs).is_none());
}

#[test]
fn stderr_only_accepts_standalone_error_records() {
    let logs = json!({"message":"Error: Conversation history too large to compact\nstack frame"});
    let d = diagnose("opencode", Origin::Stderr, &logs).unwrap();
    assert_eq!(d.recovery.context, ContextAction::Review);
    let logs = json!({"code":"user_cancel","message":"Error: prompt too long"});
    assert_eq!(
        diagnose("opencode", Origin::Stderr, &logs)
            .unwrap()
            .category,
        Category::CancelShutdown
    );
}
