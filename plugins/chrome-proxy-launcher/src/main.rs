//! chrome-proxy-launcher —— MultiCC 第一个插件。
//!
//! 给每个「身份」绑定一份完全隔离的 Chrome profile（独立 user-data-dir）
//! 和一个强制出口，一键启动互不串号的浏览器。出口有两种：
//!   - 直连代理：本地 VPN 端口 / 任意 http(s)/socks5（支持账号密码，走本地中继）
//!   - 订阅节点：Clash 订阅里的某个节点，由身份专属 meow 内核承接；可再经
//!     该节点跳板到上游住宅代理（家宽代理的常见链路）
//!
//! 调用约定（Node 通道 src/routes/plugins.js 只做协议桥接，业务全在这里）：
//!   chrome-proxy-launcher <command>    （JSON 从 stdin 读，结果一行 JSON 到 stdout）
//!   成功：{"ok":true,"data":{...}}    失败：{"ok":false,"error":"中文原因"}，退出码 1

mod chrome;
mod dock_badge;
mod browser_session;
mod core;
mod fingerprint;
mod geo;
mod proxy;
mod relay;
mod store;
mod subs;

use serde_json::{json, Value};
use std::io::Read;
use std::thread;
use std::time::{Duration, Instant};

use store::{Profile, ProxyConfig, Subscription, SubscriptionEgress};

fn read_stdin_json() -> Value {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    if text.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(text.trim()).unwrap_or_else(|_| json!({}))
}

/// 本机常见 VPN/代理客户端的出口端口表（detect 用；都是无认证的本地端口）。
const COMMON_PROXY_PORTS: [(u16, &str); 10] = [
    (7897, "Clash 混合端口（http+socks 都收）"),
    (7890, "Clash HTTP"),
    (7891, "Clash SOCKS5"),
    (1080, "SOCKS5 常用"),
    (1086, "SOCKS5"),
    (1087, "HTTP"),
    (10808, "v2ray SOCKS5"),
    (10809, "v2ray HTTP"),
    (8888, "HTTP（Charles）"),
    (8080, "HTTP"),
];

