//! Claude 续期预算的纯决策；凭据读写、探测与尝试标记持久化由调用方负责。
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    now: f64,
    expires_at: f64,
    has_refresh_token: bool,
    refresh_expires_at: Option<f64>,
    post_expiry_attempted_for: Option<f64>,
    parked_failure_class: Option<String>,
    #[serde(default)]
    parked: bool,
    #[serde(default)]
    probes: u32,
    #[serde(default = "default_max_probes")]
    max_probes: u32,
    #[serde(default)]
    force: bool,
}

fn default_max_probes() -> u32 {
    2
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    recover_parked: bool,
    allow_probe: bool,
    reserve_post_expiry: bool,
    budget_floor: u32,
}

fn is_terminal_failure(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("rejected" | "needs-login" | "revoked" | "token_revoked")
    )
}

fn decide(input: &Input) -> Plan {
    let valid_time = input.now.is_finite()
        && input.now > 0.0
        && input.expires_at.is_finite()
        && input.expires_at > 0.0;
    let expired = valid_time && input.expires_at <= input.now;
    let not_reserved = input.post_expiry_attempted_for != Some(input.expires_at);
    let refresh_usable = input.has_refresh_token
        && input
            .refresh_expires_at
            .map(|expiry| expiry.is_finite() && expiry > input.now)
            .unwrap_or(true);
    let extra_opportunity = expired && refresh_usable && not_reserved;
    let terminal = is_terminal_failure(input.parked_failure_class.as_deref());
    let recover_parked = input.parked && !terminal && extra_opportunity;
    // 旧暂停记录可能没有内存计数。恢复时补齐预算下限，不能因此重新获得两次普通探测。
    let budget_floor = if recover_parked { input.max_probes } else { 0 };
    let allow_probe = valid_time
        && refresh_usable
        && !terminal
        && (!input.parked || recover_parked)
        && (input.force || input.probes.max(budget_floor) < input.max_probes || extra_opportunity);

    Plan {
        recover_parked,
        allow_probe,
        // 即使用的是普通预算，也记录本凭据已在过期后尝试；须在启动 CLI 前持久化。
        reserve_post_expiry: allow_probe && expired && not_reserved,
        budget_floor,
    }
}

