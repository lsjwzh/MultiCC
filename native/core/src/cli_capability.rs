//! The independent facts about a CLI, in one table — the authoritative copy.
//!
//! Two tables live here, and everything else is derived from them:
//!
//! * [`CAPABILITIES`] — how a lane runs:
//!   - `protocol`  how the child frames its conversation with the host;
//!   - `lifecycle` whether that child outlives the turn it was started for;
//!   - `cancel`    how stopping a turn stops the lane: `process` (the turn IS the
//!     child; cancelling reaps it) or `turn` (the turn is interrupted in place,
//!     the child survives).
//!
//!   Only entries that differ from [`DEFAULT_CAPABILITY`] are listed, so an
//!   unknown or newly added CLI behaves exactly like the non-claude CLIs always
//!   have.
//!
//! * [`CLIS`] — the CLI catalogue, keyed by **family**. A CLI is a family first
//!   and a lane second: `claude` is ONE CLI, which in chat is the resident Agent
//!   SDK lane and in a terminal is the `claude` command itself. Family level says
//!   what is said once about the product (name, brand colour, collapsed-chip
//!   mark, whether it owns its account/model config, its own install artifact);
//!   each lane says what a session *kind* (`chat` / `terminal`) presents
//!   differently (label, engine line, mark, whether pickers offer it, whether its
//!   engine ships inside MultiCC, whether it is on its way out).
//!
//!   2026-09-26：两条常驻车道扶正为产品名，两条一次性车道退出 chat，终端大字照实写
//!   命令所属的产品。
//!
//!   ```text
//!   家族     场景      车道        大字      小字
//!   claude   chat      claude      Claude    Claude Agent SDK  （bundled）
//!            terminal  claude      Claude    claude
//!   codex    chat      codex-exp   Codex     Codex App Server
//!            chat      codex       Codex     codex exec        （offered: false）
//!            terminal  codex       Codex     codex
//!   opencode chat      opencode    OpenCode  opencode acp
//!            terminal  opencode    OpenCode  opencode
//!   ```
//!
//!   Claude's chat lane is the resident Agent SDK; the old `claude -p` one-shot
//!   chat lane was deleted, so the terminal keeps the `claude` executable and
//!   chat speaks the same id. `codex` is still `codex exec` and only lost its
//!   chat seat; codex-exp is the resident app-server lane. claude-exp no longer
//!   exists as a lane — it is an accepted **alias** of `claude` ([`ALIASES`]), so
//!   persisted sessions keep resolving while no picker offers it again.
//!   ACP families write ` acp` on their chat lane: the same executable is driven
//!   by the ACP bridge in chat and runs itself in a terminal.
//!
//!   The `update` artifact is a **family** fact, never a lane one: both of
//!   codex's lanes run the same binary behind the same install script, and the
//!   Claude Agent SDK has no artifact of its own at all (its engine is a library
//!   MultiCC requires), so it is marked `bundled` instead.
//!
//! The server reads one frozen snapshot of all of this ([`catalog`]) through
//! `src/cli/cli-capability.js`. The web (`public/provider-catalog.js`) and the
//! app (`app/lib/utils/cli_display.dart`) mirror the catalogue;
//! `tests/test-cli-display-parity.js` fails when an id, a name, a mark, a
//! colour, the providerless flag or the deprecation plan drifts. Add a CLI here
//! first, then mirror it — an id this table does not know falls back to its own
//! raw id everywhere, never to a neighbour's name.
use serde_json::{json, Map, Value};

pub const KINDS: [&str; 2] = ["chat", "terminal"];
/// Neutral grey, only for a CLI the table has never heard of.
pub const DEFAULT_COLOUR: &str = "#8b949e";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capability {
    pub protocol: &'static str,
    pub lifecycle: &'static str,
    pub cancel: &'static str,
}

pub const DEFAULT_CAPABILITY: Capability = Capability {
    protocol: "cli-once",
    lifecycle: "per-turn",
    cancel: "process",
};

const fn cap(protocol: &'static str, lifecycle: &'static str, cancel: &'static str) -> Capability {
    Capability {
        protocol,
        lifecycle,
        cancel,
    }
}