fn get_str(value: &Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn get_bool(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn parse_proxy_input(input: &Value) -> Result<ProxyConfig, String> {
    let raw = input.get("proxy").cloned().unwrap_or_else(|| input.clone());
    let scheme = get_str(&raw, "scheme").to_lowercase();
    let host = get_str(&raw, "host");
    let port = raw.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    store::validate_proxy(&scheme, &host, port)?;
    let optional = |raw: &Value, key: &str| -> Option<String> {
        let value = get_str(raw, key);
        if value.is_empty() { None } else { Some(value) }
    };
    Ok(ProxyConfig {
        scheme,
        host,
        port,
        username: optional(&raw, "username"),
        password: optional(&raw, "password"),
    })
}

/// 解析订阅出口参数（save 与未保存时的 probe 共用）。
fn parse_subscription_egress(input: &Value) -> Result<SubscriptionEgress, String> {
    let raw = input.get("subscription").cloned().unwrap_or_else(|| json!({}));
    let id = get_str(&raw, "id");
    if id.is_empty() {
        return Err("请先选择订阅".into());
    }
    let subscriptions = store::load_subscriptions()?;
    let subscription = subscriptions
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("订阅「{id}」不存在，先刷新订阅列表"))?;
    let node = get_str(&raw, "node");
    if !node.is_empty() && !subscription.nodes.iter().any(|name| name == &node) {
        return Err(format!("订阅里没有节点「{node}」，刷新订阅后再选"));
    }
    let via = match raw.get("via") {
        Some(value) if value.is_object() && !get_str(value, "host").is_empty() => {
            Some(parse_proxy_input(&json!({ "proxy": value }))?)
        }
        _ => None,
    };
    Ok(SubscriptionEgress { id, node, via })
}

/// 解析 save 的出口参数：direct（代理）或 subscription（订阅节点 ± 上游）。
fn parse_egress(input: &Value) -> Result<(Option<ProxyConfig>, Option<SubscriptionEgress>), String> {
    let kind = {
        let raw = get_str(input, "egressType");
        if raw.is_empty() { "direct".to_string() } else { raw }
    };
    match kind.as_str() {
        "direct" => Ok((Some(parse_proxy_input(input)?), None)),
        "subscription" => Ok((None, Some(parse_subscription_egress(input)?))),
        other => Err(format!("未知出口类型「{other}」（可用 direct / subscription）")),
    }
}

fn egress_text(profile: &Profile, subscriptions: &[Subscription]) -> String {
    if let Some(egress) = &profile.subscription {
        let sub_name = subscriptions
            .iter()
            .find(|item| item.id == egress.id)
            .map(|item| item.name.clone())
            .unwrap_or_else(|| egress.id.clone());
        let node = if egress.node.is_empty() { "（第一个节点）" } else { &egress.node };
        let mut text = format!("订阅「{sub_name}」/ {node}");
        if let Some(via) = &egress.via {
            text.push_str(&format!(" → 上游 {}://{}:{}", via.scheme, via.host, via.port));
        }
        text
    } else if let Some(proxy) = &profile.proxy {
        let user = if proxy.has_credentials() {
            format!("{}@", proxy.username.as_deref().unwrap_or(""))
        } else {
            String::new()
        };
        let lock = if proxy.has_credentials() { " 🔑" } else { "" };
        format!("{}://{}{}:{}{}", proxy.scheme, user, proxy.host, proxy.port, lock)
    } else {
        "未配置出口".into()
    }
}

fn profile_with_runtime(profile: Profile, subscriptions: &[Subscription]) -> Value {
    let pid = store::read_pid(&profile.id);
    let running = pid.map(chrome::pid_alive).unwrap_or(false);
    let egress = egress_text(&profile, subscriptions);
    let mut value = serde_json::to_value(&profile).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("egressText".into(), json!(egress));
        map.insert("egressType".into(), json!(if profile.subscription.is_some() { "subscription" } else { "direct" }));
        map.insert("running".into(), json!(running));
        if cfg!(target_os = "macos") { map.insert("dockBadge".into(), dock_badge::appearance(&profile)); }
        let core_port = core::running_port(&profile.id);
        if core_port.is_some() {
            map.insert("corePort".into(), json!(core_port));
        }
        if running {
            map.insert("pid".into(), json!(pid));
        }
    }
    value
}

fn command_detect(_input: &Value) -> Result<Value, String> {
    let browser = chrome::find_browser(None).ok().map(|path| path.display().to_string());
    // 内核是插件自带的，找不到只有一种原因（bin/ 里缺 meow.gz）。
    let core = core::find_core();
    let core_path = core.as_ref().ok().map(|path| path.display().to_string());
    let core_error = core.err();
    let mut handles = Vec::new();
    for (port, label) in COMMON_PROXY_PORTS {
        handles.push(thread::spawn(move || {
            let reachable = proxy::tcp_reachable("127.0.0.1", port, Duration::from_millis(300));
            (port, label, reachable)
        }));
    }
    let mut reachable = Vec::new();
    for handle in handles {
        if let Ok((port, label, ok)) = handle.join() {
            if ok {
                reachable.push(json!({ "port": port, "label": label }));
            }
        }
    }
    Ok(json!({
        "browser": browser,
        "core": core_path,
        "coreError": core_error,
        "proxies": reachable,
    }))
}

fn command_list(_input: &Value) -> Result<Value, String> {
    let subscriptions = store::load_subscriptions()?;
    let profiles = store::load_profiles()?;
    Ok(json!({
        "profiles": profiles.into_iter().map(|p| profile_with_runtime(p, &subscriptions)).collect::<Vec<_>>(),
        "subscriptions": subscriptions,
    }))
}

