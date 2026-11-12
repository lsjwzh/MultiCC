//! Which balance strategy a provider's upstream base URL can be polled with.
//!
//! Known vendors keep their dedicated adapters. Any other public relay host is
//! classified `panel-auto`: the gateway probes the common relay-panel balance
//! APIs (new-api / one-api / sub2api / generic `/user/balance`) with the
//! provider's own key. Loopback/private hosts and official model vendors that
//! never expose those panel APIs are left unclassified so they are not probed.

use url::{Host, Url};

/// Official vendor hosts with no relay-panel balance API. Probing them would
/// only produce 404s, so they stay "unsupported".
const NOT_A_PANEL: &[&str] = &[
    "anthropic.com",
    "openai.com",
    "chatgpt.com",
    "openrouter.ai",
    "googleapis.com",
    "x.ai",
    "mistral.ai",
    "groq.com",
    "aliyuncs.com",
    "volces.com",
    "siliconflow.cn",
    "siliconflow.com",
    "minimax.chat",
    "minimaxi.com",
    "minimax.io",
    "stepfun.com",
    "opencode.ai",
    "azure.com",
    "amazonaws.com",
];

fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

fn is_private(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => {
            let name = name.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local")
        }
        Host::Ipv4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        Host::Ipv6(ip) => ip.is_loopback() || ip.is_unspecified(),
    }
}

pub fn strategy_for_base_url(base_url: &str) -> Option<&'static str> {
    let url = Url::parse(base_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host()?;
    let name = url.host_str()?.to_ascii_lowercase();
    if name == "api.deepseek.com" {
        return Some("deepseek-balance");
    }
    if name == "open.bigmodel.cn" || name == "api.z.ai" || name.ends_with(".bigmodel.cn") {
        return Some("glm-monitor");
    }
    let label = name.rsplit('.').nth(1).unwrap_or("");
    let tld = name.rsplit('.').next().unwrap_or("");
    if matches!(label, "moonshot" | "kimi") && matches!(tld, "cn" | "com" | "ai") {
        return Some("kimi-balance");
    }
    if is_private(&host) || NOT_A_PANEL.iter().any(|suffix| host_matches(&name, suffix)) {
        return None;
    }
    Some("panel-auto")
}

#[cfg(test)]
mod tests {
    use super::strategy_for_base_url as s;

    #[test]
    fn keeps_dedicated_vendor_strategies() {
        assert_eq!(s("https://api.deepseek.com"), Some("deepseek-balance"));
        assert_eq!(
            s("https://open.bigmodel.cn/api/anthropic"),
            Some("glm-monitor")
        );
        assert_eq!(s("https://x.bigmodel.cn"), Some("glm-monitor"));
        assert_eq!(s("https://api.z.ai/api/anthropic"), Some("glm-monitor"));
        assert_eq!(s("https://api.moonshot.cn/anthropic"), Some("kimi-balance"));
        assert_eq!(s("https://api.kimi.com/coding"), Some("kimi-balance"));
        assert_eq!(s("https://moonshot.ai"), Some("kimi-balance"));
    }

    #[test]
    fn third_party_relays_probe_panels() {
        assert_eq!(s("https://newapi.eronmind.com"), Some("panel-auto"));
        assert_eq!(s("https://relay.example.com/v1/"), Some("panel-auto"));
        assert_eq!(s("http://8.8.8.8:3000"), Some("panel-auto"));
    }

    #[test]
    fn skips_private_official_and_malformed_hosts() {
        for url in [
            "http://127.0.0.1:3000/claude-proxy/x",
            "http://localhost:8080",
            "http://192.168.1.5",
            "http://[::1]:9",
            "https://api.anthropic.com",
            "https://api.openai.com/v1",
            "https://openrouter.ai/api",
            "https://dashscope.aliyuncs.com/compatible-mode",
            "not a url",
            "ftp://relay.example.com",
            "",
        ] {
            assert_eq!(s(url), None, "{url}");
        }
    }
}
