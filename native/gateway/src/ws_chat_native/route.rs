use multicc_core::{
    auth_runtime,
    js::{JsString, JsValue as V},
    provider_attempt_identity, quota_guard,
};

use super::{optional_text, property, provider::Provider};

pub(super) struct Route {
    pub scope: V,
    pub model: V,
    pub provider_name: V,
    protocol: &'static str,
}

impl Route {
    pub fn model_attribution(&self) -> V {
        let model = if self.protocol == "openai_responses" && self.model.is_nullish() {
            V::Undefined
        } else {
            self.model.clone()
        };
        V::object(vec![
            ("cli", property(&self.scope, "cli")),
            ("providerId", property(&self.scope, "providerId")),
            ("providerName", self.provider_name.clone()),
            ("model", model),
        ])
    }

    pub fn new(
        epoch: &str,
        turn: &str,
        attempt: &str,
        generation: u64,
        record: &V,
        provider: Option<&Provider>,
    ) -> Self {
        let cli = super::store::cli(record);
        let (protocol, native_id, native_name) = if super::store::is_codex(record) {
            (
                "openai_responses",
                super::codex::DEFAULT_PROVIDER_ID,
                super::codex::DEFAULT_PROVIDER_NAME,
            )
        } else {
            ("anthropic", "claude-official", "Claude")
        };
        let (provider_id, provider_name, model, revision) = match provider {
            Some(provider) => (
                provider.id.as_str(),
                provider.name.as_str(),
                provider.model.clone(),
                provider.revision.clone(),
            ),
            None => {
                let model = optional_text(record, "model");
                let revision = provider_attempt_identity::provider_revision(
                    &JsString::from_rust_str(&format!(
                        "{cli}:{protocol}:{native_id}:{}",
                        model.as_deref().unwrap_or_default(),
                    )),
                );
                (native_id, native_name, model, revision)
            }
        };
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
            ("providerId", V::from(provider_id)),
            ("providerRevision", V::from(revision)),
        ]);
        Self {
            scope,
            model: model.map_or(V::Null, V::from),
            provider_name: V::from(provider_name),
            protocol,
        }
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
        let model = if self.protocol == "openai_responses" && self.model.is_nullish() {
            V::from("_default_")
        } else {
            self.model.clone()
        };
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
            ("providerName", self.provider_name.clone()),
            ("protocol", V::from(self.protocol)),
            ("model", model),
            ("providerRevision", field("providerRevision")),
            ("replayFence", V::from(fence)),
            ("safeToReplay", V::Bool(fence == "none")),
            ("ts", V::Number(auth_runtime::now_ms())),
        ])
    }
}