pub const CAPABILITIES: &[(&str, Capability)] = &[
    // Claude chat is the resident Agent SDK lane now (the old `claude -p`
    // chat lane was deleted). The SDK lane interrupts the in-flight turn and
    // keeps its child, so a session is stopped as soon as no turn runs — not
    // when the process goes. `claude-exp` is only an alias of this row.
    ("claude", cap("claude-stream-sdk", "resident", "turn")),
    ("codex", cap("codex-exec-json", "per-turn", "process")),
    // `codex app-server --listen stdio://` is long-lived and the bridge holds it
    // across turns (`--resident`). The thread survives a reap, so cancel and
    // recycle re-attach rather than losing the conversation.
    ("codex-exp", cap("codex-app-server", "resident", "process")),
    // `zcode.cjs app-server` keeps its native session and run_in_background
    // work alive across turns; cancel stops the child, the session resumes by id.
    ("zcode", cap("zcode-app-server", "resident", "process")),
    // ACP is a per-turn local agent protocol: the bridge spawns the agent for
    // the turn and exits with it. opencode, gemini and grok share it.
    ("opencode", cap("acp", "per-turn", "process")),
    ("gemini", cap("acp", "per-turn", "process")),
    ("pi", cap("pi-json", "per-turn", "process")),
    (
        "commandcode",
        cap("command-code-json", "per-turn", "process"),
    ),
    ("grok", cap("acp", "per-turn", "process")),
];

/// Which upstream API dialect a CLI's protocol talks. Deliberately not the
/// transport name: an ACP agent holds its own credential and dialect, so it
/// answers no family rather than a guess.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolFamily {
    Anthropic,
    OpenAi,
    Acp,
    Unknown,
}

const PROTOCOL_FAMILIES: &[(&str, ProtocolFamily)] = &[
    ("claude", ProtocolFamily::Anthropic),
    ("codex", ProtocolFamily::OpenAi),
    ("codex-exp", ProtocolFamily::OpenAi),
    ("opencode", ProtocolFamily::Acp),
    ("gemini", ProtocolFamily::Acp),
    ("grok", ProtocolFamily::Acp),
    ("commandcode", ProtocolFamily::Unknown),
    ("pi", ProtocolFamily::Unknown),
];

#[derive(Clone, Copy, Debug)]
pub struct Lane {
    pub id: &'static str,
    pub label: Option<&'static str>,
    pub mark: Option<&'static str>,
    pub engine: Option<&'static str>,
    /// Policy, not capability: whether this kind's pickers offer the lane.
    pub offered: bool,
    /// The lane's engine ships inside MultiCC, not in the family's artifact.
    pub bundled: bool,
    /// Still works in this kind but is on its way out; only with `replaced_by`.
    pub deprecated: bool,
    pub replaced_by: Option<&'static str>,
}

const LANE: Lane = Lane {
    id: "",
    label: None,
    mark: None,
    engine: None,
    offered: true,
    bundled: false,
    deprecated: false,
    replaced_by: None,
};

#[derive(Clone, Copy, Debug)]
pub struct Update {
    /// npm package its published version is read from (absent: no comparable source).
    pub package: Option<&'static str>,
    /// Official install/upgrade command (absent: no script).
    pub command: Option<&'static str>,
    /// What to tell the user instead when there is no command.
    pub manual: Option<&'static str>,
}

#[derive(Clone, Copy, Debug)]
pub struct Family {
    pub id: &'static str,
    pub name: &'static str,
    pub colour: Option<&'static str>,
    pub mark: Option<&'static str>,
    /// The CLI owns its account/model config: no multicc provider binds to it.
    pub providerless: bool,
    pub update: Option<Update>,
    /// `None`: the family is its own single lane in both kinds. Otherwise the
    /// lanes per kind; a kind it does not list offers nothing.
    pub lanes: Option<&'static [(&'static str, &'static [Lane])]>,
}

const FAMILY: Family = Family {
    id: "",
    name: "",
    colour: None,
    mark: None,
    providerless: false,
    update: None,
    lanes: None,
};

const fn npm(package: &'static str, command: &'static str) -> Option<Update> {
    Some(Update {
        package: Some(package),
        command: Some(command),
        manual: None,
    })
}