/// 出口配置的指纹：只用来判断「这次保存是否改了出口」。
fn egress_signature(proxy: &Option<ProxyConfig>, subscription: &Option<SubscriptionEgress>) -> String {
    format!(
        "{}|{}",
        serde_json::to_string(proxy).unwrap_or_default(),
        serde_json::to_string(subscription).unwrap_or_default()
    )
}

/// 收割某个身份名下的内核 / 中继（不动 Chrome 本身）。
/// 出口配置一变就得调用：内核没有空闲自杀，中继也只在 30 分钟无流量后退出，
/// 留着旧进程会让 `egress` 继续复用旧节点 —— 改了出口却不换 IP，正是最坏
/// 的那种「以为换了、其实没换」。
fn drop_runtime(id: &str) {
    chrome::stop_relay_if_any(id);
    core::stop_if_any(id);
}

fn command_save(input: &Value) -> Result<Value, String> {
    let name = get_str(input, "name");
    if name.is_empty() {
        return Err("身份名称不能为空".into());
    }
    let (proxy_config, subscription) = parse_egress(input)?;
    let note = get_str(input, "note");
    let chrome_path = {
        let raw = get_str(input, "chromePath");
        if raw.is_empty() { None } else { Some(raw) }
    };
    let subscriptions = store::load_subscriptions()?;
    let mut profiles = store::load_profiles()?;
    let id = get_str(input, "id");
    let now = store::now_secs();
    if !id.is_empty() {
        // 更新已有身份：id 不动，只刷新内容。
        let existing = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("身份 {id} 不存在"))?;
        let before = egress_signature(&existing.proxy, &existing.subscription);
        existing.name = name;
        existing.proxy = proxy_config;
        existing.subscription = subscription;
        existing.note = note;
        existing.chrome_path = chrome_path;
        existing.updated_at = now;
        let egress_changed = egress_signature(&existing.proxy, &existing.subscription) != before;
        if egress_changed {
            chrome::ensure_not_running(&id)?;
        }
        let snapshot = existing.clone();
        store::save_profiles(&profiles)?;
        if egress_changed {
            drop_runtime(&id);
        }
        return Ok(json!({ "profile": profile_with_runtime(snapshot, &subscriptions) }));
    }
    let new_id = store::allocate_id(&name, &profiles);
    let profile = Profile {
        id: new_id,
        name,
        proxy: proxy_config,
        subscription,
        note,
        chrome_path,
        created_at: now,
        updated_at: now,
    };
    profiles.push(profile.clone());
    store::save_profiles(&profiles)?;
    Ok(json!({ "profile": profile_with_runtime(profile, &subscriptions) }))
}

fn find_profile(profiles: &[Profile], id: &str) -> Result<Profile, String> {
    profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("身份 {id} 不存在"))
}

fn command_remove(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let mut profiles = store::load_profiles()?;
    find_profile(&profiles, &id)?;
    if let Some(pid) = store::read_pid(&id) {
        if !(browser_session::request_stop(&id, pid) && chrome::wait_exit(pid, Duration::from_secs(8))) {
            chrome::quit_gracefully(pid)?;
        }
    }
    store::clear_pid(&id);
    chrome::stop_relay_if_any(&id);
    core::stop_if_any(&id);
    // 隔离 profile 目录（cookie/历史）保留给用户手动清理：自动删几十上百 MB
    // 的目录不可逆，这里宁可少做一步。
    profiles.retain(|p| p.id != id);
    store::save_profiles(&profiles)?;
    dock_badge::clear_cache(&id);
    Ok(json!({ "removed": id }))
}

fn command_launch(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let profiles = store::load_profiles()?;
    let profile = find_profile(&profiles, &id)?;
    let url = get_str(input, "url");
    let check = get_bool(input, "checkProxy", true);
    chrome::launch(&profile, if url.is_empty() { None } else { Some(&url) }, check, get_bool(input, "automaticFingerprint", true))
}

