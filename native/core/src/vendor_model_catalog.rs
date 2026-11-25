//! Local CLI catalog formats. Match the vendor text on UTF-16 units so model
//! names, descriptions and length limits agree with the picker on all inputs.
use crate::js::{
    is_js_whitespace_char as space,
    regex::{from_unit_view, to_unit_view, SPACE},
    JsString, JsValue as V,
};
use regex::Regex;
use std::{collections::HashSet, sync::LazyLock};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Vendor {
    Commandcode,
    Codebuddy,
    Grok,
    Qoder,
}

impl Vendor {
    pub fn named(cli: &str) -> Option<Self> {
        Some(match cli {
            "commandcode" => Self::Commandcode,
            "codebuddy" => Self::Codebuddy,
            "grok" => Self::Grok,
            "qoder" => Self::Qoder,
            _ => return None,
        })
    }
    pub fn ttl_ms(self) -> f64 {
        if self == Self::Qoder {
            86_400_000.0
        } else {
            3_600_000.0
        }
    }
    pub fn defaults(self) -> V {
        let values: &[&str] = match self {
            Self::Grok => &["grok-4.6", "grok-4.5"],
            Self::Qoder => &["Auto", "ultimate", "performance", "efficient", "lite"],
            Self::Codebuddy => &[
                "hy4-preview-f",
                "hy3",
                "hy3-x",
                "deepseek-v4.1-flash",
                "glm-5.3",
                "glm-5.3-flash",
                "glm-5.2",
                "glm-5.1",
                "glm-5v-turbo",
                "minimax-m3",
                "minimax-m2.7",
                "kimi-k3-1",
                "kimi-k2.8-preview",
                "kimi-k2.7",
                "kimi-k2.6",
                "deepseek-v4-pro",
            ],
            Self::Commandcode => {
                return V::Array(
                    [
                        ("deepseek/deepseek-v4-flash", "Open Source"),
                        ("deepseek/deepseek-v4-pro", "Open Source"),
                        ("deepseek/deepseek-v4.1-flash", "Open Source"),
                        ("moonshotai/kimi-k3", "Open Source"),
                        ("zai-org/glm-5.3", "Open Source"),
                        ("claude-sonnet-5-5", "Anthropic"),
                        ("claude-opus-5-5", "Anthropic"),
                        ("deepseek/deepseek-flash", "DeepSeek Flash (byok)"),
                    ]
                    .into_iter()
                    .map(|(model, group)| {
                        V::object(vec![("model", model.into()), ("group", group.into())])
                    })
                    .collect(),
                )
            }
        };
        V::Array(values.iter().map(|s| V::from(*s)).collect())
    }
    pub fn parse(self, text: &JsString) -> Listing {
        let units = to_unit_view(text);
        // WorkBuddy historically strips "[...m" even without an ESC.
        let sgr = if self == Self::Codebuddy {
            &*BARE_SGR
        } else {
            &*SGR
        };
        let clean = sgr.replace_all(&units, "");
        let models = match self {
            Self::Commandcode => commandcode(&clean),
            Self::Qoder => qoder(&clean),
            Self::Grok => grok(&clean),
            Self::Codebuddy => codebuddy(&clean),
        };
        Listing {
            models,
            authenticated: self != Self::Grok || !NOT_AUTHENTICATED.is_match(&clean),
        }
    }
}

pub struct Listing {
    pub models: Vec<V>,
    pub authenticated: bool,
}

static SGR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
static BARE_SGR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[0-9;]*m").unwrap());
static MODEL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$").unwrap());
static COMMANDCODE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}[A-Za-z0-9._/-]$").unwrap());
static COMMANDCODE_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([^{SPACE}]+)[{SPACE}]{{2,}}([^{SPACE}][^\r\n\x{{2028}}\x{{2029}}]*)$"
    ))
    .unwrap()
});
static QODER_COLUMNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[{SPACE}]{{2,}}|\t")).unwrap());
static SUPPORTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i-u:currently supported:)[{SPACE}]*\(([^)]*)\)"
    ))
    .unwrap()
});
static AVAILABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{SPACE}]*(?i-u:available models)[{SPACE}]*:")).unwrap()
});
static GROK_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[{SPACE}]*[*-][{SPACE}]+([^{SPACE}]+)")).unwrap());
static NOT_AUTHENTICATED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:not authenticated)").unwrap());

fn row(model: &str, extra: Vec<(&str, V)>) -> V {
    let id = V::String(from_unit_view(model));
    let mut fields = vec![("model", id.clone()), ("label", id)];
    fields.extend(extra);
    V::object(fields)
}
fn codebuddy(text: &str) -> Vec<V> {
    let Some(caps) = SUPPORTED.captures(text) else {
        return vec![];
    };
    let mut seen = HashSet::new();
    caps[1]
        .split(',')
        .map(|model| model.trim_matches(space))
        .filter(|model| MODEL_ID.is_match(model) && seen.insert(*model))
        .take(200)
        .map(|model| row(model, vec![]))
        .collect()
}
fn qoder(text: &str) -> Vec<V> {
    let mut seen = HashSet::new();
    text.split('\n')
        .map(|s| s.trim_matches(space))
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("model"))
        .map(|s| {
            QODER_COLUMNS
                .find(s)
                .map_or(s, |m| &s[..m.start()])
                .trim_matches(space)
        })
        .filter(|s| !s.is_empty() && s.chars().count() <= 120 && seen.insert(*s))
        .take(200)
        .map(|model| row(model, vec![]))
        .collect()
}
fn grok(text: &str) -> Vec<V> {
    let mut seen = HashSet::new();
    let mut in_list = false;
    let mut out = vec![];
    for line in text.split('\n') {
        if AVAILABLE.is_match(line) {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        if let Some(cap) = GROK_ROW.captures(line) {
            let id = cap.get(1).unwrap().as_str();
            if MODEL_ID.is_match(id) && seen.insert(id) {
                out.push(row(
                    id,
                    vec![(
                        "isDefault",
                        V::Bool(line.to_ascii_lowercase().contains("(default)")),
                    )],
                ));
                if out.len() == 100 {
                    break;
                }
            }
        }
    }
    out
}
fn commandcode(text: &str) -> Vec<V> {
    let lines: Vec<_> = text
        .split('\n')
        .map(|s| s.trim_end_matches(space))
        .collect();
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        let title = lines[i].trim_start_matches(space);
        if title.is_empty()
            || COMMANDCODE_ROW.is_match(title)
            || !lines[i + 1].is_empty()
            || !COMMANDCODE_ROW.is_match(lines[i + 2])
        {
            i += 1;
            continue;
        }
        let excluded = title.to_ascii_lowercase().contains("headless only");
        i += 2;
        while i < lines.len() && !lines[i].is_empty() {
            let line = lines[i].trim_start_matches(space);
            i += 1;
            if excluded {
                continue;
            }
            if let Some(c) = COMMANDCODE_ROW.captures(line) {
                let id = c.get(1).unwrap().as_str();
                if COMMANDCODE_ID.is_match(id) && seen.insert(id) {
                    out.push(row(
                        id,
                        vec![
                            ("group", V::String(from_unit_view(title))),
                            (
                                "description",
                                V::String(from_unit_view(c[2].trim_matches(space))),
                            ),
                        ],
                    ));
                    if out.len() == 400 {
                        return out;
                    }
                }
            }
        }
        i += 1;
    }
    out
}
