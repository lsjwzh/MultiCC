//! Service-route configuration. One gateway-owned store; publish the new
//! in-memory snapshot only after the atomic disk write succeeds.
use crate::js::{self, JsValue};
use serde_json::{json, Value};
use std::path::PathBuf;
use url::Url;

pub const WARNING: &str = "免密码会让任何能访问 MultiCC 入口的人访问此服务的全部页面、接口及 WebSocket，包括写入和删除操作。路由与 MultiCC 同域，只能接入你信任的服务：其页面脚本可使用当前登录身份访问 MultiCC。鉴权仅保护此入口，不保护上游原始端口。";

pub fn validate(input: &JsValue) -> Result<Value, &'static str> {
    let name = input.get("name").unwrap_or(&JsValue::Undefined);
    let text = js::js_to_string(name).to_string_lossy();
    if text.is_empty()
        || text.len() > 48
        || !text
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || text.starts_with('-')
    {
        return Err("名称限 1–48 位小写字母、数字、连字符");
    }
    let target = js::js_to_string(input.get("target").unwrap_or(&JsValue::Undefined));
    let url = Url::parse(&target.to_string_lossy()).map_err(|_| "请输入有效的 HTTP(S) 上游地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|h| !h.is_empty())
    {
        return Err("上游只支持 HTTP(S)，不能包含凭据、查询或片段");
    }
    let access = input
        .get("access")
        .filter(|v| !v.is_nullish())
        .cloned()
        .unwrap_or(JsValue::string("private"));
    if access != JsValue::string("private") && access != JsValue::string("public") {
        return Err("无效访问模式");
    }
    let mut route = json!({"name": js::to_serde(name), "target": url.as_str().strip_suffix('/').unwrap_or(url.as_str()), "access": js::to_serde(&access), "enabled": input.get("enabled") != Some(&JsValue::Bool(false))});
    if *name == JsValue::Undefined {
        route.as_object_mut().unwrap().remove("name");
    }
    Ok(route)
}

pub struct Store {
    file: PathBuf,
    routes: Vec<Value>,
}

impl Store {
    pub fn load(file: PathBuf) -> Result<Self, String> {
        let routes = match std::fs::read(&file) {
            Ok(bytes) => match js::json_parse(&String::from_utf8_lossy(&bytes))
                .map_err(|_| "Invalid service routes store")?
            {
                JsValue::Array(values) => {
                    values.iter().map(validate).collect::<Result<Vec<_>, _>>()?
                }
                _ => return Err("Invalid service routes store".into()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self { file, routes })
    }

    pub fn list(&self) -> Value {
        json!({"routes": self.routes, "warning": WARNING})
    }

    pub fn find(&self, name: &str) -> Option<Value> {
        self.routes
            .iter()
            .find(|r| r["name"].as_str() == Some(name) && r["enabled"] == true)
            .cloned()
    }

    pub fn update(&mut self, name: &str, route: Option<Value>) -> Result<(), String> {
        let mut next: Vec<_> = self
            .routes
            .iter()
            .filter(|r| r["name"].as_str() != Some(name))
            .cloned()
            .collect();
        if let Some(route) = route {
            next.push(route);
        }
        crate::state_file::write_json_atomic(&self.file, &Value::Array(next.clone()))
            .map_err(|e| e.to_string())?;
        self.routes = next;
        Ok(())
    }
}

/// Match the original case-sensitive raw service path, before asset bypasses.
pub fn proxy_name(path: &str) -> Option<&str> {
    if path == "/services" {
        return Some("");
    }
    Some(
        path.strip_prefix("/services/")?
            .split('/')
            .next()
            .unwrap_or(""),
    )
}

pub fn same_origin_host(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin.filter(|o| !o.is_empty()) else {
        return true;
    };
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let Some(domain) = url.host_str() else {
        return host == Some("");
    };
    let expected = match url.port() {
        Some(port) => format!("{domain}:{port}"),
        None => domain.into(),
    };
    host == Some(expected.as_str())
}

/// URLSearchParams only reserializes a query when it actually removes a token.
pub fn upstream_suffix(original: &str, prefix: &str) -> String {
    let suffix = &original[prefix.len()..];
    let mut suffix = if suffix.is_empty() || suffix.starts_with('?') {
        format!("/{suffix}")
    } else {
        suffix.into()
    };
    if let Some((path, query)) = suffix.split_once('?') {
        let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
        if pairs.iter().any(|(key, _)| key == "token") {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.extend_pairs(pairs.iter().filter(|(key, _)| key != "token"));
            let query = serializer.finish();
            suffix = if query.is_empty() {
                path.into()
            } else {
                format!("{path}?{query}")
            };
        }
    }
    suffix
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_prefix_and_query_do_not_normalize_raw_paths() {
        assert_eq!(proxy_name("/services"), Some(""));
        assert_eq!(proxy_name("/services/app/a%2Fb/../c"), Some("app"));
        assert_eq!(proxy_name("/Services/app/a"), None);
        assert_eq!(proxy_name("/services-other/app"), None);
        assert_eq!(
            upstream_suffix("/services/app?q=a%20b", "/services/app"),
            "/?q=a%20b"
        );
        assert_eq!(
            upstream_suffix(
                "/services/app/x?token=secret&q=a%20b&token=two",
                "/services/app"
            ),
            "/x?q=a+b"
        );
        assert_eq!(
            upstream_suffix("/services/app/x?t%6fken=x", "/services/app"),
            "/x"
        );
    }
    #[test]
    fn origin_matches_url_host_and_preserves_strict_request_host_comparison() {
        assert!(same_origin_host(None, None));
        assert!(same_origin_host(
            Some("https://EXAMPLE.com:443/path"),
            Some("example.com")
        ));
        assert!(!same_origin_host(
            Some("https://example.com"),
            Some("EXAMPLE.com")
        ));
        assert!(same_origin_host(
            Some("http://[::1]:8080"),
            Some("[::1]:8080")
        ));
        assert!(!same_origin_host(Some("null"), Some("localhost")));
        assert!(!same_origin_host(
            Some("http://localhost:81"),
            Some("localhost")
        ));
    }
    #[test]
    fn store_preserves_coercion_and_rolls_back_failed_writes() {
        let root =
            std::env::temp_dir().join(format!("multicc-service-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("service-routes.json");
        std::fs::write(&file, r#"[{"target":"http://localhost"},{"name":123,"target":["http://localhost"]},{"name":"a","target":"http://localhost","enabled":0}]"#).unwrap();
        let mut store = Store::load(file.clone()).unwrap();
        assert!(store.list()["routes"][0].get("name").is_none());
        assert!(store.find("123").is_none());
        assert!(store.find("a").is_some());
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        assert!(store.update("a", None).is_err());
        assert!(store.find("a").is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