fn command_stop(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let pid = store::read_pid(&id).ok_or_else(|| format!("身份 {id} 没有运行记录"))?;
    if !chrome::pid_alive(pid) {
        store::clear_pid(&id);
        chrome::stop_relay_if_any(&id);
        core::stop_if_any(&id);
        return Ok(json!({ "stopped": false, "reason": "进程已退出" }));
    }
    // 先让 Chrome 正常退出（期间它可能还要经代理收尾），再收中继/内核。
    let quit = if browser_session::request_stop(&id, pid) && chrome::wait_exit(pid, Duration::from_secs(8)) {
        Ok(())
    } else { chrome::quit_gracefully(pid) };
    store::clear_pid(&id);
    chrome::stop_relay_if_any(&id);
    core::stop_if_any(&id);
    quit?;
    Ok(json!({ "stopped": true, "pid": pid }))
}

/// geo 识别优先、纯 IP 探测兜底的统一出口探测：成功时一并带回地理信息
/// （国家/时区/locale，供 UI 核对与 launch 套用），geo 服务不可用时至少
/// 验证出口可用并返回 IP。
///
/// budget 是两段合计的上限：宿主 20s 到点 SIGKILL，不能让 geo 与兜底各吃一份。
fn probe_egress(config: &ProxyConfig, budget: Duration) -> Result<(String, Option<geo::ExitGeo>), String> {
    let deadline = std::time::Instant::now() + budget;
    match geo::detect(config, (budget / 2).min(Duration::from_secs(4))) {
        Ok(found) => Ok((found.ip.clone(), Some(found))),
        Err(_) => {
            // exit_ip 的超时按段（连接、读应答）各算一次，所以再折半。
            let left = deadline.saturating_duration_since(std::time::Instant::now()) / 2;
            if left < Duration::from_millis(500) {
                return Err("测出口超时".into());
            }
            proxy::exit_ip(config, left).map(|ip| (ip, None))
        }
    }
}

fn geo_field(found: &Option<geo::ExitGeo>) -> Value {
    match found {
        Some(geo) => serde_json::to_value(geo).unwrap_or_else(|_| json!({})),
        None => json!({ "identified": false }),
    }
}

/// 经订阅节点取一次出口 IP（geo 识别优先）。身份已在跑就复用它内核的端口，
/// 否则临时起一个测完收掉（allow_running=false 时总是临时起，用于保存前的试连）。
fn probe_via_core(profile_id: &str, egress: &SubscriptionEgress, allow_running: bool) -> Result<(String, Option<geo::ExitGeo>), String> {
    let subscriptions = store::load_subscriptions()?;
    let subscription = subscriptions
        .iter()
        .find(|item| item.id == egress.id)
        .ok_or_else(|| format!("订阅「{}」不存在", egress.id))?;
    let raw = store::read_subscription_config(&egress.id)?;
    let node = if egress.node.is_empty() {
        subscription.nodes.first().cloned().unwrap_or_default()
    } else {
        egress.node.clone()
    };
    let mut temporary_core = false;
    let core_port = match if allow_running { core::running_port(profile_id) } else { None } {
        Some(port) => port,
        None => {
            temporary_core = true;
            core::start(profile_id, &raw, &node)?.mixed_port
        }
    };
    // 有上游时真实出口在中继上（内核只当跳板），所以测中继端口。
    let mut temporary_relay = false;
    let test_port = if let Some(via) = &egress.via {
        let running = if allow_running { store::read_relay(profile_id) } else { None };
        match running {
            Some((pid, port)) if chrome::pid_alive(pid) => port,
            _ => {
                temporary_relay = true;
                let hop = crate::store::ProxyConfig {
                    scheme: "socks5".into(),
                    host: "127.0.0.1".into(),
                    port: core_port,
                    username: None,
                    password: None,
                };
                match chrome::spawn_relay(profile_id, via, Some(hop)) {
                    Ok(port) => port,
                    Err(err) => {
                        // 中继没起来也要收掉刚为这次探测临时起的内核。
                        if temporary_core {
                            core::stop_if_any(profile_id);
                        }
                        return Err(err);
                    }
                }
            }
        }
    } else {
        core_port
    };
    // 内核冷启（≤6s）+ 中继（≤3s）+ 这 8s 仍在宿主 20s 的 SIGKILL 线以内。
    let outcome = probe_egress(&geo::via_local_http(test_port), Duration::from_secs(8));
    if temporary_relay {
        chrome::stop_relay_if_any(profile_id);
    }
    if temporary_core {
        core::stop_if_any(profile_id);
    }
    outcome
}