/// 输入和输出均为固定字段的 JSON；不读写凭据，不执行网络或文件操作。
pub fn plan(input_json: &str) -> Result<String, String> {
    let input: Input =
        serde_json::from_str(input_json).map_err(|_| "Claude 续期决策参数无效".to_owned())?;
    serde_json::to_string(&decide(&input)).map_err(|_| "Claude 续期决策序列化失败".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn input() -> Input {
        Input {
            now: 1_000.0,
            expires_at: 900.0,
            has_refresh_token: true,
            refresh_expires_at: None,
            post_expiry_attempted_for: None,
            parked_failure_class: None,
            parked: false,
            probes: 2,
            max_probes: 2,
            force: false,
        }
    }

    #[test]
    fn exhausted_before_expiry_does_not_spend_the_expired_opportunity() {
        let mut input = input();
        input.now = 899.0;
        assert!(!decide(&input).allow_probe);
        assert!(!decide(&input).reserve_post_expiry);
        input.now = 1_000.0;
        assert!(decide(&input).allow_probe);
        assert!(decide(&input).reserve_post_expiry);
    }

    #[test]
    fn expiry_boundary_gets_one_independent_opportunity() {
        let mut input = input();
        input.now = input.expires_at;
        let plan = decide(&input);
        assert!(plan.allow_probe);
        assert!(plan.reserve_post_expiry);
        assert!(!plan.recover_parked);
        assert_eq!(plan.budget_floor, 0);
        input.post_expiry_attempted_for = Some(input.expires_at);
        assert!(!decide(&input).allow_probe);
        assert!(!decide(&input).reserve_post_expiry);
    }

    #[test]
    fn ordinary_expired_probe_also_reserves_the_opportunity() {
        let mut input = input();
        input.probes = 0;
        assert!(decide(&input).reserve_post_expiry);
        input.post_expiry_attempted_for = Some(input.expires_at);
        input.probes = 1;
        assert!(decide(&input).allow_probe);
        assert!(!decide(&input).reserve_post_expiry);
        input.probes = 2;
        assert!(!decide(&input).allow_probe);
    }

    #[test]
    fn old_non_terminal_parked_records_recover_only_once() {
        for failure in [None, Some("unknown"), Some("network"), Some("future-class")] {
            let mut input = input();
            input.parked = true;
            input.probes = 0;
            input.parked_failure_class = failure.map(str::to_owned);
            let plan = decide(&input);
            assert!(plan.recover_parked, "{failure:?}");
            assert!(plan.allow_probe, "{failure:?}");
            assert_eq!(plan.budget_floor, 2);
            input.post_expiry_attempted_for = Some(input.expires_at);
            assert!(!decide(&input).recover_parked);
            assert!(!decide(&input).allow_probe);
        }
    }

    #[test]
    fn explicit_authentication_failures_cannot_be_forced() {
        for failure in ["rejected", "needs-login", "revoked", "token_revoked"] {
            for force in [false, true] {
                for parked in [false, true] {
                    let mut input = input();
                    input.parked = parked;
                    input.probes = 0;
                    input.parked_failure_class = Some(failure.to_owned());
                    input.force = force;
                    let plan = decide(&input);
                    assert!(!plan.recover_parked, "{failure}");
                    assert!(!plan.allow_probe, "{failure}");
                    assert!(!plan.reserve_post_expiry, "{failure}");
                }
            }
        }
    }

    #[test]
    fn missing_or_expired_refresh_token_does_not_grant_extra_attempt() {
        let mut input = input();
        input.has_refresh_token = false;
        assert!(!decide(&input).allow_probe);
        input.parked = true;
        assert!(!decide(&input).recover_parked);
        input.has_refresh_token = true;
        for expiry in [Some(999.0), Some(1_000.0), Some(f64::NAN)] {
            input.refresh_expires_at = expiry;
            assert!(!decide(&input).allow_probe);
            assert!(!decide(&input).recover_parked);
        }
        input.refresh_expires_at = Some(1_001.0);
        assert!(decide(&input).recover_parked);
    }

    #[test]
    fn unusable_refresh_credentials_also_block_normal_and_forced_probes() {
        for force in [false, true] {
            let mut input = input();
            input.probes = 0;
            input.force = force;
            input.has_refresh_token = false;
            assert!(!decide(&input).allow_probe);
            input.has_refresh_token = true;
            input.refresh_expires_at = Some(input.now);
            assert!(!decide(&input).allow_probe);
        }
    }

    #[test]
    fn new_credential_expiry_gets_its_own_opportunity() {
        let mut input = input();
        input.post_expiry_attempted_for = Some(input.expires_at);
        assert!(!decide(&input).allow_probe);
        input.expires_at = 950.0;
        assert!(decide(&input).allow_probe);
        assert!(decide(&input).reserve_post_expiry);
    }

    #[test]
    fn force_keeps_manual_budget_bypass_without_reopening_parked_records() {
        let mut input = input();
        input.post_expiry_attempted_for = Some(input.expires_at);
        input.force = true;
        assert!(decide(&input).allow_probe);
        assert!(!decide(&input).reserve_post_expiry);
        input.parked = true;
        assert!(!decide(&input).allow_probe);
    }

    #[test]
    fn invalid_expiry_never_grants_extra_attempt() {
        let mut input = input();
        input.probes = 0;
        input.force = true;
        for expiry in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            input.expires_at = expiry;
            assert!(!decide(&input).allow_probe);
        }
        input.expires_at = 900.0;
        for now in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            input.now = now;
            assert!(!decide(&input).allow_probe);
        }
    }

    #[test]
    fn zero_budget_still_preserves_the_single_expired_opportunity() {
        let mut input = input();
        input.max_probes = 0;
        input.probes = 0;
        assert!(decide(&input).allow_probe);
        input.post_expiry_attempted_for = Some(input.expires_at);
        assert!(!decide(&input).allow_probe);
    }

    #[test]
    fn json_contract_uses_camel_case_and_defaults() {
        let output: Value = serde_json::from_str(
            &plan(&json!({"now": 1000, "expiresAt": 1100, "hasRefreshToken": true}).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            output,
            json!({"recoverParked": false, "allowProbe": true,
                   "reservePostExpiry": false, "budgetFloor": 0})
        );
    }

    #[test]
    fn invalid_json_errors_do_not_echo_input() {
        let error = plan(r#"{"now":"SECRET_INPUT_MUST_NOT_ESCAPE"}"#).unwrap_err();
        assert!(!error.contains("SECRET_INPUT_MUST_NOT_ESCAPE"));
    }
}
