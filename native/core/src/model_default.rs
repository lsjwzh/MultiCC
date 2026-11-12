//! 默认模型的规则、历史快照和结果缓存由同一原生所有者管理。
//! 宿主读取当前线路事实；内部直接传结构体，不经过 JSON。
use std::collections::HashMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct ProviderInfo {
    pub model: Option<String>,
    pub options: Vec<String>,
    pub alias_only: bool,
    pub official: bool,
}

#[derive(Clone, Debug)]
pub struct History {
    pub cli: String,
    pub provider: Option<String>,
    pub model: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Kind {
    #[default]
    Effective,
    ProviderDefault,
}

/// 所有影响结果的线路事实均参与缓存键；历史代次由 Store 独立管理。
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Request {
    pub kind: Kind,
    pub cli: String,
    pub app_type: Option<String>,
    pub provider_id: Option<String>,
    pub history_provider_id: Option<String>,
    pub provider: Option<ProviderInfo>,
    pub models: Vec<String>,
    pub reported_model: Option<String>,
    pub global_provider_cli: bool,
    pub wire_default_model: Option<String>,
}

struct Snapshot {
    at: f64,
    entries: Vec<History>,
}

pub struct Store {
    ttl_ms: f64,
    generation: u64,
    history: Option<Snapshot>,
    resolved: HashMap<Request, Option<String>>,
}

impl Store {
    pub fn new(ttl_ms: f64) -> Self {
        Self {
            ttl_ms: if ttl_ms.is_finite() {
                ttl_ms.max(0.0)
            } else {
                30_000.0
            },
            generation: 0,
            history: None,
            resolved: HashMap::new(),
        }
    }

    pub fn caching(&self) -> bool {
        self.ttl_ms > 0.0
    }

    /// 返回刷新代次。无快照时，即使时钟为 0 也不能命中空缓存。
    /// 时钟回退或非有限值使快照失效，避免旧结果被无限延长。
    pub fn refresh_token(&self, now: f64) -> Option<u64> {
        let fresh = self.history.as_ref().is_some_and(|history| {
            let elapsed = now - history.at;
            self.caching() && elapsed.is_finite() && elapsed >= 0.0 && elapsed < self.ttl_ms
        });
        (!fresh).then_some(self.generation)
    }

    /// 所有宿主回调及输入读取均在发布前结束；重入已经发布更新时保留较新代次。
    pub fn publish(&mut self, token: u64, entries: Vec<History>, at: f64) {
        if self.generation != token {
            return;
        }
        self.history = Some(Snapshot { at, entries });
        self.generation = self.generation.wrapping_add(1);
        self.resolved.clear();
    }

    pub fn resolve(&mut self, request: Request) -> Option<String> {
        if self.caching() {
            if let Some(result) = self.resolved.get(&request) {
                return result.clone();
            }
        }
        let history = self
            .history
            .as_ref()
            .map_or(&[][..], |snapshot| snapshot.entries.as_slice());
        let model = resolve(&request, history);
        if self.caching() {
            // 查询结果可重算；每个 runtime 设置上限，避免高基数请求在 TTL 内累积。
            if self.resolved.len() >= 1024 {
                self.resolved.clear();
            }
            self.resolved.insert(request, model.clone());
        }
        model
    }
}

// `claude-exp` is the same Claude lane as `claude`; the usage the user built up
// on either adapter belongs to one list. Same for codex/codex-exp.
fn normalize_cli(cli: &str) -> String {
    let cli = cli.trim().to_ascii_lowercase();
    cli.strip_suffix("-exp").unwrap_or(&cli).to_owned()
}

fn normalize_provider(provider: Option<&str>) -> String {
    provider
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != "_default_")
        .unwrap_or("")
        .to_owned()
}

// Frequency first, list order on ties, first entry when the lane has no usable
// history. Models that are no longer in the list never win, however often they
// were picked before a catalog change.
fn pick(
    models: &[String],
    history: &[History],
    cli: &str,
    provider: Option<&str>,
) -> Option<String> {
    let mut counts = vec![0usize; models.len()];
    let lane_cli = normalize_cli(cli);
    let lane_provider = normalize_provider(provider);
    for entry in history {
        if normalize_cli(&entry.cli) != lane_cli
            || normalize_provider(entry.provider.as_deref()) != lane_provider
        {
            continue;
        }
        if let Some(index) = models.iter().position(|model| model == &entry.model) {
            counts[index] += 1;
        }
    }
    let mut best = 0usize;
    for index in 1..models.len() {
        if counts[index] > counts[best] {
            best = index;
        }
    }
    models.get(best).cloned()
}

