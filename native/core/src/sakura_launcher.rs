use crate::js::{is_js_whitespace, JsString};
use regex::Regex;
use std::sync::LazyLock;
const PATTERNS: [(&str, &str, &str); 4] = [
    (
        "流量已耗尽",
        "traffic_exhausted",
        "SakuraFrp 流量耗尽（签到或购买流量后重启隧道）",
    ),
    (
        "登录节点失败",
        "node_login_failed",
        "frpc 登录节点失败（检查网络或更换节点）",
    ),
    (
        r"隧道[^\r\n\x{2028}\x{2029}]{0,12}(不存在|已删除)|(?:不存在|已删除)[^\r\n\x{2028}\x{2029}]{0,8}隧道",
        "tunnel_missing",
        "隧道不存在或已被删除",
    ),
    (
        "登录失败",
        "login_failed",
        "SakuraFrp 登录失败（API 不可达或访问密钥失效）",
    ),
];
pub fn diagnosis(content: &JsString) -> Option<(&'static str, &'static str, JsString)> {
    static SKIP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            "由于出现严重错误|frpc 已退出|日志记录|初始化|开始登录|登录成功|开始加载隧道配置",
        )
        .unwrap()
    });
    static RULES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        PATTERNS
            .iter()
            .map(|(r, _, _)| Regex::new(r).unwrap())
            .collect()
    });
    static TIME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?").unwrap()
    });
    for raw in content.as_units().rsplit(|&c| c == 10).take(399) {
        let line = JsString::from_units(raw.to_vec()).trim();
        // JS's original regex has no u flag; its bounds count UTF-16 units.
        let searchable: String = line
            .as_units()
            .iter()
            .map(|&c| char::from_u32(c.into()).unwrap_or('\u{fffd}'))
            .collect();
        if searchable.is_empty() || SKIP.is_match(&searchable) {
            continue;
        }
        if let Some(index) = RULES.iter().position(|re| re.is_match(&searchable)) {
            let mut start = 0;
            if let Some(m) = TIME.find(&searchable) {
                start = m.end();
                while start < line.len() && is_js_whitespace(line.as_units()[start]) {
                    start += 1;
                }
            }
            let (_, code, reason) = PATTERNS[index];
            return Some((
                code,
                reason,
                line.slice_units(start, (start + 240).min(line.len())),
            ));
        }
    }
    None
}