pub const CLIS: &[Family] = &[
    Family {
        id: "claude",
        name: "Claude",
        colour: Some("#ff9a76"),
        update: npm(
            "@anthropic-ai/claude-code",
            "npm install -g @anthropic-ai/claude-code",
        ),
        lanes: Some(&[
            // Chat runs the resident Agent SDK; terminal runs the `claude`
            // executable. One id, two kinds — the old `claude -p` chat lane is
            // gone and `claude-exp` is now only an alias of this id.
            (
                "chat",
                &[Lane {
                    id: "claude",
                    engine: Some("Claude Agent SDK"),
                    bundled: true,
                    ..LANE
                }],
            ),
            // 终端跑的就是 `claude` 这个可执行文件，大字与家族同名。
            (
                "terminal",
                &[Lane {
                    id: "claude",
                    mark: Some("C"),
                    engine: Some("claude"),
                    ..LANE
                }],
            ),
        ]),
        ..FAMILY
    },
    Family {
        id: "codex",
        name: "Codex",
        colour: Some("#20a66a"),
        // codex 走官方安装脚本, 不走 npm 全局: `@openai/codex` 的平台二进制是
        // optionalDependency, 下载超时会被 npm 静默丢弃而整条命令仍 exit 0。官方脚本
        // 单一归档、sha256 校验、set -eu 非零退出、版本化目录 + current 软链原子切换。
        update: Some(Update {
            package: Some("@openai/codex"),
            command: Some("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
            manual: None,
        }),
        lanes: Some(&[
            (
                "chat",
                &[
                    Lane {
                        id: "codex-exp",
                        mark: Some("X"),
                        engine: Some("Codex App Server"),
                        ..LANE
                    },
                    // 计划淘汰只写在 chat 这条：chat 那半条路已经交给 codex-exp；终端上它
                    // 仍是本来的 codex 命令。
                    Lane {
                        id: "codex",
                        engine: Some("codex exec"),
                        offered: false,
                        deprecated: true,
                        replaced_by: Some("codex-exp"),
                        ..LANE
                    },
                ],
            ),
            (
                "terminal",
                &[Lane {
                    id: "codex",
                    mark: Some("E"),
                    engine: Some("codex"),
                    ..LANE
                }],
            ),
        ]),
        ..FAMILY
    },
    Family {
        id: "opencode",
        name: "OpenCode",
        colour: Some("#388bfd"),
        mark: Some("O"),
        update: npm("opencode-ai", "npm install -g opencode-ai"),
        lanes: Some(&[
            (
                "chat",
                &[Lane {
                    id: "opencode",
                    engine: Some("opencode acp"),
                    ..LANE
                }],
            ),
            (
                "terminal",
                &[Lane {
                    id: "opencode",
                    ..LANE
                }],
            ),
        ]),
        ..FAMILY
    },
    Family {
        id: "zcode",
        name: "ZCode",
        colour: Some("#a371f7"),
        mark: Some("Z"),
        // 协议是 zcode-app-server（常驻），但它没有官方 CLI 安装脚本：CLI 在桌面版里。
        update: Some(Update {
            package: None,
            command: None,
            manual: Some("ZCode 暂无官方 CLI 安装脚本, 请从官网 https://zcode.z.ai 下载安装 ZCode 桌面版(其内置 CLI)"),
        }),
        ..FAMILY
    },
    Family {
        id: "qoder",
        name: "Qoder CN",
        colour: Some("#ff8a3d"),
        mark: Some("Q"),
        providerless: true,
        // curl 脚本安装，没有可比对的 npm 发布源。
        update: Some(Update {
            package: None,
            command: Some("curl -fsSL https://qoder.cn/install | bash"),
            manual: None,
        }),
        ..FAMILY
    },
    Family {
        id: "kimi",
        name: "Kimi Code",
        colour: Some("#13c2c2"),
        mark: Some("K"),
        update: npm("@moonshot-ai/kimi-code", "npm install -g @moonshot-ai/kimi-code"),
        ..FAMILY
    },
    Family {
        id: "codebuddy",
        name: "WorkBuddy",
        colour: Some("#0052d9"),
        mark: Some("W"),
        providerless: true,
        update: npm(
            "@tencent-ai/codebuddy-code",
            "npm install -g @tencent-ai/codebuddy-code",
        ),
        ..FAMILY
    },
    Family {
        id: "dsh",
        name: "DSH",
        colour: Some("#4d6bfe"),
        mark: Some("D"),
        // 2026-10-15 起接入 Anthropic 协议线路池（DEEPSEEK_BASE_URL 实测遵守），
        // 不再 providerless；自有账号登录仍保留为默认选项。
        update: npm("@deepseek-ai/dsh", "npm install -g @deepseek-ai/dsh"),
        ..FAMILY
    },
    Family {
        id: "gemini",
        name: "Gemini",
        colour: Some("#4285f4"),
        mark: Some("G"),
        providerless: true,
        update: npm("@google/gemini-cli", "npm install -g @google/gemini-cli"),
        lanes: Some(&[
            (
                "chat",
                &[Lane {
                    id: "gemini",
                    engine: Some("gemini acp"),
                    ..LANE
                }],
            ),
            ("terminal", &[Lane { id: "gemini", ..LANE }]),
        ]),
    },
    Family {
        id: "pi",
        name: "Pi",
        colour: Some("#8b5cf6"),
        mark: Some("P"),
        // Pi owns its provider/model configuration and authentication locally.
        providerless: true,
        update: npm(
            "@earendil-works/pi-coding-agent",
            "npm install -g @earendil-works/pi-coding-agent",
        ),
        lanes: Some(&[
            (
                "chat",
                &[Lane {
                    id: "pi",
                    engine: Some("pi --mode json"),
                    ..LANE
                }],
            ),
            ("terminal", &[Lane { id: "pi", ..LANE }]),
        ]),
    },
    Family {
        id: "commandcode",
        name: "Command Code",
        colour: Some("#a599e9"),
        mark: Some("⌘"),
        providerless: true,
        update: npm("command-code", "npm install -g command-code"),
        lanes: Some(&[
            (
                "chat",
                &[Lane {
                    id: "commandcode",
                    engine: Some("command-code -p --output-format json"),
                    ..LANE
                }],
            ),
            (
                "terminal",
                &[Lane {
                    id: "commandcode",
                    engine: Some("command-code"),
                    ..LANE
                }],
            ),
        ]),
    },
    Family {
        id: "grok",
        name: "Grok",
        colour: Some("#8c8f96"),
        mark: Some("R"),
        // 2026-10-15 起接入线路池：config.toml [model.*] 的 api_backend 支持
        // messages/responses 两种协议（chat_completions 刻意不接），私有 GROK_HOME 隔离。
        update: npm("@xai-official/grok", "npm install -g @xai-official/grok"),
        lanes: Some(&[
            (
                "chat",
                &[Lane {
                    id: "grok",
                    engine: Some("grok acp"),
                    ..LANE
                }],
            ),
            ("terminal", &[Lane { id: "grok", ..LANE }]),
        ]),
        ..FAMILY
    },
];

/// Retired lane ids that still resolve to a live one. `claude-exp` was the
/// internal id of the Agent SDK chat lane; that lane is now simply `claude`.
/// Persisted sessions, provider pools and queued items still spell the old id,
/// so every lookup accepts it — but the catalogue never offers it again.
pub const ALIASES: &[(&str, &str)] = &[("claude-exp", "claude")];

fn alias_of(key: &str) -> String {
    ALIASES.iter().find(|(alias, _)| *alias == key).map_or_else(
        || key.to_string(),
        |(_, canonical)| (*canonical).to_string(),
    )
}

/// The spelling every lookup normalizes to: trimmed, lower-case, then any
/// retired id folded into its live lane. This is the single place a CLI id is
/// canonicalized.
///
/// Trimming follows ECMAScript's `String.prototype.trim`, not Rust's Unicode
/// `White_Space`: the mirrors in JS (`src/cli/cli-capability.js`,
/// `public/provider-catalog.js`) trim with `.trim()`, and U+0085 is whitespace
/// to Rust but not to JS. Normalizing differently would let the same record be
/// resident in one table and per-turn in another.
pub fn name_of(cli: &str) -> String {
    alias_of(js_trim(&cli.to_lowercase()))
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c,
            '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}')
    })
}