fn resolve_effective(input: &Request, history: &[History]) -> Option<String> {
    let key = input.history_provider_id.as_deref();
    if input.provider_id.is_some() {
        if let Some(info) = &input.provider {
            if let Some(model) = &info.model {
                return Some(model.clone());
            }
            if !info.options.is_empty() {
                if let Some(model) = pick(&info.options, history, &input.cli, key) {
                    return Some(model);
                }
            }
            if info.official {
                if let Some(model) = pick(&input.models, history, &input.cli, key) {
                    return Some(model);
                }
            }
        }
        // A route that declares no default model has none to offer, so the CLI
        // must run on the route's own configuration (no `--model`). The session's
        // `reportedModel` is not route-scoped: after a manual switch with the
        // picker left on "line default" it still names the previous route's
        // model, and handing it over as the default sent e.g. Kimi's
        // `kimi-k2.7-code` to a relayed Claude account. Codex already followed
        // this rule; it now holds for every app type.
        return None;
    }
    if input.global_provider_cli {
        return input.reported_model.clone();
    }
    match input.app_type.as_deref() {
        Some("claude") | Some("codex") => {
            pick(&input.models, history, &input.cli, None).or_else(|| input.reported_model.clone())
        }
        _ => input.reported_model.clone(),
    }
}

fn resolve_provider_default(input: &Request, history: &[History]) -> Option<String> {
    if input.provider_id.is_none() {
        return if input.app_type.as_deref() == Some("claude") {
            pick(&input.models, history, &input.cli, None)
        } else {
            None
        };
    }
    let info = input.provider.as_ref()?;
    if info.alias_only {
        return input.wire_default_model.clone();
    }
    if let Some(model) = &info.model {
        return Some(model.clone());
    }
    let key = input.history_provider_id.as_deref();
    if !info.options.is_empty() {
        return pick(&info.options, history, &input.cli, key);
    }
    if info.official {
        return pick(&input.models, history, &input.cli, key);
    }
    None
}

pub fn resolve(input: &Request, history: &[History]) -> Option<String> {
    match input.kind {
        Kind::Effective => resolve_effective(input, history),
        Kind::ProviderDefault => resolve_provider_default(input, history),
    }
}