fn command_probe(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    let profiles = store::load_profiles()?;
    let profile = if id.is_empty() { None } else { Some(find_profile(&profiles, &id)?) };
    let started = Instant::now();
    if let Some(profile) = profile {
        if let Some(egress) = profile.subscription.clone() {
            let (ip, found) = probe_via_core(&profile.id, &egress, true)?;
            let subscriptions = store::load_subscriptions()?;
            return Ok(json!({
                "exitIp": ip,
                "geo": geo_field(&found),
                "via": egress_text(&profile, &subscriptions),
                "latencyMs": started.elapsed().as_millis() as u64,
            }));
        }
        let config = profile.proxy.ok_or_else(|| "这个身份还没有配置出口".to_string())?;
        let (ip, found) = probe_egress(&config, Duration::from_secs(6))?;
        return Ok(json!({
            "exitIp": ip,
            "geo": geo_field(&found),
            "via": format!("{}://{}:{}", config.scheme, config.host, config.port),
            "latencyMs": started.elapsed().as_millis() as u64,
        }));
    }
    // 新建前的试连：订阅出口，或显式传 proxy。
    if input.get("subscription").is_some() {
        let egress = parse_subscription_egress(input)?;
        let (ip, found) = probe_via_core("__probe__", &egress, false)?;
        return Ok(json!({
            "exitIp": ip,
            "geo": geo_field(&found),
            "via": "订阅节点（临时内核）",
            "latencyMs": started.elapsed().as_millis() as u64,
        }));
    }
    let config = parse_proxy_input(input)?;
    let (ip, found) = probe_egress(&config, Duration::from_secs(6))?;
    Ok(json!({
        "exitIp": ip,
        "geo": geo_field(&found),
        "via": format!("{}://{}:{}", config.scheme, config.host, config.port),
        "latencyMs": started.elapsed().as_millis() as u64,
    }))
}

/// `http://127.0.0.1:8080` / `socks5://host:1080` → ProxyConfig（只给 check 用）。
fn parse_proxy_url(url: &str) -> Result<ProxyConfig, String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("出口地址 {url} 缺少协议头"))?;
    let authority = rest.split('/').next().unwrap_or_default();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (
            host.to_string(),
            port.parse::<u16>().map_err(|_| format!("出口地址 {url} 的端口不合法"))?,
        ),
        None => (authority.to_string(), 80),
    };
    let scheme = scheme.to_lowercase();
    store::validate_proxy(&scheme, &host, port)?;
    Ok(ProxyConfig { scheme, host, port, username: None, password: None })
}

