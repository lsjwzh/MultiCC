//! P2P 直连的桥侧接口。
//!
//! 真正的 WebRTC 实现（STUN/ICE/DataChannel）是另一个模块，桥只依赖这组 trait：
//! 信令经已鉴权的 WS 文本消息走，帧走 DataChannel，打不通就一直走中继。

use bytes::Bytes;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc::UnboundedSender;

pub struct P2pOptions {
    pub stun_urls: Vec<String>, // 空 = 不用 STUN，只有本机/局域网候选
    pub open_timeout: Duration, // 默认 10 s
    pub chunk_bytes: usize,     // 默认 16 KiB
}

pub enum P2pEvent {
    Signal(Value),          // 经 WS 文本发给客户端：rtc-answer / rtc-ice
    Open(Arc<dyn P2pSink>), // DataChannel 已可用
    Closed,                 // 当前直连断开（只在 Open 过之后才发）
    Input(Bytes),           // 客户端经 DataChannel 发来的二进制
}

pub trait P2pSink: Send + Sync {
    fn send(&self, frame: &[u8]) -> bool;
    fn buffered(&self) -> usize;
}

pub trait P2pControl: Send + Sync {
    fn handle_signal(&self, msg: &Value);
    fn active(&self) -> bool;
    fn close(&self);
}

pub type P2pFactory =
    Arc<dyn Fn(P2pOptions, UnboundedSender<P2pEvent>) -> Box<dyn P2pControl> + Send + Sync>;

/// 公共 STUN（只探测地址，不转发数据）。MULTICC_REMOTE_STUN 可覆盖。
pub const DEFAULT_STUN: [&str; 2] = ["stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302"];

/// 规则同 JS `iceServersFromEnv({})`：
///   · 未设置 → 默认两个公共 STUN；
///   · 设为空串 → 不用 STUN，只在局域网直连；
///   · 逗号分隔，只收 `^stuns?:\S+$`，最多 4 个（TURN 一律不收）。
pub fn stun_urls_from_env() -> Vec<String> {
    stun_urls_from(std::env::var("MULTICC_REMOTE_STUN").ok())
}

pub fn stun_urls_from(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw else {
        return DEFAULT_STUN.iter().map(|s| s.to_string()).collect();
    };
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| is_stun_url(s))
        .take(4)
        .map(|s| s.to_string())
        .collect()
}

/// `^stuns?:\S+$`：前缀之后必须有非空白字符，整串不能有空白。
pub fn is_stun_url(text: &str) -> bool {
    let rest = text
        .strip_prefix("stun:")
        .or_else(|| text.strip_prefix("stuns:"));
    match rest {
        Some(rest) => !rest.is_empty() && !rest.chars().any(|c| c.is_whitespace()),
        None => false,
    }
}

/// `{t:'rtc-hello', iceServers}` 里的 iceServers 字段。
pub fn ice_servers_json(urls: &[String]) -> Value {
    if urls.is_empty() {
        Value::Array(Vec::new())
    } else {
        serde_json::json!([{ "urls": urls }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ice_servers_public_stun_by_default_env_overrides_empty_means_lan_only() {
        assert_eq!(
            stun_urls_from(None),
            vec!["stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302"]
        );
        assert!(stun_urls_from(Some(String::new())).is_empty());
        assert_eq!(
            stun_urls_from(Some(
                "stun:a.example:3478, turn:relay.example, http://x, stuns:b.example".into()
            )),
            vec!["stun:a.example:3478", "stuns:b.example"]
        );
    }

    #[test]
    fn at_most_four_stun_urls() {
        let raw: Vec<String> = (0..8).map(|i| format!("stun:h{i}:3478")).collect();
        assert_eq!(stun_urls_from(Some(raw.join(","))).len(), 4);
    }

    #[test]
    fn hello_ice_servers_shape() {
        assert_eq!(ice_servers_json(&[]), serde_json::json!([]));
        assert_eq!(
            ice_servers_json(&["stun:a:1".to_string()]),
            serde_json::json!([{ "urls": ["stun:a:1"] }])
        );
    }
}
