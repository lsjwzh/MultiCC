use super::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/outbound-proxy-cases.json"
    ))
    .expect("outbound proxy corpus")
}

fn env_of(value: &Value) -> Env {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn system_of(value: &Value) -> SystemProxy {
    serde_json::from_value(value.clone()).expect("system proxy")
}

fn url_of(text: &str) -> Url {
    Url::parse(text).expect("corpus URL")
}

#[test]
fn parses_scutil_text_variants() {
    let fixture = fixture();
    for case in fixture["parse"].as_array().unwrap() {
        let parsed = parse_mac_system_proxy(case["text"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            case["expected"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn cidr_ranges_match_the_javascript() {
    let fixture = fixture();
    for case in fixture["cidr"].as_array().unwrap() {
        assert_eq!(
            cidr_to_range(case["entry"].as_str().unwrap()),
            case["expected"].as_str().map(str::to_string),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn bypass_rules_match_the_javascript() {
    let fixture = fixture();
    for case in fixture["bypass"].as_array().unwrap() {
        let entries: Vec<String> = case["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            bypass_proxy(&url_of(case["url"].as_str().unwrap()), &entries),
            case["expected"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn resolution_matches_the_javascript() {
    let fixture = fixture();
    for case in fixture["resolve"].as_array().unwrap() {
        let system = system_of(&case["system"]);
        let env = env_of(&case["env"]);
        match resolve_proxy_config(&env, Some(&system)) {
            Ok(config) => {
                assert!(
                    case["error"].as_bool() != Some(true),
                    "{}: Rust resolved but JavaScript threw",
                    case["name"]
                );
                assert_eq!(
                    serde_json::json!({
                        "httpProxy": config.http_proxy,
                        "httpsProxy": config.https_proxy,
                        "noProxy": config.no_proxy,
                        "mode": config.mode,
                    }),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
            Err(_) => assert_eq!(
                case["error"].as_bool(),
                Some(true),
                "{}: JavaScript resolved but Rust threw",
                case["name"]
            ),
        }
    }
}

#[test]
fn proxy_choice_matches_the_javascript() {
    let fixture = fixture();
    for case in fixture["proxy"].as_array().unwrap() {
        let url = url_of(case["url"].as_str().unwrap());
        let host = url.host_str().unwrap_or("");
        let answer = if is_loopback(host) {
            Ok(String::new())
        } else {
            resolve_proxy_config(&env_of(&case["env"]), Some(&system_of(&case["system"])))
                .map(|config| proxy_of(&config, &url))
        };
        match answer {
            Ok(proxy) => assert_eq!(
                Some(proxy.as_str()),
                case["expected"].as_str(),
                "{}",
                case["name"]
            ),
            Err(_) => assert_eq!(
                case["error"].as_bool(),
                Some(true),
                "{}: JavaScript resolved but Rust threw",
                case["name"]
            ),
        }
    }
}

fn read_scripted(reads: &mut usize, systems: &[Value]) -> Result<SystemProxy, ProxyError> {
    let scripted = systems.get(*reads);
    *reads += 1;
    match scripted {
        Some(value) if value["error"].as_bool() == Some(true) => Err(ProxyError("scutil failed")),
        Some(value) => Ok(system_of(value)),
        None => Err(ProxyError("no scripted system proxy")),
    }
}

#[test]
fn system_cache_ttl_and_error_handling_match_the_javascript() {
    let fixture = fixture();
    for case in fixture["cache"].as_array().unwrap() {
        let env = env_of(&case["env"]);
        let systems: Vec<Value> = case["systems"].as_array().unwrap().clone();
        let mut cache = Cache {
            slot: SystemSlot::default(),
            refresh_ms: case["refreshMs"].as_i64().unwrap(),
        };
        let mut reads = 0usize;
        let mut proxies: Vec<Option<String>> = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            let now = step["now"].as_i64().unwrap();
            let url = url_of(step["url"].as_str().unwrap());
            if is_loopback(url.host_str().unwrap_or("")) {
                proxies.push(Some(String::new()));
                continue;
            }
            let answer =
                cache.configuration(&env, "darwin", now, || read_scripted(&mut reads, &systems));
            proxies.push(answer.ok().map(|config| proxy_of(&config, &url)));
        }
        let expected = &case["expected"];
        assert_eq!(
            reads,
            expected["reads"].as_u64().unwrap() as usize,
            "{}: scutil reads",
            case["name"]
        );
        assert_eq!(
            proxies,
            expected["proxies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>(),
            "{}: proxies",
            case["name"]
        );
    }
}