/// 给外部调用方（multicc 交给 CPR 的出口钩子）准备一条「现在就可用」的
/// 出口：订阅出口确保内核在跑（有上游再加中继），带凭据直连确保中继在跑，
/// 无凭据直连直接回原地址。返回的 proxyUrl 是标准代理 URL，http 或 socks5。
///
/// 幂等：已在跑的组件复用，不为每次解析重启内核（冷启一次要 1-6 秒）。
/// 出口配置变化时由 save / subscription-refresh 收割旧进程，不靠这里猜。
fn command_egress(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let profiles = store::load_profiles()?;
    let profile = find_profile(&profiles, &id)?;
    let subscriptions = store::load_subscriptions()?;
    let mut result = json!({
        "profileId": id,
        "name": profile.name,
        "egressText": egress_text(&profile, &subscriptions),
        "kind": "direct",
    });
    let proxy_url = if let Some(egress) = &profile.subscription {
        let subscription = subscriptions
            .iter()
            .find(|item| item.id == egress.id)
            .ok_or_else(|| format!("身份「{}」引用的订阅「{}」不存在，先到订阅管理里刷新", profile.name, egress.id))?;
        let raw = store::read_subscription_config(&egress.id)?;
        let node = if egress.node.trim().is_empty() {
            subscription.nodes.first().cloned().unwrap_or_default()
        } else {
            egress.node.clone()
        };
        let core_port = match core::running_port(&id) {
            Some(port) => port,
            None => core::start(&id, &raw, &node)?.mixed_port,
        };
        result["corePort"] = json!(core_port);
        result["node"] = json!(node);
        result["subscription"] = json!(subscription.name);
        match &egress.via {
            Some(via) => {
                let port = match store::read_relay(&id) {
                    Some((pid, port)) if chrome::pid_alive(pid) => port,
                    _ => {
                        let hop = ProxyConfig {
                            scheme: "socks5".into(),
                            host: "127.0.0.1".into(),
                            port: core_port,
                            username: None,
                            password: None,
                        };
                        chrome::spawn_relay(&id, via, Some(hop))?
                    }
                };
                result["relayPort"] = json!(port);
                result["kind"] = json!("relay");
                format!("http://127.0.0.1:{port}")
            }
            None => {
                result["kind"] = json!("core");
                format!("http://127.0.0.1:{core_port}")
            }
        }
    } else if let Some(proxy) = &profile.proxy {
        if proxy.has_credentials() {
            let port = match store::read_relay(&id) {
                Some((pid, port)) if chrome::pid_alive(pid) => port,
                _ => chrome::spawn_relay(&id, proxy, None)?,
            };
            result["relayPort"] = json!(port);
            result["kind"] = json!("relay");
            format!("http://127.0.0.1:{port}")
        } else {
            format!("{}://{}:{}", proxy.scheme, proxy.host, proxy.port)
        }
    } else {
        return Err("这个身份还没有配置出口".into());
    };
    result["proxyUrl"] = json!(proxy_url);
    if get_bool(input, "check", false) {
        // 显式要判据时才测：解析本身要快，不能每次都替调用方多跑一趟外网。
        let config = parse_proxy_url(&proxy_url)?;
        let (ip, found) = probe_egress(&config, Duration::from_secs(8))?;
        result["exitIp"] = json!(ip);
        result["geo"] = geo_field(&found);
    }
    Ok(result)
}

fn command_egress_stop(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    drop_runtime(&id);
    Ok(json!({ "stopped": true, "id": id }))
}

