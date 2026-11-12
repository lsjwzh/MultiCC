//! npm registry discovery and the upstream-version request state machine.
//! Transport adapters only execute the current request and feed response facts.
use crate::js::{js_to_number, js_to_string, json_parse, truthy, JsString, JsValue as J};
use futures_util::StreamExt;
use regex::Regex;
use std::{
    fs,
    sync::{LazyLock, OnceLock},
    time::Duration,
};

pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";
pub const FALLBACK_REGISTRY: &str = "https://registry.npmmirror.com/";
pub const FETCH_TIMEOUT_MS: f64 = 8000.0;
const MAX_BODY_UNITS: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 3;
static SEMVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+)\.([0-9]+)\.([0-9]+)(?:([-+][0-9A-Za-z.-]+))?$").unwrap()
});
// The host supplies its already-loaded public roots once. Do not discover a
// second trust store in Rust or silently adopt environment proxy settings.
static TLS_ROOTS: OnceLock<Vec<String>> = OnceLock::new();
fn get<'a>(v: &'a J, key: &str) -> &'a J {
    v.get(key).unwrap_or(&J::Undefined)
}
fn text(v: &J) -> JsString {
    if v.is_nullish() {
        JsString::new()
    } else {
        js_to_string(v)
    }
}
fn obj(entries: Vec<(&str, J)>) -> J {
    J::object(entries)
}
fn selected<'a>(a: &'a J, b: &'a J) -> &'a J {
    if truthy(a) {
        a
    } else {
        b
    }
}
fn without_v(value: JsString) -> JsString {
    if value.code_unit_at(0) == Some(b'v' as u16) {
        value.slice_units(1, value.len())
    } else {
        value
    }
}

