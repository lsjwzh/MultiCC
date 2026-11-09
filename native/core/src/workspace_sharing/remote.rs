//! Remote request/response policy shared by the temporary addon and gateway.
use super::*;
use reqwest::Url;

pub fn normalize_url(value: &V) -> Result<V> {
    let mut url = Url::parse(js::string::js_trim(&or_text(value)))
        .map_err(|_| Error::new("INVALID_SHARE_URL", "分享链接无效", 400))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::new(
            "INVALID_SHARE_URL",
            "分享链接只支持 HTTP 或 HTTPS",
            400,
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::new(
            "INVALID_SHARE_URL",
            "分享链接不能包含登录凭据",
            400,
        ));
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let token = path
        .strip_prefix("/fleet-share/")
        .or_else(|| {
            path.strip_prefix("/api/fleet-shares/")?
                .strip_suffix("/import")
        })
        .unwrap_or("")
        .to_owned();
    if !token_valid(&V::string(&token)) {
        return Err(Error::new("INVALID_SHARE_URL", "分享链接格式无效", 400));
    }
    url.set_path(&format!("/api/fleet-shares/{token}/import"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(V::object(vec![
        ("token", V::string(&token)),
        ("apiUrl", V::string(url.as_str())),
        ("origin", V::string(&url.origin().ascii_serialization())),
        ("hostname", V::string(url.host_str().unwrap_or(""))),
    ]))
}

/// Preserve the legacy public helper; transport also checks parsed IPv6 mapped
/// addresses so hexadecimal mappings cannot bypass the link-local restriction.
pub fn blocked_address(value: &V) -> bool {
    let value = or_text(value).to_lowercase();
    if value.is_empty() {
        return true;
    }
    if value.contains(':') {
        if value == "::"
            || ["fe8", "fe9", "fea", "feb", "ff"]
                .iter()
                .any(|p| value.starts_with(p))
        {
            return true;
        }
        return value
            .strip_prefix("::ffff:")
            .filter(|v| {
                let parts: Vec<_> = v.split('.').collect();
                parts.len() == 4
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            })
            .is_some_and(|v| blocked_address(&V::string(v)));
    }
    let parts: Vec<f64> = value.split('.').map(|v| number(&V::string(v))).collect();
    parts.len() != 4
        || parts
            .iter()
            .any(|v| !v.is_finite() || v.fract() != 0.0 || !(0.0..=255.0).contains(v))
        || parts[0] == 0.0
        || (parts[0] == 169.0 && parts[1] == 254.0)
        || parts[0] >= 224.0
}
fn or<'a>(a: &'a V, b: &'a V) -> &'a V {
    if truth(a) {
        a
    } else {
        b
    }
}
fn code(value: &V, fallback: &str) -> V {
    let value = clean(value, 96, "");
    let s = text(&value);
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        value
    } else {
        V::string(fallback)
    }
}
fn optional(value: V) -> V {
    if truth(&value) {
        value
    } else {
        V::Null
    }
}

pub fn remote_error(
    payload: &V,
    status: u16,
    default_code: &str,
    message: &str,
    scope: &str,
    request_id: &V,
    correlation: &V,
) -> Error {
    let nested = object(get(payload, "error"));
    let field = |key| or(get(payload, key), get(&nested, key));
    let upstream_code = code(field("code"), "");
    let msg_value = if matches!(get(payload, "error"), V::String(_)) {
        get(payload, "error")
    } else {
        field("message")
    };
    let msg = clean(msg_value, 1000, message);
    let retryable = if matches!(get(payload, "retryable"), V::Bool(_)) {
        get(payload, "retryable").clone()
    } else if matches!(get(&nested, "retryable"), V::Bool(_)) {
        get(&nested, "retryable").clone()
    } else {
        V::Bool([408, 425, 429, 500, 502, 503, 504, 529].contains(&status))
    };
    let mut error = Error::new(
        &text(or(&upstream_code, &V::string(default_code))),
        &text(&msg),
        status,
    )
    .meta(V::object(vec![
        ("category", code(field("category"), "remote")),
        (
            "detail",
            or(&clean(field("detail"), 1000, ""), &msg).clone(),
        ),
        ("retryable", retryable),
        (
            "action",
            code(
                field("action"),
                if status == 401 || status == 403 {
                    "login"
                } else {
                    "retry"
                },
            ),
        ),
        ("scope", code(field("scope"), scope)),
        (
            "causeCode",
            if truth(&upstream_code) {
                V::string(default_code)
            } else {
                V::Null
            },
        ),
        (
            "upstreamRequestId",
            optional(clean(or(request_id, field("requestId")), 160, "")),
        ),
        (
            "correlationId",
            optional(clean(or(correlation, field("correlationId")), 160, "")),
        ),
    ]));
    if let V::String(message) = msg {
        error.message = message;
    }
    error
}

pub fn connection_error(code: &str, message: &str, correlation: &V) -> Error {
    Error::new(code, message, 502).meta(V::object(vec![
        ("category", V::string("remote")),
        ("detail", V::string(message)),
        ("retryable", true.into()),
        ("action", V::string("retry")),
        ("scope", V::string("request")),
        (
            "causeCode",
            if code == "REMOTE_UNAVAILABLE" {
                V::Null
            } else {
                V::string("REMOTE_UNAVAILABLE")
            },
        ),
        ("correlationId", optional(clean(correlation, 160, ""))),
    ]))
}

#[derive(Clone)]
pub struct Plan {
    pub kind: String,
    pub url: Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub correlation: V,
}
impl Plan {
    pub fn new(input: &V) -> Result<Self> {
        let kind = text(get(input, "kind"));
        let request = get(input, "request");
        let context = get(input, "context");
        let record = get(input, "record");
        let mut headers = vec![];
        let (url, method, body, correlation) = if kind == "import" {
            let password = password(get(request, "password"))?;
            let parsed = normalize_url(get(request, "shareUrl"))?;
            headers.push(("accept".into(), "application/json".into()));
            headers.push(("content-type".into(), "application/json".into()));
            (
                Url::parse(&text(get(&parsed, "apiUrl"))).unwrap(),
                "POST".into(),
                Some(
                    js::json_stringify(&V::object(vec![("password", V::string(&password))]))
                        .unwrap()
                        .into_bytes(),
                ),
                get(context, "correlationId").clone(),
            )
        } else {
            let origin = text(get(record, "sourceOrigin"));
            let base = Url::parse(&format!("{origin}/")).map_err(|_| invalid_path())?;
            let token = or_text(get(record, "token"));
            let (path, method, body, request_headers) = match kind.as_str() {
                "refresh" => (
                    format!("/api/fleet-shares/{token}/state"),
                    "GET".into(),
                    None,
                    V::object(vec![
                        ("accept", V::string("application/json")),
                        ("x-correlation-id", get(context, "correlationId").clone()),
                    ]),
                ),
                "ticket" => (
                    format!("/api/fleet-shares/{token}/ws-ticket"),
                    "POST".into(),
                    Some(js::json_stringify(request).unwrap_or_default().into_bytes()),
                    V::object(vec![
                        ("accept", V::string("application/json")),
                        ("content-type", V::string("application/json")),
                        ("x-correlation-id", get(context, "correlationId").clone()),
                    ]),
                ),
                "proxy" => (
                    or_text(get(request, "pathname")),
                    if matches!(get(request, "method"), V::Undefined) {
                        "GET".into()
                    } else {
                        text(get(request, "method"))
                    },
                    None,
                    object(get(request, "headers")),
                ),
                _ => return Err(invalid_path()),
            };
            let url = base.join(&path).map_err(|_| invalid_path())?;
            if url.origin().ascii_serialization() != origin
                || !url.path().starts_with("/api/")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid_path());
            }
            headers.push((
                "accept".into(),
                clean_string(get(&request_headers, "accept"), 200, "application/json"),
            ));
            if truth(get(&request_headers, "content-type")) {
                headers.push((
                    "content-type".into(),
                    clean_string(get(&request_headers, "content-type"), 200, ""),
                ));
            }
            headers.push(("x-multicc-fleet-token".into(), token));
            headers.push(("x-multicc-fleet-grant".into(), text(get(record, "grant"))));
            (
                url,
                method,
                body,
                get(&request_headers, "x-correlation-id").clone(),
            )
        };
        if truth(&correlation) {
            headers.push((
                "x-correlation-id".into(),
                clean_string(&correlation, 160, ""),
            ));
        }
        Ok(Self {
            kind,
            url,
            method,
            headers,
            body,
            correlation,
        })
    }
    pub fn limit(&self) -> usize {
        if self.kind == "import" {
            MAX_REMOTE_BODY_BYTES
        } else {
            MAX_PROXY_BODY_BYTES
        }
    }
    pub fn too_large(&self) -> Error {
        Error::new(
            "REMOTE_RESPONSE_TOO_LARGE",
            if self.kind == "import" {
                "远端工作区数据过大"
            } else {
                "共享工作区响应过大"
            },
            502,
        )
    }
    pub fn unreadable(&self) -> Error {
        Error::new(
            "INVALID_REMOTE_RESPONSE",
            if self.kind == "import" {
                "无法读取远端工作区数据"
            } else {
                "无法读取共享工作区响应"
            },
            502,
        )
    }
    pub fn complete(&self, status: u16, headers: &V, bytes: &[u8]) -> Result<V> {
        if (300..400).contains(&status) {
            return Err(Error::new(
                "REMOTE_REDIRECT_REJECTED",
                if self.kind == "import" {
                    "分享来源返回了不安全的重定向"
                } else {
                    "共享工作区返回了不安全的重定向"
                },
                502,
            ));
        }
        if bytes.len() > self.limit() {
            return Err(self.too_large());
        }
        let request_id = if self.kind == "import" {
            or(
                &clean(get(headers, "x-multicc-request-id"), 160, ""),
                &clean(get(headers, "x-request-id"), 160, ""),
            )
            .clone()
        } else {
            clean(
                or(
                    get(headers, "x-multicc-request-id"),
                    get(headers, "x-request-id"),
                ),
                160,
                "",
            )
        };
        let correlation = clean(get(headers, "x-correlation-id"), 160, "");
        if self.kind == "proxy" {
            return Ok(V::object(vec![
                ("status", V::Number(status.into())),
                ("contentType", clean(get(headers, "content-type"), 200, "")),
                (
                    "cacheControl",
                    clean(get(headers, "cache-control"), 200, ""),
                ),
                ("upstreamRequestId", optional(request_id)),
                ("correlationId", optional(correlation)),
            ]));
        }
        let s = String::from_utf8_lossy(bytes);
        // Fetch text() removes a leading BOM; Buffer.toString() does not.
        let s = if self.kind == "import" {
            s.strip_prefix('\u{feff}').unwrap_or(&s)
        } else {
            &s
        };
        let payload = match js::json_parse(s) {
            Ok(payload) => payload,
            Err(_) if self.kind == "import" && !(200..300).contains(&status) => V::Object(vec![]),
            Err(_) => {
                return Err(Error::new(
                    "INVALID_REMOTE_RESPONSE",
                    match self.kind.as_str() {
                        "import" => "远端返回了无效数据",
                        "ticket" => "远端返回了无效的 WebSocket 凭证",
                        _ => "远端返回了无效的工作区数据",
                    },
                    502,
                ))
            }
        };
        let success = match self.kind.as_str() {
            "import" => (200..300).contains(&status),
            "ticket" => {
                status == 200
                    && matches!(get(&payload, "ticket"), V::String(_))
                    && matches!(get(&payload, "wsOrigin"), V::String(_))
            }
            _ => status == 200,
        };
        if !success {
            let (code, msg) = match self.kind.as_str() {
                "ticket" => ("REMOTE_WS_TICKET_FAILED", "无法创建远端 WebSocket 凭证"),
                "refresh" => ("REMOTE_UNAVAILABLE", "无法刷新共享工作区"),
                _ => match status {
                    403 => ("WRONG_PASSWORD", "密码错误"),
                    404 => ("SHARE_NOT_FOUND", "分享不存在或已失效"),
                    410 => ("SHARE_EXHAUSTED", "分享访问次数已用完"),
                    429 => ("SHARE_RATE_LIMITED", "尝试过于频繁，请稍后再试"),
                    _ => ("REMOTE_UNAVAILABLE", "分享来源暂时不可用"),
                },
            };
            return Err(remote_error(
                &payload,
                if status == 200 { 502 } else { status },
                code,
                msg,
                if self.kind == "ticket" {
                    "session"
                } else {
                    "request"
                },
                &request_id,
                or(&correlation, &self.correlation),
            ));
        }
        Ok(payload)
    }
}
fn invalid_path() -> Error {
    Error::new("INVALID_REMOTE_PATH", "远端工作区请求路径无效", 400)
}