fn allocate_subscription_id(name: &str, existing: &[Subscription]) -> String {
    let base = {
        let slug = store::slugify(name);
        if slug.is_empty() { "sub".to_string() } else { slug.chars().take(30).collect() }
    };
    let taken = |id: &str| existing.iter().any(|item| item.id == id);
    if !taken(&base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("sub-{}", store::now_secs())
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("订阅")
        .to_string()
}

fn command_subscription_save(input: &Value) -> Result<Value, String> {
    let url = get_str(input, "url");
    if url.is_empty() {
        return Err("订阅地址不能为空".into());
    }
    let mut subscriptions = store::load_subscriptions()?;
    let id = get_str(input, "id");
    let name = {
        let raw = get_str(input, "name");
        if raw.is_empty() { host_of(&url) } else { raw }
    };
    // 编辑时只改名（地址没变）就不必重新拉订阅：省一次网络，token 已失效
    // 或机场暂时不通时也能改名。
    if !id.is_empty() {
        if let Some(existing) = subscriptions.iter_mut().find(|item| item.id == id) {
            if existing.url == url {
                existing.name = name;
                let updated = existing.clone();
                store::save_subscriptions(&subscriptions)?;
                return Ok(json!({ "subscription": updated }));
            }
        }
    }
    let fetched = subs::fetch(&url, Duration::from_secs(20))?;
    let now = store::now_secs();
    let bytes = fetched.raw.len() as u64;

    let updated = if !id.is_empty() {
        let existing = subscriptions
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("订阅 {id} 不存在"))?;
        existing.name = name;
        existing.url = url;
        existing.updated_at = now;
        existing.nodes = fetched.nodes.clone();
        existing.traffic = fetched.traffic.clone();
        existing.source_bytes = bytes;
        existing.clone()
    } else {
        let new_id = allocate_subscription_id(&name, &subscriptions);
        let item = Subscription {
            id: new_id,
            name,
            url,
            updated_at: now,
            nodes: fetched.nodes.clone(),
            traffic: fetched.traffic.clone(),
            source_bytes: bytes,
        };
        subscriptions.push(item.clone());
        item
    };
    // 先写配置原文再写清单：清单里登记了它，缓存就必须已经存在。
    store::write_subscription_config(&updated.id, &fetched.raw)?;
    store::save_subscriptions(&subscriptions)?;
    Ok(json!({ "subscription": updated }))
}

fn command_subscription_refresh(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少订阅 id".into());
    }
    let mut subscriptions = store::load_subscriptions()?;
    let url = subscriptions
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.url.clone())
        .ok_or_else(|| format!("订阅 {id} 不存在"))?;
    for profile in store::load_profiles()? {
        if profile.subscription.as_ref().is_some_and(|item| item.id == id) {
            chrome::ensure_not_running(&profile.id)?;
        }
    }
    let fetched = subs::fetch(&url, Duration::from_secs(20))?;
    let now = store::now_secs();
    let bytes = fetched.raw.len() as u64;
    store::write_subscription_config(&id, &fetched.raw)?;
    let updated = {
        let item = subscriptions.iter_mut().find(|item| item.id == id).expect("前面已确认存在");
        item.updated_at = now;
        item.nodes = fetched.nodes.clone();
        item.traffic = fetched.traffic.clone();
        item.source_bytes = bytes;
        item.clone()
    };
    store::save_subscriptions(&subscriptions)?;
    // 配置原文换过了：引用它的身份必须重起内核，否则会一直用旧节点（内核
    // 没有空闲退出）。中继的跳板端口也随内核换，一并收割。
    for profile in store::load_profiles()? {
        if profile.subscription.as_ref().is_some_and(|item| item.id == id) {
            drop_runtime(&profile.id);
        }
    }
    Ok(json!({ "subscription": updated }))
}