pub fn capability_of(cli: &str) -> Capability {
    let key = name_of(cli);
    CAPABILITIES
        .iter()
        .find(|(id, _)| *id == key)
        .map_or(DEFAULT_CAPABILITY, |(_, capability)| *capability)
}

/// A resident CLI keeps one child across turns.
pub fn is_resident(cli: &str) -> bool {
    capability_of(cli).lifecycle == "resident"
}

/// True when stopping a turn stops the lane's child.
pub fn cancel_stops_process(cli: &str) -> bool {
    capability_of(cli).cancel == "process"
}

/// Wire value on a turn request and on the provider route minted for it. Kept
/// as the historical strings so persisted turns and route contracts stay valid.
pub fn transport_of(cli: &str) -> &'static str {
    if is_resident(cli) {
        "claude-stream"
    } else {
        "cli-process"
    }
}

pub fn protocol_family(cli: &str) -> ProtocolFamily {
    let key = name_of(cli);
    PROTOCOL_FAMILIES
        .iter()
        .find(|(id, _)| *id == key)
        .map_or(ProtocolFamily::Unknown, |(_, family)| *family)
}

/// The upstream dialect in the wire spelling (`api == false`) or a provider
/// summary's apiFormat spelling (`api == true`). `None` for an ACP agent and an
/// unknown CLI, so each caller keeps its own fallback.
pub fn protocol_family_of(cli: &str, api: bool) -> Option<&'static str> {
    match (protocol_family(cli), api) {
        (ProtocolFamily::Anthropic, false) => Some("anthropic-messages"),
        (ProtocolFamily::Anthropic, true) => Some("anthropic"),
        (ProtocolFamily::OpenAi, false) => Some("openai-responses"),
        (ProtocolFamily::OpenAi, true) => Some("openai_responses"),
        _ => None,
    }
}

