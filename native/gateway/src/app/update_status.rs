//! Read the durable update log written by the source manager or standalone installer.
//! A compatibility host also owns a short-lived pre-spawn flag and serves its own reads.
use super::{express, App};
use axum::{body::Body, http::Response};
use multicc_core::js::{self, regex::from_unit_view, regex::to_unit_view, JsString, JsValue as V};
use regex::Regex;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const TAIL: usize = 8192;
const START: &str = "__MULTICC_UPDATE_START__";
const PLAN: &str = "__MULTICC_UPDATE_PLAN__ ";
const STEP: &str = "__MULTICC_UPDATE_STEP__ ";
const DEFAULT_PLAN: [&str; 7] = [
    "deps", "check", "fetch", "install", "verify", "restart", "ready",
];
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]*$").unwrap());
static START_RE: LazyLock<Regex> = LazyLock::new(|| {
    let space = js::regex::SPACE;
    Regex::new(&format!(
        r"{START} ([^{space}]+) force=([0-9])(?: target=([^{space}]*))?"
    ))
    .unwrap()
});
static STEP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^__MULTICC_UPDATE_STEP__ ([a-z][a-z0-9-]*) (start|done|skip|progress) ([0-9]+)(?: (.*))?$").unwrap()
});
static EXIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"__MULTICC_UPDATE_EXIT__ ([0-9]+)\n?").unwrap());
static PERCENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]{1,3})%").unwrap());
const EOL: [char; 4] = ['\r', '\n', '\u{2028}', '\u{2029}'];