fn command_subscription_remove(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少订阅 id".into());
    }
    let profiles = store::load_profiles()?;
    let used: Vec<String> = profiles
        .iter()
        .filter(|p| p.subscription.as_ref().is_some_and(|e| e.id == id))
        .map(|p| p.name.clone())
        .collect();
    if !used.is_empty() {
        return Err(format!("还有身份在用这个订阅（{}），先把它们改成别的出口", used.join("、")));
    }
    let mut subscriptions = store::load_subscriptions()?;
    subscriptions.retain(|item| item.id != id);
    store::save_subscriptions(&subscriptions)?;
    let _ = std::fs::remove_file(store::subscription_config_file(&id));
    Ok(json!({ "removed": id }))
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    store::lock_down();
    let input = read_stdin_json();
    if command == "browser-supervise" { browser_session::supervise(&input); return; }
    let result = match command.as_str() {
        "detect" => command_detect(&input),
        "list" => command_list(&input),
        "save" => command_save(&input),
        "remove" => command_remove(&input),
        "launch" => command_launch(&input),
        "fingerprint-prepare" => {
            let id = get_str(&input, "id");
            store::load_profiles().and_then(|profiles| {
                let profile = profiles.iter().find(|p| p.id == id).ok_or("身份不存在")?;
                fingerprint::prepare(profile)
            })
        },
        "stop" => command_stop(&input),
        "probe" => command_probe(&input),
        "egress" => command_egress(&input),
        "egress-stop" => command_egress_stop(&input),
        "subscription-save" => command_subscription_save(&input),
        "subscription-refresh" => command_subscription_refresh(&input),
        "subscription-remove" => command_subscription_remove(&input),
        // relay 是 launch 拉起的常驻中继：读 stdin 配置后进入服务循环，
        // 正常情况下不会走到输出；走到输出即启动失败。
        "relay" => {
            let id = get_str(&input, "id");
            input
                .get("hop")
                .filter(|value| !value.is_null())
                .map(parse_proxy_input)
                .transpose()
                .and_then(|hop| {
                    parse_proxy_input(&input).and_then(|upstream| {
                        relay::run(&id, &relay::Route { upstream, hop })
                            .map(|_| json!({ "started": true }))
                    })
                })
        }
        _ => Err(format!(
            "未知命令 `{command}`（可用：detect / list / save / remove / launch / stop / probe / fingerprint-prepare / egress / egress-stop / subscription-save / subscription-refresh / subscription-remove / relay）"
        )),
    };
    match result {
        Ok(data) => println!("{}", json!({ "ok": true, "data": data })),
        Err(message) => {
            eprintln!("{message}");
            println!("{}", json!({ "ok": false, "error": message }));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_input_accepts_nested_and_flat() {
        let nested = json!({ "proxy": { "scheme": "socks5", "host": "127.0.0.1", "port": 1080 } });
        assert_eq!(parse_proxy_input(&nested).unwrap().port, 1080);
        let flat = json!({ "scheme": "http", "host": "127.0.0.1", "port": 8080 });
        assert_eq!(parse_proxy_input(&flat).unwrap().port, 8080);
        let bad = json!({ "scheme": "socks5", "host": "", "port": 1080 });
        assert!(parse_proxy_input(&bad).is_err());
    }

    #[test]
    fn parse_proxy_url_reads_scheme_host_port() {
        let http = parse_proxy_url("http://127.0.0.1:41000").unwrap();
        assert_eq!((http.scheme.as_str(), http.host.as_str(), http.port), ("http", "127.0.0.1", 41000));
        let socks = parse_proxy_url("socks5://10.0.0.2:1080").unwrap();
        assert_eq!((socks.scheme.as_str(), socks.port), ("socks5", 1080));
        assert!(parse_proxy_url("127.0.0.1:8080").is_err());
        assert!(parse_proxy_url("http://127.0.0.1:notaport").is_err());
    }

    #[test]
    fn egress_signature_tracks_proxy_and_subscription_changes() {
        let proxy = Some(ProxyConfig::new("http", "127.0.0.1", 7897));
        let base = egress_signature(&proxy, &None);
        assert_eq!(base, egress_signature(&proxy, &None));
        let moved = Some(ProxyConfig::new("http", "127.0.0.1", 7898));
        assert_ne!(base, egress_signature(&moved, &None));
        let sub = Some(SubscriptionEgress { id: "s1".into(), node: "US".into(), via: None });
        assert_ne!(base, egress_signature(&proxy, &sub));
    }

    #[test]
    fn parse_egress_defaults_to_direct_and_rejects_unknown_kind() {
        let direct = json!({ "egressType": "", "proxy": { "scheme": "http", "host": "127.0.0.1", "port": 7897 } });
        let (proxy, subscription) = parse_egress(&direct).unwrap();
        assert_eq!(proxy.unwrap().port, 7897);
        assert!(subscription.is_none());
        let bad = json!({ "egressType": "wireguard", "proxy": { "scheme": "http", "host": "h", "port": 1 } });
        assert!(parse_egress(&bad).unwrap_err().contains("未知出口类型"));
    }
}