pub fn parse_semver(value: &J) -> Option<([f64; 3], bool)> {
    let raw = without_v(text(value).trim()).to_string_lossy();
    let matched = SEMVER.captures(&raw)?;
    Some((
        [
            matched[1].parse().ok()?,
            matched[2].parse().ok()?,
            matched[3].parse().ok()?,
        ],
        matched.get(4).is_some(),
    ))
}
pub fn compare_semver(left: &J, right: &J) -> f64 {
    let (Some((a, ap)), Some((b, bp))) = (parse_semver(left), parse_semver(right)) else {
        return 0.0;
    };
    for i in 0..3 {
        if a[i] != b[i] {
            return a[i] - b[i];
        }
    }
    if ap == bp {
        0.0
    } else if ap {
        -1.0
    } else {
        1.0
    }
}
pub fn normalized_version(value: &J) -> J {
    if parse_semver(value).is_some() {
        J::String(without_v(js_to_string(value)))
    } else {
        J::Null
    }
}
pub fn normalize_registry(value: &J) -> J {
    let mut raw = text(value).trim();
    let prefix = raw.truncate_units(8).to_string_lossy().to_ascii_lowercase();
    if !prefix.starts_with("http://") && !prefix.starts_with("https://") {
        return J::Null;
    }
    if raw.as_units().last() != Some(&(b'/' as u16)) {
        raw.push_str("/");
    }
    J::String(raw)
}
fn npmrc_path(input: &J) -> Option<String> {
    let env = get(input, "env");
    let options = get(input, "options");
    let explicit = selected(
        get(options, "npmrcPath"),
        selected(
            get(env, "NPM_CONFIG_USERCONFIG"),
            get(env, "npm_config_userconfig"),
        ),
    );
    let value = selected(explicit, get(input, "defaultNpmrcPath"));
    // Node readFileSync rejects non-path values; it does not String() them.
    match value {
        J::String(path) => Some(path.to_string_lossy()),
        _ => None,
    }
}
pub fn npmrc_registry(contents: &str) -> J {
    for line in contents.split('\n') {
        let line = crate::js::js_trim(line);
        if line.len() < 8
            || !line
                .get(..8)
                .is_some_and(|s| s.eq_ignore_ascii_case("registry"))
        {
            continue;
        }
        let suffix = line[8..].trim_start_matches(crate::js::is_js_whitespace_char);
        let Some(value) = suffix.strip_prefix('=') else {
            continue;
        };
        let value = crate::js::js_trim(value);
        if value.is_empty() || value.contains(['\r', '\u{2028}', '\u{2029}']) {
            continue;
        }
        let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
        let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
        let normalized = normalize_registry(&J::string(value));
        if !normalized.is_nullish() {
            return normalized;
        }
    }
    J::Null
}
fn read_npmrc(input: &J) -> J {
    npmrc_path(input)
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| npmrc_registry(&String::from_utf8_lossy(&bytes)))
        .unwrap_or(J::Null)
}
fn registry_base(input: &J) -> J {
    let env = get(input, "env");
    let value = normalize_registry(selected(
        get(env, "npm_config_registry"),
        get(env, "NPM_CONFIG_REGISTRY"),
    ));
    if truthy(&value) {
        return value;
    }
    let file = read_npmrc(input);
    if truthy(&file) {
        file
    } else {
        J::string(DEFAULT_REGISTRY)
    }
}
fn registry_candidates(input: &J) -> Vec<J> {
    let raw = get(get(input, "env"), "MULTICC_CLI_REGISTRY_FALLBACKS");
    let fallbacks = if raw.is_nullish() {
        vec![J::string(FALLBACK_REGISTRY)]
    } else {
        js_to_string(raw)
            .as_units()
            .split(|u| *u == b',' as u16)
            .map(|units| J::String(JsString::from_units(units.to_vec()).trim()))
            .collect()
    };
    let mut out = vec![registry_base(input)];
    for candidate in fallbacks {
        let candidate = normalize_registry(&candidate);
        if truthy(&candidate) && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}
pub fn latest_url(pkg: &J, registry: &J) -> JsString {
    let pkg = js_to_string(pkg);
    let mut out = js_to_string(registry);
    if let Some(index) = pkg.as_units().iter().position(|u| *u == b'/' as u16) {
        out.push(&pkg.slice_units(0, index));
        out.push_str("%2f");
        out.push(&pkg.slice_units(index + 1, pkg.len()));
    } else {
        out.push(&pkg);
    }
    out.push_str("/latest");
    out
}
pub fn request(operation: &str, input: &J) -> J {
    match operation {
        "constants" => obj(vec![
            ("DEFAULT_REGISTRY", J::string(DEFAULT_REGISTRY)),
            (
                "FALLBACK_REGISTRIES",
                J::Array(vec![J::string(FALLBACK_REGISTRY)]),
            ),
            ("FETCH_TIMEOUT_MS", J::Number(FETCH_TIMEOUT_MS)),
        ]),
        "registryNeedsHome" => {
            let env = get(input, "env");
            let from_env = normalize_registry(selected(
                get(env, "npm_config_registry"),
                get(env, "NPM_CONFIG_REGISTRY"),
            ));
            if !truthy(get(input, "forceRead")) && truthy(&from_env) {
                return J::Bool(false);
            }
            let explicit = selected(
                get(get(input, "options"), "npmrcPath"),
                selected(
                    get(env, "NPM_CONFIG_USERCONFIG"),
                    get(env, "npm_config_userconfig"),
                ),
            );
            J::Bool(!truthy(explicit))
        }
        "fetchNeedsRegistry" => {
            J::Bool(truthy(get(input, "pkg")) && !truthy(get(input, "registryBase")))
        }
        "parseSemver" => parse_semver(get(input, "value"))
            .map(|(parts, pre)| {
                obj(vec![
                    (
                        "parts",
                        J::Array(parts.into_iter().map(J::Number).collect()),
                    ),
                    ("prerelease", J::Bool(pre)),
                ])
            })
            .unwrap_or(J::Null),
        "compareSemver" => J::Number(compare_semver(get(input, "left"), get(input, "right"))),
        "classifyUpdate" => {
            let current = normalized_version(get(input, "installed"));
            let latest = normalized_version(get(input, "latest"));
            let available =
                truthy(&current) && truthy(&latest) && compare_semver(&current, &latest) < 0.0;
            obj(vec![
                ("latest", latest),
                ("updateAvailable", J::Bool(available)),
            ])
        }
        "normalizeRegistry" => normalize_registry(get(input, "value")),
        "readNpmrcRegistry" => read_npmrc(input),
        "resolveRegistryBase" => registry_base(input),
        "resolveRegistryCandidates" => J::Array(registry_candidates(input)),
        "latestUrl" => J::String(latest_url(get(input, "pkg"), get(input, "registryBase"))),
        "npmPackageFor" => {
            let key = js_to_string(selected(get(input, "cli"), &J::string("")))
                .trim()
                .to_lowercase()
                .to_string_lossy();
            let value = get(get(input, "packages"), &key);
            if truthy(value) {
                value.clone()
            } else {
                J::Null
            }
        }
        "configureTransport" => {
            if let J::Array(roots) = get(input, "roots") {
                let _ = TLS_ROOTS.set(
                    roots
                        .iter()
                        .filter_map(|root| match root {
                            J::String(text) => Some(text.to_string_lossy()),
                            _ => None,
                        })
                        .collect(),
                );
            }
            J::Bool(TLS_ROOTS.get().is_some())
        }
        _ => J::Undefined,
    }
}

/// Owns fallback ordering, redirect budget, response acceptance and UTF-16 cap.
/// The injected Node transport and production Rust transport share this owner.
pub struct Fetch {
    package: J,
    bases: Vec<J>,
    base_index: usize,
    url: JsString,
    redirects_left: usize,
    timeout: J,
    body: JsString,
    reading: bool,
    result: Option<J>,
}
impl Fetch {
    pub fn new(input: &J) -> Self {
        let package = get(input, "pkg").clone();
        let explicit = get(input, "registryBase");
        let bases = if !truthy(&package) {
            vec![]
        } else if truthy(explicit) {
            vec![explicit.clone()]
        } else {
            registry_candidates(input)
        };
        let timeout = match get(input, "timeoutMs") {
            J::Undefined => J::Number(FETCH_TIMEOUT_MS),
            value => value.clone(),
        };
        let url = bases
            .first()
            .map(|base| latest_url(&package, base))
            .unwrap_or_default();
        Self {
            package,
            bases,
            base_index: 0,
            url,
            redirects_left: MAX_REDIRECTS,
            timeout,
            body: JsString::new(),
            reading: false,
            result: None,
        }
    }
    pub fn empty_result() -> J {
        obj(vec![("version", J::Null), ("registry", J::Null)])
    }
    pub fn plan(&self) -> J {
        if let Some(result) = &self.result {
            return obj(vec![("done", J::Bool(true)), ("result", result.clone())]);
        }
        if self.base_index >= self.bases.len() {
            return obj(vec![
                ("done", J::Bool(true)),
                ("result", Self::empty_result()),
            ]);
        }
        obj(vec![
            ("done", J::Bool(false)),
            ("url", J::String(self.url.clone())),
            (
                "options",
                obj(vec![
                    (
                        "headers",
                        obj(vec![
                            ("User-Agent", J::string("multicc-cli-version-check/1.0")),
                            ("Accept", J::string("application/json")),
                        ]),
                    ),
                    ("timeout", self.timeout.clone()),
                ]),
            ),
        ])
    }
    pub fn fail(&mut self) {
        if self.result.is_some() {
            return;
        }
        self.base_index += 1;
        self.redirects_left = MAX_REDIRECTS;
        self.reading = false;
        self.body = JsString::new();
        if let Some(base) = self.bases.get(self.base_index) {
            self.url = latest_url(&self.package, base);
        }
    }
    pub fn response(&mut self, status: f64, location: &J) -> bool {
        self.body = JsString::new();
        self.reading = false;
        if self.result.is_some() || self.base_index >= self.bases.len() {
            return false;
        }
        if (300.0..400.0).contains(&status) && truthy(location) {
            let target = url::Url::parse(&self.url.to_string_lossy())
                .ok()
                .and_then(|base| base.join(&js_to_string(location).to_string_lossy()).ok());
            if self.redirects_left == 0 || target.is_none() {
                self.fail();
                return false;
            }
            self.redirects_left -= 1;
            self.url = JsString::from_rust_str(target.unwrap().as_str());
            return false;
        }
        if status != 200.0 {
            self.fail();
            return false;
        }
        self.reading = true;
        true
    }
    pub fn chunk(&mut self, chunk: &JsString) -> bool {
        if !self.reading {
            return false;
        }
        if self.body.len().saturating_add(chunk.len()) > MAX_BODY_UNITS {
            self.fail();
            return false;
        }
        self.body.push(chunk);
        true
    }
    pub fn end(&mut self) {
        if !self.reading {
            return;
        }
        self.reading = false;
        let parsed = json_parse(&self.body.to_string_lossy()).ok();
        let version = parsed
            .as_ref()
            .and_then(|parsed| match get(parsed, "version") {
                J::String(v) => Some(without_v(v.trim())),
                _ => None,
            });
        if let Some(version) = version.filter(|v| SEMVER.is_match(&v.to_string_lossy())) {
            self.result = Some(obj(vec![
                ("version", J::String(version)),
                ("registry", self.bases[self.base_index].clone()),
            ]));
        } else {
            self.fail();
        }
    }
    pub fn input(&mut self, operation: &str, value: &J) -> J {
        match operation {
            "plan" => self.plan(),
            "response" => {
                J::Bool(self.response(js_to_number(get(value, "status")), get(value, "location")))
            }
            "chunk" => J::Bool(self.chunk(&js_to_string(value))),
            "end" => {
                self.end();
                J::Undefined
            }
            "fail" => {
                self.fail();
                J::Undefined
            }
            _ => J::Undefined,
        }
    }
}

/// Node's StringDecoder retains an incomplete UTF-8 suffix between chunks.
/// Decode incrementally so the body budget counts UTF-16 units, not bytes and
/// not U+FFFD inserted merely because a network chunk split a Chinese character.
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}
impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8], final_chunk: bool) -> JsString {
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        let mut text = String::new();
        while consumed < self.pending.len() {
            let remaining = &self.pending[consumed..];
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    text.push_str(valid);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(std::str::from_utf8(&remaining[..valid]).unwrap());
                    consumed += valid;
                    match error.error_len() {
                        Some(size) => {
                            text.push('\u{fffd}');
                            consumed += size;
                        }
                        None if final_chunk => {
                            text.push('\u{fffd}');
                            consumed = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        JsString::from_rust_str(&text)
    }
}
fn client(timeout: &J) -> Option<reqwest::Client> {
    // https.get rejects negative/non-numeric timeout values. Zero disables it.
    let J::Number(ms) = timeout else {
        return None;
    };
    if !ms.is_finite() || *ms < 0.0 {
        return None;
    }
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .redirect(reqwest::redirect::Policy::none())
        .tls_built_in_root_certs(false);
    if *ms > 0.0 {
        let timeout = Duration::from_secs_f64((*ms / 1000.0).min(u32::MAX as f64));
        builder = builder.read_timeout(timeout).connect_timeout(timeout);
    }
    for pem in TLS_ROOTS.get()? {
        let cert = reqwest::Certificate::from_pem(pem.as_bytes()).ok()?;
        builder = builder.add_root_certificate(cert);
    }
    builder.build().ok()
}
pub async fn fetch(input: &J) -> J {
    let mut state = Fetch::new(input);
    if state.bases.is_empty() {
        return Fetch::empty_result();
    }
    let Some(client) = client(&state.timeout) else {
        return Fetch::empty_result();
    };
    while state.result.is_none() && state.base_index < state.bases.len() {
        let response = client
            .get(state.url.to_string_lossy())
            .header("User-Agent", "multicc-cli-version-check/1.0")
            .header("Accept", "application/json")
            .send()
            .await;
        let Ok(response) = response else {
            state.fail();
            continue;
        };
        let location = response
            .headers()
            .get("location")
            .map(|v| {
                J::string(
                    &v.as_bytes()
                        .iter()
                        .map(|byte| char::from(*byte))
                        .collect::<String>(),
                )
            })
            .unwrap_or(J::Null);
        if !state.response(response.status().as_u16() as f64, &location) {
            continue;
        }
        let mut body = response.bytes_stream();
        let mut decoder = Utf8Decoder::default();
        let mut failed = false;
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => {
                    if !state.chunk(&decoder.push(&chunk, false)) {
                        failed = true;
                        break;
                    }
                }
                Err(_) => {
                    state.fail();
                    failed = true;
                    break;
                }
            }
        }
        if !failed && state.chunk(&decoder.push(&[], true)) {
            state.end();
        }
    }
    state.result.unwrap_or_else(Fetch::empty_result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_preserves_js_number_difference_and_build_suffix() {
        assert_eq!(
            compare_semver(&J::string("3.0.0"), &J::string("1.0.0")),
            2.0
        );
        assert_eq!(
            compare_semver(&J::string("1.0.0+build"), &J::string("1.0.0")),
            -1.0
        );
        assert!(parse_semver(&J::string("\u{feff}v1.2.3\u{feff}")).is_some());
        assert!(parse_semver(&J::string("١.2.3")).is_none());
    }
    #[test]
    fn decoder_retains_split_characters_and_counts_utf16() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.push(&[0xe4], false).len(), 0);
        assert_eq!(
            decoder.push(&[0xb8, 0xad], false),
            JsString::from_rust_str("中")
        );
        assert_eq!(decoder.push("😀".as_bytes(), false).len(), 2);
        assert_eq!(decoder.push(&[0xe4], true), JsString::from_rust_str("�"));
    }
    #[test]
    fn redirects_and_failures_advance_only_the_native_state() {
        let mut state = Fetch::new(&obj(vec![
            ("pkg", J::string("x")),
            ("registryBase", J::string(DEFAULT_REGISTRY)),
        ]));
        for _ in 0..3 {
            assert!(!state.response(302.0, &J::string("/next")));
        }
        assert!(!state.response(302.0, &J::string("/next")));
        assert_eq!(get(&state.plan(), "done"), &J::Bool(true));
    }
    #[test]
    fn response_budget_is_utf16_not_utf8_bytes() {
        let mut state = Fetch::new(&obj(vec![
            ("pkg", J::string("x")),
            ("registryBase", J::string(DEFAULT_REGISTRY)),
        ]));
        assert!(state.response(200.0, &J::Null));
        assert!(state.chunk(&JsString::from_rust_str(&format!(
            "{{\"version\":\"1.2.3\",\"padding\":\"{}\"}}",
            "中".repeat(100_000)
        ))));
        state.end();
        assert_eq!(
            get(get(&state.plan(), "result"), "version"),
            &J::string("1.2.3")
        );
    }
    #[test]
    fn npmrc_quotes_and_invalid_first_entry_match_npm_contract() {
        assert_eq!(
            npmrc_registry("registry=file:/bad\n\u{feff}REGISTRY = 'https://mirror.example/'\n"),
            J::string("https://mirror.example/")
        );
    }
}