/// Which family a lane belongs to — by family id or by any of its lane ids.
pub fn family_of(cli: &str) -> Option<&'static Family> {
    let key = name_of(cli);
    if key.is_empty() {
        return None;
    }
    CLIS.iter().find(|family| family.id == key).or_else(|| {
        CLIS.iter().find(|family| {
            KINDS.iter().any(|kind| {
                lane_entries(family, kind)
                    .iter()
                    .any(|lane| lane_id(family, lane) == key)
            })
        })
    })
}

/// Vendor-auth CLIs sign in with their own account, so no multicc provider is
/// bound to their sessions. Unknown ids answer false.
pub fn is_providerless(cli: &str) -> bool {
    let key = name_of(cli);
    CLIS.iter().any(|family| {
        family.providerless
            && KINDS.iter().any(|kind| {
                lane_entries(family, kind)
                    .iter()
                    .any(|lane| lane_id(family, lane) == key)
            })
    })
}

fn lane_entries(family: &Family, kind: &str) -> Vec<Lane> {
    match family.lanes {
        None => vec![Lane {
            id: family.id,
            ..LANE
        }],
        Some(lanes) => lanes
            .iter()
            .find(|(declared, _)| *declared == kind)
            .map(|(_, entries)| entries.to_vec())
            .unwrap_or_default(),
    }
}

fn lane_id(family: &Family, lane: &Lane) -> String {
    let id = name_of(lane.id);
    if id.is_empty() {
        family.id.to_string()
    } else {
        id
    }
}

fn first_letter(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map_or_else(|| "?".to_string(), |c| c.to_uppercase().collect())
}

fn colour_of(family: &Family) -> &'static str {
    family.colour.unwrap_or(DEFAULT_COLOUR)
}

fn fallback_mark(family: &Family) -> String {
    family
        .mark
        .map_or_else(|| first_letter(family.name), str::to_string)
}

/// One lane, as one kind presents it — everything a surface needs to draw a
/// row, so no caller falls back on a neighbour's name or a raw id.
fn presentation(family: &Family, kind: &str, lane: &Lane) -> Value {
    let id = lane_id(family, lane);
    json!({
        "lane": id,
        "kind": kind,
        "label": lane.label.unwrap_or(family.name),
        "engine": lane.engine.map_or_else(|| id.clone(), str::to_string),
        "mark": lane.mark.map_or_else(|| fallback_mark(family), str::to_string),
        "colour": colour_of(family),
        "providerless": family.providerless,
        "offered": lane.offered,
        "bundled": lane.bundled,
        "deprecated": lane.deprecated,
        "replacedBy": if lane.deprecated { lane.replaced_by } else { None },
    })
}

/// The catalogue exactly as a JS object literal would spell it: optional
/// columns are absent rather than null, and flags appear only when they differ
/// from the default (`offered: false`, `bundled: true`, `deprecated: true`).
fn family_record(family: &Family) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(family.name));
    if let Some(colour) = family.colour {
        out.insert("colour".into(), json!(colour));
    }
    if let Some(mark) = family.mark {
        out.insert("mark".into(), json!(mark));
    }
    if family.providerless {
        out.insert("providerless".into(), json!(true));
    }
    if let Some(update) = family.update {
        let mut spec = Map::new();
        if let Some(package) = update.package {
            spec.insert("package".into(), json!(package));
        }
        if let Some(command) = update.command {
            spec.insert("command".into(), json!(command));
        }
        if let Some(manual) = update.manual {
            spec.insert("manual".into(), json!(manual));
        }
        out.insert("update".into(), Value::Object(spec));
    }
    if let Some(lanes) = family.lanes {
        let mut kinds = Map::new();
        for (kind, entries) in lanes {
            let rows = entries.iter().map(lane_record).collect();
            kinds.insert((*kind).into(), Value::Array(rows));
        }
        out.insert("lanes".into(), Value::Object(kinds));
    }
    Value::Object(out)
}

fn lane_record(lane: &Lane) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(lane.id));
    for (key, value) in [
        ("label", lane.label),
        ("mark", lane.mark),
        ("engine", lane.engine),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    if !lane.offered {
        out.insert("offered".into(), json!(false));
    }
    if lane.bundled {
        out.insert("bundled".into(), json!(true));
    }
    if lane.deprecated {
        out.insert("deprecated".into(), json!(true));
    }
    if let Some(replaced_by) = lane.replaced_by {
        out.insert("replacedBy".into(), json!(replaced_by));
    }
    Value::Object(out)
}