fn switch_on(name: &str) -> bool {
    let value = std::env::var(name).unwrap_or_default();
    matches!(
        js::js_trim(&value).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn location(package: &Path) -> (PathBuf, &'static str) {
    // The daemon already resolved its working directory before building App.
    if !switch_on("MULTICC_DESKTOP") {
        return (package.join("logs/update.log"), "git");
    }
    let resources = package.parent().unwrap_or(package);
    let runtime = if cfg!(windows) {
        "runtime/node.exe"
    } else {
        "runtime/bin/node"
    };
    if !switch_on("MULTICC_DESKTOP_SHELL")
        && std::env::var_os("ELECTRON_RUN_AS_NODE").is_none_or(|v| v.is_empty())
        && resources.join("launcher/standalone-cli.js").is_file()
        && resources.join(runtime).is_file()
    {
        let data = std::env::var("MULTICC_DATA_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|d| PathBuf::from(super::download::resolve(&package.to_string_lossy(), &d)))
            .unwrap_or_else(|| resources.parent().unwrap_or(resources).to_owned());
        return (data.join("logs/update.log"), "standalone");
    }
    (package.join("logs/update.log"), "desktop")
}

struct Step<'a> {
    id: &'a str,
    state: &'static str,
    start: V,
    end: V,
    note: V,
    progress: V,
}

impl Step<'_> {
    fn json(self) -> V {
        V::object(vec![
            ("id", self.id.into()),
            ("state", self.state.into()),
            ("startedAt", self.start),
            ("endedAt", self.end),
            ("note", self.note),
            ("progress", self.progress),
        ])
    }
}

fn steps(text: &str) -> Option<V> {
    let plan = text
        .split(EOL)
        .filter_map(|l| l.strip_prefix(PLAN))
        .find(|s| !s.is_empty());
    let ids = plan
        .map(|s| {
            s.split(js::is_js_whitespace_char)
                .filter(|s| ID.is_match(s))
                .take(12)
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_PLAN.to_vec());
    let mut steps = Vec::<Step>::new();
    for id in ids {
        if !steps.iter().any(|s| s.id == id) {
            steps.push(Step {
                id,
                state: "pending",
                start: V::Null,
                end: V::Null,
                note: V::Null,
                progress: V::Null,
            });
        }
    }
    for line in text.split(EOL).filter(|l| l.starts_with(STEP)) {
        let Some(m) = STEP_RE.captures(line) else {
            continue;
        };
        let Some(s) = steps.iter_mut().find(|s| s.id == &m[1]) else {
            continue;
        };
        let note = m.get(4).map(|s| s.as_str()).filter(|s| !s.is_empty());
        let short_note = note.map(|s| V::String(JsString::from(js::js_trim(s)).truncate_units(80)));
        if &m[2] == "progress" {
            if let (Some(text), Some(raw)) = (short_note, note.filter(|_| s.state == "running")) {
                let percent = PERCENT.captures(raw).map_or(V::Null, |n| {
                    V::Number(n[1].parse::<f64>().unwrap().min(100.))
                });
                s.progress = V::object(vec![("text", text), ("percent", percent)]);
            }
            continue;
        }
        let timestamp = m[3].parse::<f64>().ok()? * 1000.;
        let at = V::from(js::date_to_iso_string(timestamp)?);
        if &m[2] == "start" {
            s.state = "running";
            s.start = at;
        } else {
            s.state = if &m[2] == "done" { "done" } else { "skipped" };
            if s.start == V::Null {
                s.start = at.clone();
            }
            s.end = at;
            s.progress = V::Null;
        }
        if let Some(note) = short_note {
            s.note = note;
        }
    }
    Some(V::Array(steps.into_iter().map(Step::json).collect()))
}

// The manager emits LF. Old logs may also contain progress frames separated by CR.
// JavaScript's multiline anchors recognize four line terminators but the regex
// consumes an optional LF only, leaving the other separators in the visible tail.
fn without_lines(text: &str, mut remove: impl FnMut(&str) -> bool) -> String {
    let mut out = String::new();
    for piece in text.split_inclusive(EOL) {
        let line = piece.strip_suffix(EOL).unwrap_or(piece);
        if remove(line) {
            if !piece.ends_with('\n') {
                out.push_str(&piece[line.len()..]);
            }
        } else {
            out.push_str(piece);
        }
    }
    out
}

fn tail(text: &str) -> V {
    let mut saw_start = false;
    let text = without_lines(text, |l| {
        let first = !saw_start && l.starts_with(START);
        saw_start |= first;
        first
    });
    let text = EXIT.replace_all(&text, "");
    let text = without_lines(&text, |l| l.starts_with(STEP) || l.starts_with(PLAN));
    let collapsed = text
        .split('\n')
        .map(|l| {
            l.rsplit('\r')
                .find(|s| !js::js_trim(s).is_empty())
                .unwrap_or("")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = from_unit_view(js::js_trim(&collapsed));
    V::String(text.slice_units(text.len().saturating_sub(TAIL), text.len()))
}

fn status(path: &Path, kind: &str) -> V {
    let log_path = V::from(path.to_string_lossy().as_ref());
    let Ok(stat) = fs::metadata(path) else {
        return V::object(vec![
            ("state", "idle".into()),
            ("running", false.into()),
            ("exitCode", V::Null),
            ("startedAt", V::Null),
            ("updatedAt", V::Null),
            ("force", false.into()),
            ("steps", V::Array(vec![])),
            ("tail", "".into()),
            ("logPath", log_path),
            ("scheduled", false.into()),
            ("kind", kind.into()),
        ]);
    };
    let bytes = fs::read(path).ok();
    let mut text = bytes.as_deref().map(String::from_utf8_lossy);
    let full_steps = text.as_deref().and_then(steps).unwrap_or_else(|| {
        text = None;
        V::Array(vec![])
    });
    // Only the display window needs a UTF-16 copy of the log.
    let text = text.as_deref().unwrap_or("");
    let start = text.floor_char_boundary(text.len().saturating_sub(4 * TAIL * 4));
    let utf16 = JsString::from(&text[start..]);
    let window =
        to_unit_view(&utf16.slice_units(utf16.len().saturating_sub(4 * TAIL), utf16.len()));
    // The JS reader also parses the visible window by itself. When it has
    // lost the custom plan, an invalid timestamp in a default step makes
    // the route fall back to the short "unknown" response.
    if utf16.len() > 4 * TAIL && steps(&window).is_none() {
        return V::object(vec![
            ("state", "unknown".into()),
            ("running", false.into()),
            ("exitCode", V::Null),
            ("tail", "".into()),
            ("scheduled", false.into()),
            ("kind", kind.into()),
        ]);
    }
    let start = START_RE.captures(&window);
    let field = |i| {
        start
            .as_ref()
            .and_then(|m| m.get(i))
            .filter(|m| !m.is_empty())
            .map_or(V::Null, |m| V::String(from_unit_view(m.as_str())))
    };
    let exit = EXIT
        .captures_iter(&window)
        .last()
        .and_then(|m| m[1].parse::<f64>().ok());
    let mtime = super::download::file_stat(&stat).mtime_ms;
    let silent = (chrono::Utc::now().timestamp_millis() as f64 - mtime).max(0.);
    let state = match exit {
        Some(0.) => "succeeded",
        Some(_) => "failed",
        None if silent > 900_000. => "stale",
        None => "running",
    };
    let mut fields = vec![
        ("state", state.into()),
        ("running", (state == "running").into()),
        ("exitCode", exit.map_or(V::Null, V::Number)),
        ("startedAt", field(1)),
        ("updatedAt", V::Date(mtime)),
        ("force", (field(2) == "1".into()).into()),
        ("targetVersion", field(3)),
        ("steps", full_steps),
    ];
    if exit.is_none() {
        fields.push(("silentMs", V::Number(silent)));
    }
    fields.extend([
        ("tail", tail(&window)),
        ("logPath", log_path),
        ("scheduled", false.into()),
        ("kind", kind.into()),
    ]);
    V::object(fields)
}

pub(super) async fn read(app: &App, ctx: &express::RequestCtx) -> Response<Body> {
    let root = app.package_root.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let (path, kind) = location(&root);
        js::json_stringify(&status(&path, kind))
            .expect("update status object")
            .into_bytes()
    })
    .await;
    match bytes {
        Ok(body) => express::send(ctx, 200, "application/json; charset=utf-8", body, &[]),
        Err(_) => express::error(ctx, 500, "could not read update status"),
    }
}