#[cfg(test)]
#[path = "../tests/fixtures/legacy_model_default.rs"]
mod legacy;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn request(kind: &str, fields: Value) -> String {
        let mut object = json!({ "kind": kind, "cli": "claude", "appType": "claude" });
        object
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        object.to_string()
    }

    fn text(value: Option<&Value>) -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
    fn list(value: Option<&Value>) -> Vec<String> {
        let mut out = Vec::new();
        for value in value.and_then(Value::as_array).into_iter().flatten() {
            if let Some(s) = text(Some(value)) {
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
        out
    }
    fn facts(input: &Value) -> (Request, Vec<History>) {
        let o = input.as_object().unwrap();
        let provider_id = text(o.get("providerId"));
        let req = Request {
            kind: if text(o.get("kind")).as_deref() == Some("providerDefault") {
                Kind::ProviderDefault
            } else {
                Kind::Effective
            },
            cli: text(o.get("cli")).unwrap_or_default(),
            app_type: text(o.get("appType")),
            history_provider_id: if o.contains_key("historyProviderId") {
                text(o.get("historyProviderId"))
            } else {
                provider_id.clone()
            },
            provider_id,
            provider: o
                .get("provider")
                .and_then(Value::as_object)
                .map(|p| ProviderInfo {
                    model: text(p.get("model")),
                    options: list(p.get("modelOptions")),
                    alias_only: p.get("aliasOnly").and_then(Value::as_bool).unwrap_or(false),
                    official: p.get("official").and_then(Value::as_bool).unwrap_or(false),
                }),
            models: list(o.get("models")),
            reported_model: text(o.get("reportedModel")),
            global_provider_cli: o
                .get("globalProviderCli")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            wire_default_model: text(o.get("wireDefaultModel")),
        };
        let history = o
            .get("history")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| {
                Some(History {
                    cli: text(v.get("cli"))?,
                    model: text(v.get("model"))?,
                    provider: text(v.get("provider")),
                })
            })
            .collect();
        (req, history)
    }
    fn model(input: &str) -> Option<String> {
        let value: Value = serde_json::from_str(input).unwrap();
        let (req, history) = facts(&value);
        let actual = resolve(&req, &history);
        let expected: Value = serde_json::from_str(&legacy::resolve(input).unwrap()).unwrap();
        let expected = text(expected.get("model"));
        if req.kind == Kind::Effective && req.provider_id.is_some() && actual.is_none() {
            // The one intended deviation from the frozen rule: a route without
            // a declared default no longer borrows the unscoped reportedModel.
            assert!(
                expected.is_none() || expected == req.reported_model,
                "only the reportedModel fallback may differ: {expected:?}"
            );
        } else {
            assert_eq!(actual, expected);
        }
        actual
    }

    fn history(entries: &[(&str, Option<&str>, &str)]) -> Value {
        Value::Array(
            entries
                .iter()
                .map(|(cli, provider, model)| {
                    json!({ "cli": cli, "provider": provider, "model": model })
                })
                .collect(),
        )
    }

    #[test]
    fn official_lane_uses_most_frequent_selection() {
        let input = request(
            "effective",
            json!({
                "providerId": Value::Null,
                "models": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
                "history": history(&[
                    ("claude", None, "claude-sonnet-5"),
                    ("claude-exp", None, "claude-sonnet-5"),
                    ("claude", None, "claude-opus-5"),
                ]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-sonnet-5"));
    }

    #[test]
    fn ties_resolve_to_list_order() {
        let input = request(
            "effective",
            json!({
                "models": ["claude-opus-5", "claude-sonnet-5"],
                "history": history(&[
                    ("claude", None, "claude-sonnet-5"),
                    ("claude", None, "claude-opus-5"),
                ]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn empty_history_uses_first_entry() {
        let input = request(
            "effective",
            json!({ "models": ["claude-opus-5", "claude-sonnet-5"], "history": [] }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn stale_history_entries_are_ignored() {
        let input = request(
            "effective",
            json!({
                "models": ["claude-opus-5", "claude-sonnet-5"],
                "history": history(&[
                    ("claude", None, "deepseek-flash"),
                    ("claude", None, "deepseek-flash"),
                    ("claude", None, "claude-sonnet-5"),
                ]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-sonnet-5"));
    }

    #[test]
    fn provider_pinned_model_wins_over_history() {
        let input = request(
            "effective",
            json!({
                "providerId": "relay",
                "provider": { "model": "relay-pinned", "modelOptions": ["relay-pinned", "relay-fast"] },
                "history": history(&[("claude", Some("relay"), "relay-fast")]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("relay-pinned"));
    }

    #[test]
    fn provider_options_use_frequency() {
        let input = request(
            "effective",
            json!({
                "providerId": "relay",
                "provider": { "modelOptions": ["relay-a", "relay-b"] },
                "history": history(&[("claude", Some("relay"), "relay-b")]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("relay-b"));
    }

    #[test]
    fn provider_default_keeps_alias_only_wire_default() {
        let input = request(
            "providerDefault",
            json!({
                "providerId": "relay",
                "provider": { "aliasOnly": true, "modelOptions": ["relay-a"] },
                "wireDefaultModel": "claude-sonnet-4-5",
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn provider_history_does_not_leak_across_routes() {
        let input = request(
            "effective",
            json!({
                "providerId": "relay",
                "provider": { "modelOptions": ["relay-a", "relay-b"] },
                "history": history(&[("claude", Some("other"), "relay-b")]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("relay-a"));
    }

    #[test]
    fn official_codex_with_empty_catalog_drops_stale_reported_model() {
        let input = request(
            "effective",
            json!({
                "cli": "codex",
                "appType": "codex",
                "providerId": "codex-official",
                "provider": { "official": true, "modelOptions": [] },
                "models": [],
                "reportedModel": "deepseek-flash",
                "history": [],
            }),
        );
        assert_eq!(model(&input), None);
    }

    #[test]
    fn route_without_declared_default_ignores_previous_routes_reported_model() {
        // Kimi reported `kimi-k2.7-code`; the user then picked a relayed Claude
        // account (no model, no options, not official) and left the model on
        // "line default". The route's own configuration must decide.
        for app_type in ["claude", "codex"] {
            let input = request(
                "effective",
                json!({
                    "cli": app_type,
                    "appType": app_type,
                    "providerId": "359daa1b-relay",
                    "provider": { "model": null, "modelOptions": [], "official": false },
                    "models": ["claude-opus-5-5", "claude-sonnet-5"],
                    "reportedModel": "kimi-k2.7-code",
                    "history": [],
                }),
            );
            let value: Value = serde_json::from_str(&input).unwrap();
            let (req, history) = facts(&value);
            assert_eq!(resolve(&req, &history), None, "{app_type}");
        }
        // A provider id whose summary is gone (deleted route) behaves the same.
        let dangling = request(
            "effective",
            json!({ "providerId": "gone", "reportedModel": "kimi-k2.7-code" }),
        );
        let value: Value = serde_json::from_str(&dangling).unwrap();
        let (req, history) = facts(&value);
        assert_eq!(resolve(&req, &history), None);
        // Declared defaults still win, and provider-less lanes keep their
        // reported runtime model when the lane has no list of its own.
        assert_eq!(
            model(&request(
                "effective",
                json!({
                    "providerId": "kimi",
                    "provider": { "model": "kimi-k2.7-code" },
                    "reportedModel": "claude-opus-5-5",
                }),
            ))
            .as_deref(),
            Some("kimi-k2.7-code")
        );
        assert_eq!(
            model(&request(
                "effective",
                json!({ "appType": "claude", "models": [], "reportedModel": "runtime" }),
            ))
            .as_deref(),
            Some("runtime")
        );
    }

    #[test]
    fn explicit_null_history_provider_scopes_to_the_shared_official_line() {
        let input = request(
            "effective",
            json!({
                "providerId": "claude-official",
                "historyProviderId": Value::Null,
                "provider": { "official": true, "modelOptions": [] },
                "models": ["claude-opus-5", "claude-sonnet-5"],
                "history": history(&[
                    ("claude", None, "claude-sonnet-5"),
                    ("claude", Some("claude-official"), "claude-opus-5"),
                ]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-sonnet-5"));
    }

    #[test]
    fn provider_default_official_uses_frequency() {
        let input = request(
            "providerDefault",
            json!({
                "providerId": Value::Null,
                "models": ["claude-opus-5", "claude-sonnet-5"],
                "history": history(&[("claude", None, "claude-sonnet-5")]),
            }),
        );
        assert_eq!(model(&input).as_deref(), Some("claude-sonnet-5"));
    }

    #[test]
    fn differential_against_frozen_json_rule() {
        let mut seed = 0x91a2b3c4_u64;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as usize % n
        };
        let ids = [
            Value::Null,
            json!("relay"),
            json!("other"),
            json!(" _default_ "),
        ];
        for _ in 0..2500 {
            let cli = ["claude", "claude-exp", "codex", "codex-exp", "zcode"][next(5)];
            let input = json!({
                "kind": (["effective", "providerDefault"][next(2)]),
                "cli": cli,
                "appType": (["claude", "codex", "zcode"][next(3)]),
                "providerId": ids[next(4)],
                "historyProviderId": ids[next(4)],
                "provider": if next(4) == 0 { Value::Null } else { json!({
                    "model": ([Value::Null, json!("固定模型")][next(2)]),
                    "modelOptions": ([json!([]), json!(["a", "b", "模型😀"])][next(2)]),
                    "aliasOnly": next(2) == 0, "official": next(2) == 0,
                }) },
                "models": ([json!([]), json!(["b", "a", "模型😀", "b"])][next(2)]),
                "reportedModel": ([Value::Null, json!("reported")][next(2)]),
                "globalProviderCli": next(2) == 0,
                "wireDefaultModel": ([Value::Null, json!("wire")][next(2)]),
                "history": (0..next(20)).map(|_| json!({
                    "cli": (["claude", "CLAUDE-EXP", "codex", "codex-exp"][next(4)]),
                    "provider": ids[next(4)], "model": (["a", "b", "模型😀", "stale"][next(4)]),
                })).collect::<Vec<_>>(),
            });
            model(&input.to_string());
        }
    }

    #[test]
    fn snapshot_ttl_initial_zero_boundary_rollback_and_nonfinite_clock() {
        let mut store = Store::new(30.0);
        assert_eq!(store.refresh_token(0.0), Some(0));
        store.publish(0, vec![], 0.0);
        assert_eq!(store.refresh_token(0.0), None);
        assert_eq!(store.refresh_token(29.999), None);
        for at in [30.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(store.refresh_token(at), Some(1));
        }
        assert!(Store::new(f64::NAN).caching());
        assert!(!Store::new(-1.0).caching());
        assert!(!Store::new(0.0).caching());
    }

    #[test]
    fn reentrant_publication_cannot_restore_older_history() {
        let mut store = Store::new(30.0);
        let input = Request {
            app_type: Some("claude".into()),
            cli: "claude".into(),
            models: vec!["a".into(), "b".into()],
            ..Default::default()
        };
        let token = store.refresh_token(0.0).unwrap();
        store.publish(
            token,
            vec![History {
                cli: "claude".into(),
                provider: None,
                model: "b".into(),
            }],
            1.0,
        );
        store.publish(token, vec![], 2.0);
        assert_eq!(store.resolve(input.clone()).as_deref(), Some("b"));
        let token = store.refresh_token(31.0).unwrap();
        store.publish(token, vec![], 31.0);
        assert_eq!(store.resolve(input).as_deref(), Some("a"));
    }

    #[test]
    fn typed_keys_bound_memory_without_changing_results() {
        let mut store = Store::new(30.0);
        store.publish(0, vec![], 0.0);
        for n in 0..2200 {
            let expected = format!("model-{n}");
            let input = Request {
                reported_model: Some(expected.clone()),
                ..Default::default()
            };
            assert_eq!(store.resolve(input), Some(expected));
            assert!(store.resolved.len() <= 1024);
        }
    }
}