/// Two entries naming the same lane differently in the same column is a
/// mistake in the catalogue, not a preference: one of them would silently win.
fn single(values: &[&'static str], what: &str, id: &str) -> Result<Option<&'static str>, String> {
    match values {
        [] => Ok(None),
        [value] => Ok(Some(*value)),
        _ => Err(format!(
            "the catalogue declares two different values for the {what} of {id}: {}",
            values.join(" / ")
        )),
    }
}

fn push_unique(values: &mut Vec<&'static str>, value: &'static str) {
    if !values.contains(&value) {
        values.push(value);
    }
}

struct LaneRow {
    id: String,
    labels: Vec<&'static str>,
    marks: Vec<&'static str>,
    /// (kind, engine) in first-declared order; a later kind's engine for the
    /// same kind replaces the value in place, as a JS `Map#set` would.
    engines: Vec<(&'static str, &'static str)>,
    kinds: Vec<&'static str>,
    deprecated_by: Option<Lane>,
}

/// The flat view: one row per lane, derived from the catalogue (never a second
/// copy). A lane's own row answers the questions about the *id*; the per-kind
/// answers live in the `lanes` view.
fn display_rows(
    families: &[Family],
    display: &mut Map<String, Value>,
    lane_family: &mut Map<String, Value>,
) -> Result<(), String> {
    for family in families {
        let mut rows: Vec<LaneRow> = Vec::new();
        for kind in KINDS {
            for lane in lane_entries(family, kind) {
                let id = lane_id(family, &lane);
                if let Some(owner) = lane_family
                    .get(&id)
                    .and_then(Value::as_str)
                    .filter(|owner| *owner != family.id)
                {
                    return Err(format!(
                        "CLI lane {id} is listed under both {owner} and {}",
                        family.id
                    ));
                }
                lane_family.insert(id.clone(), json!(family.id));
                let index = match rows.iter().position(|row| row.id == id) {
                    Some(index) => index,
                    None => {
                        rows.push(LaneRow {
                            id: id.clone(),
                            labels: Vec::new(),
                            marks: Vec::new(),
                            engines: Vec::new(),
                            kinds: Vec::new(),
                            deprecated_by: None,
                        });
                        rows.len() - 1
                    }
                };
                let row = &mut rows[index];
                if let Some(label) = lane.label {
                    push_unique(&mut row.labels, label);
                }
                if let Some(mark) = lane.mark {
                    push_unique(&mut row.marks, mark);
                }
                if let Some(engine) = lane.engine {
                    match row.engines.iter_mut().find(|(k, _)| *k == kind) {
                        Some(slot) => slot.1 = engine,
                        None => row.engines.push((kind, engine)),
                    }
                }
                if lane.offered && !row.kinds.contains(&kind) {
                    row.kinds.push(kind);
                }
                if lane.deprecated && row.deprecated_by.is_none() {
                    row.deprecated_by = Some(lane);
                }
            }
        }
        for row in rows {
            let label = single(&row.labels, "label", &row.id)?;
            let mark = single(&row.marks, "shortMark", &row.id)?
                .map_or_else(|| fallback_mark(family), str::to_string);
            // The small line belongs to the kind that offers the lane; a lane
            // offered in both kinds takes the first it declares.
            let engine = row
                .kinds
                .iter()
                .find_map(|kind| row.engines.iter().find(|(k, _)| k == kind))
                .or_else(|| row.engines.first())
                .map(|(_, engine)| *engine);
            let mut out = Map::new();
            out.insert("displayName".into(), json!(label.unwrap_or(family.name)));
            out.insert("shortMark".into(), json!(mark));
            out.insert("colour".into(), json!(colour_of(family)));
            out.insert("providerless".into(), json!(family.providerless));
            out.insert("deprecated".into(), json!(row.deprecated_by.is_some()));
            if let Some(replaced_by) = row.deprecated_by.and_then(|lane| lane.replaced_by) {
                out.insert("replacedBy".into(), json!(replaced_by));
            }
            if let Some(engine) = engine {
                out.insert("engine".into(), json!(engine));
            }
            if row.kinds.len() != KINDS.len() {
                out.insert("kinds".into(), json!(row.kinds));
            }
            display.insert(row.id, Value::Object(out));
        }
    }
    Ok(())
}

/// The update unit: a family's own CLI artifact, in the shape switch-runtime
/// and both clients speak — `{ auto, command, display, manual, package }`.
fn update_spec(update: &Update) -> Value {
    let command = update.command.filter(|command| !command.is_empty());
    json!({
        "auto": command.is_some(),
        "command": command,
        "display": command,
        "manual": if command.is_some() { None } else { update.manual },
        "package": update.package,
    })
}

fn build(families: &[Family]) -> Result<Value, String> {
    let mut display = Map::new();
    let mut lane_family = Map::new();
    display_rows(families, &mut display, &mut lane_family)?;

    let mut clis = Map::new();
    let mut lanes = Map::new();
    let mut updates = Map::new();
    let mut npm_packages = Map::new();
    let mut bundled = Map::new();
    let mut bundled_engines = Map::new();
    let mut families_for: Vec<(&str, Vec<&str>)> =
        KINDS.iter().map(|kind| (*kind, Vec::new())).collect();
    for family in families {
        clis.insert(family.id.into(), family_record(family));
        let mut per_kind = Map::new();
        let mut engines: Vec<Value> = Vec::new();
        for (slot, kind) in KINDS.iter().enumerate() {
            let entries = lane_entries(family, kind);
            if entries.iter().any(|lane| lane.offered) {
                families_for[slot].1.push(family.id);
            }
            let rows = entries
                .iter()
                .map(|lane| presentation(family, kind, lane))
                .collect();
            per_kind.insert((*kind).into(), Value::Array(rows));
            for lane in &entries {
                let id = lane_id(family, lane);
                // First declaration wins, as a scan in catalogue order would.
                bundled.entry(id.clone()).or_insert(json!(lane.bundled));
                if lane.bundled && !engines.iter().any(|item| item["lane"] == id.as_str()) {
                    let engine = lane.engine.map_or_else(|| id.clone(), str::to_string);
                    engines.push(json!({ "lane": id, "engine": engine, "kind": kind }));
                }
            }
        }
        lanes.insert(family.id.into(), Value::Object(per_kind));
        if !engines.is_empty() {
            bundled_engines.insert(family.id.into(), Value::Array(engines));
        }
        if let Some(update) = &family.update {
            updates.insert(family.id.into(), update_spec(update));
            if let Some(package) = update.package {
                npm_packages.insert(family.id.into(), json!(package));
            }
        }
    }

    let capabilities: Map<String, Value> = CAPABILITIES
        .iter()
        .map(|(id, capability)| ((*id).to_string(), capability_record(capability)))
        .collect();
    let protocol_families: Map<String, Value> = PROTOCOL_FAMILIES
        .iter()
        .filter_map(|(id, _)| {
            let wire = protocol_family_of(id, false)?;
            let api = protocol_family_of(id, true)?;
            Some(((*id).to_string(), json!({ "wire": wire, "api": api })))
        })
        .collect();
    let families_for: Map<String, Value> = families_for
        .into_iter()
        .map(|(kind, ids)| (kind.to_string(), json!(ids)))
        .collect();

    Ok(json!({
        "kinds": KINDS,
        "defaultKinds": KINDS,
        "defaultColour": DEFAULT_COLOUR,
        "defaultCapability": capability_record(&DEFAULT_CAPABILITY),
        "capabilities": capabilities,
        "protocolFamilies": protocol_families,
        "aliases": Map::from_iter(ALIASES.iter().map(|(alias, canonical)| ((*alias).to_string(), json!(canonical)))),
        "clis": clis,
        "display": display,
        "laneFamily": lane_family,
        "lanes": lanes,
        "familiesFor": families_for,
        "updates": updates,
        "npmPackages": npm_packages,
        "bundled": bundled,
        "bundledEngines": bundled_engines,
    }))
}

fn capability_record(capability: &Capability) -> Value {
    json!({
        "protocol": capability.protocol,
        "lifecycle": capability.lifecycle,
        "cancel": capability.cancel,
    })
}

/// The whole catalogue and every view derived from it, as one JSON document.
/// Fails when the catalogue contradicts itself (one lane under two families,
/// or one lane given two labels/marks).
pub fn catalog() -> Result<String, String> {
    build(CLIS).map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        serde_json::from_str(&catalog().expect("catalogue is consistent")).unwrap()
    }

    #[test]
    fn lanes_and_lifecycle() {
        for cli in ["claude", "claude-exp", "codex-exp", "zcode", " Claude-EXP "] {
            assert!(is_resident(cli), "{cli}");
            assert_eq!(transport_of(cli), "claude-stream");
        }
        for cli in ["codex", "opencode", "dsh", "", "not-a-cli"] {
            assert!(!is_resident(cli), "{cli}");
            assert_eq!(transport_of(cli), "cli-process");
        }
        assert!(!cancel_stops_process("claude-exp"));
        assert!(cancel_stops_process("not-a-cli"));
        assert_eq!(capability_of("mystery"), DEFAULT_CAPABILITY);
    }

    #[test]
    fn protocol_families_answer_both_spellings() {
        assert_eq!(
            protocol_family_of("claude-exp", false),
            Some("anthropic-messages")
        );
        assert_eq!(protocol_family_of("CODEX", true), Some("openai_responses"));
        assert_eq!(protocol_family_of("opencode", false), None);
        assert_eq!(protocol_family_of("pi", false), None);
        assert_eq!(protocol_family_of("", false), None);
    }

    #[test]
    fn retired_claude_exp_is_an_alias_of_claude() {
        // The old SDK lane id still resolves everywhere, but it is not a lane.
        assert_eq!(name_of(" Claude-EXP "), "claude");
        assert_eq!(capability_of("claude-exp"), capability_of("claude"));
        assert_eq!(protocol_family("claude-exp"), ProtocolFamily::Anthropic);
        assert_eq!(
            family_of("claude-exp").map(|family| family.id),
            Some("claude")
        );
        let value = snapshot();
        assert!(value["display"].get("claude-exp").is_none());
        assert_eq!(value["aliases"]["claude-exp"], "claude");
    }

    #[test]
    fn trimming_matches_ecmascript_not_unicode_white_space() {
        // Mirrors `String.prototype.trim`: these fold to the live lane.
        assert_eq!(name_of("\u{FEFF}CLAUDE-EXP\u{FEFF}"), "claude");
        assert_eq!(name_of("\u{00A0}claude\u{2028}"), "claude");
        // U+0085 NEL is Unicode whitespace but not ECMAScript whitespace: JS
        // sees an unknown id here, so Rust must too instead of making it
        // resident.
        assert_eq!(name_of("\u{0085}claude-exp"), "\u{0085}claude-exp");
        assert!(!is_resident("\u{0085}claude-exp"));
    }

    #[test]
    fn display_rows_follow_the_catalogue() {
        let value = snapshot();
        let display = &value["display"];
        assert_eq!(display["claude"]["displayName"], "Claude");
        assert_eq!(display["claude"]["engine"], "Claude Agent SDK");
        assert_eq!(display["claude"]["shortMark"], "C");
        assert!(display["claude"].get("kinds").is_none());
        assert_eq!(display["codex"]["shortMark"], "E");
        assert_eq!(display["codex"]["replacedBy"], "codex-exp");
        assert_eq!(display["opencode"]["engine"], "opencode acp");
        assert!(display["opencode"].get("kinds").is_none());
        assert_eq!(display["qoder"]["shortMark"], "Q");
        assert!(display["qoder"].get("engine").is_none());
        assert_eq!(value["laneFamily"]["claude"], "claude");
        assert!(value["laneFamily"].get("claude-exp").is_none());
        assert_eq!(value["bundled"]["claude"], true);
        assert_eq!(
            value["bundledEngines"]["claude"],
            json!([{ "lane": "claude", "engine": "Claude Agent SDK", "kind": "chat" }])
        );
        assert_eq!(value["updates"]["zcode"]["auto"], false);
        assert!(value["npmPackages"].get("qoder").is_none());
        assert_eq!(
            family_of("codex-exp").map(|family| family.id),
            Some("codex")
        );
        assert!(is_providerless("gemini"));
        assert!(!is_providerless("dsh"));
        // Catalogue order is picker order.
        let keys: Vec<&String> = value["clis"].as_object().unwrap().keys().collect();
        assert_eq!(keys.first().map(|key| key.as_str()), Some("claude"));
        assert_eq!(keys.last().map(|key| key.as_str()), Some("grok"));
    }

    #[test]
    fn a_contradictory_catalogue_is_rejected() {
        const SHARED: &[Family] = &[
            Family {
                id: "one",
                name: "One",
                lanes: Some(&[("chat", &[Lane { id: "same", ..LANE }])]),
                ..FAMILY
            },
            Family {
                id: "two",
                name: "Two",
                lanes: Some(&[("chat", &[Lane { id: "same", ..LANE }])]),
                ..FAMILY
            },
        ];
        assert!(build(SHARED).unwrap_err().contains("listed under both"));
        const MARKS: &[Family] = &[Family {
            id: "one",
            name: "One",
            lanes: Some(&[
                (
                    "chat",
                    &[Lane {
                        id: "one",
                        mark: Some("A"),
                        ..LANE
                    }],
                ),
                (
                    "terminal",
                    &[Lane {
                        id: "one",
                        mark: Some("B"),
                        ..LANE
                    }],
                ),
            ]),
            ..FAMILY
        }];
        assert!(build(MARKS).unwrap_err().contains("shortMark of one"));
    }
}
