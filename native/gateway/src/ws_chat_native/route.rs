use multicc_core::{
    auth_runtime,
    js::{JsString, JsValue as V},
    provider_attempt_identity, quota_guard,
};

use super::{optional_text, property};

pub(super) struct Route {
    pub scope: V,
    pub model: V,
}

impl Route {
    pub fn new(epoch: &str, turn: &str, attempt: &str, generation: u64, record: &V) -> Self {
        let cli = super::store::cli(record);
        let model = optional_text(record, "model").map_or(V::Null, V::from);
        let revision =
            provider_attempt_identity::provider_revision(&JsString::from_rust_str(&format!(
                "{cli}:anthropic:claude-official:{}",
                optional_text(record, "model").unwrap_or_default(),
            )));
        let scope = V::object(vec![
            ("providerRouteProtocolVersion", V::Number(1.0)),
            ("providerRouteScope", V::from("attempt")),
            ("cli", V::from(cli)),
            ("runtimeEpoch", V::from(epoch)),
            ("turnId", V::from(turn)),
            ("decisionId", V::from(turn)),
            ("routeAttemptId", V::from(attempt)),
            ("routeGeneration", V::Number(generation as f64)),
            ("attemptNo", V::Number(1.0)),
            ("providerId", V::from("claude-official")),
            ("providerRevision", V::from(revision)),
        ]);
        Self { scope, model }
    }

    pub fn tag(&self, mut frame: V) -> V {
        if let V::Object(fields) = &self.scope {
            for (key, value) in fields {
                quota_guard::set(&mut frame, &key.as_str_lossy(), value.clone());
            }
        }
        frame
    }

    pub fn event(&self, session: &str, phase: &str, fence: &str) -> V {
        let field = |name| property(&self.scope, name);
        V::object(vec![
            ("type", V::from("provider_route_event")),
            ("version", V::Number(1.0)),
            ("providerRouteScope", field("providerRouteScope")),
            ("runtimeEpoch", field("runtimeEpoch")),
            ("routePhase", V::from(phase)),
            ("sessionId", V::from(session)),
            ("turnId", field("turnId")),
            ("cli", field("cli")),
            ("decisionId", field("decisionId")),
            ("routeAttemptId", field("routeAttemptId")),
            ("routeGeneration", field("routeGeneration")),
            ("attemptNo", field("attemptNo")),
            ("providerId", field("providerId")),
            ("providerName", V::from("Claude")),
            ("protocol", V::from("anthropic")),
            ("model", self.model.clone()),
            ("providerRevision", field("providerRevision")),
            ("replayFence", V::from(fence)),
            ("safeToReplay", V::Bool(fence == "none")),
            ("ts", V::Number(auth_runtime::now_ms())),
        ])
    }
}
