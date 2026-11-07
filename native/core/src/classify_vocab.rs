//! Classify vocabulary — the authoritative tables and the classifier-output
//! parser, migrated verbatim from `src/classify/vocab.js`. The JS module keeps
//! its export surface: it takes one catalogue snapshot at load (constant
//! tables) and forwards the logic-bearing calls here. Parsing follows the old
//! JS semantics exactly, including the pinned quirks:
//!   * the retired `C` collapses to `W` (parse never emits C),
//!   * an UPPERCASE English phase falls through to the case-insensitive lookup
//!     and yields the Chinese LABEL, not the key (golden test pins this),
//!   * goal length caps/slices count UTF-16 code units, like JS strings.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const PROTOCOL_VERSION: u32 = 1;

const THINK_END_MARKER: &str = "<｜end▁of▁thinking｜>";

// phase key <-> Chinese label, in catalogue order.
const PHASE_TABLE: [(&str, &str); 5] = [
    ("planning", "规划中"),
    ("implementing", "实现中"),
    ("verifying", "验证中"),
    ("wrapping", "收尾中"),
    ("done", "已完成"),
];

fn re_think_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"</?think>"#).expect("think tag regex"))
}
fn re_goal_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:第1行[:：]|目标[:：]|goal[:：]?)\s*").expect("goal prefix regex")
    })
}
fn re_phase_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:第2行[:：]|阶段[:：]|phase[:：]?)\s*").expect("phase prefix regex")
    })
}
fn re_state_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:第3行[:：]|状态[:：]|state[:：]?)\s*").expect("state prefix regex")
    })
}
fn re_goal_garbage() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)api\s*error|insufficient\s*balance|自动恢复|异常中断|claude exited|status[_= ]?5\d\d|\b40[0-9]\b|\b50[0-9]\b|(<.parameter>)")
            .expect("goal garbage regex")
    })
}
fn re_word_error() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\berror\b").expect("word error regex"))
}
fn re_goal_noise_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:第[123]行|当前.*任务.*目标|任务状态分析|对话主动权|闭环任务|判断当前)")
            .expect("goal noise prefix regex")
    })
}

// JS strings are UTF-16: `.slice(0, n)` and `.length` count code units.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}
fn utf16_truncate(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

// String(value || '') for the fields read out of a result object: null /
// undefined / "" / 0 / false become "", other scalars stringify.
fn js_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            let t = n.to_string();
            if t == "0" {
                String::new()
            } else {
                t
            }
        }
        Value::Bool(b) => {
            if *b {
                "true".into()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// Normalize a phase word to the canonical English key. Layer 3 is the pinned
/// quirk: a case-insensitive KEY hit returns the Chinese LABEL (the old JS
/// `PHASE_LABELS[phaseRaw.toLowerCase()]` returned the map's value).
fn normalize_phase(raw: &str) -> Option<String> {
    if PHASE_TABLE.iter().any(|(k, _)| *k == raw) {
        return Some(raw.to_string());
    }
    if let Some((k, _)) = PHASE_TABLE.iter().find(|(_, v)| *v == raw) {
        return Some(k.to_string());
    }
    let lower = raw.to_lowercase();
    if let Some((_, label)) = PHASE_TABLE.iter().find(|(k, _)| *k == lower) {
        return Some(label.to_string());
    }
    if let Some((k, _)) = PHASE_TABLE.iter().find(|(_, v)| *v == lower) {
        return Some(k.to_string());
    }
    None
}

/// Parse the classifier's 3-line text output into {state, goal, phase}.
/// Deterministic, no I/O — the JS bridge calls this per classify result.
pub fn parse_classify_result(text: &str) -> Result<String, String> {
    // DeepSeek thinking-block guard: strip everything before the marker.
    let mut clean = text;
    if let Some(at) = clean.find(THINK_END_MARKER) {
        clean = &clean[at + THINK_END_MARKER.len()..];
    }
    let stripped = re_think_tag().replace_all(clean, "");
    let clean = stripped.trim_start();

    let lines: Vec<&str> = clean
        .trim()
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    // Goal (line 1): strip labels, cap at 60 UTF-16 units.
    let goal_line = lines.first().copied().unwrap_or("");
    let goal = utf16_truncate(&re_goal_prefix().replace(goal_line, ""), 60);

    // Phase (line 2): Chinese codes preferred, English synonyms tolerated.
    let phase_line = lines.get(1).copied().unwrap_or("");
    let phase_raw = re_phase_prefix().replace(phase_line, "").trim().to_string();
    let phase = normalize_phase(&phase_raw);

    // State (line 3): toUpperCase happens BEFORE label stripping (JS order).
    let state_line_upper = lines.get(2).map(|s| s.to_uppercase()).unwrap_or_default();
    let state_raw = re_state_prefix()
        .replace(&state_line_upper, "")
        .trim()
        .to_string();
    let first = state_raw.chars().next();
    let state = match first {
        Some('P') => "P",
        Some('D') => "D",
        Some('E') => "E",
        Some('B') => "B",
        // W, retired C, or unparseable — safe default, never D.
        _ => "W",
    };

    // Garbage filter for goal: block prompt regurgitation, API errors, noise.
    let mut goal_ok = (2..=80).contains(&utf16_len(&goal));
    if goal_ok {
        let g = goal.to_lowercase();
        let garbage = re_goal_garbage().is_match(&g)
            || (re_word_error().is_match(&g) && utf16_len(&goal) < 12)
            || re_goal_noise_prefix().is_match(&goal);
        if garbage {
            goal_ok = false;
        }
    }
    let final_goal = if goal_ok { goal } else { String::new() };

    Ok(json!({
        "state": state,
        "goal": final_goal,
        "phase": phase,
    })
    .to_string())
}

/// `applyUserInputEvidence`: an unresolved structured request is authoritative
/// for "waiting on user" — the letter is overridden to W with evidence. A
/// resolved/absent request leaves the result untouched.
fn apply_user_input_evidence(v: &Value) -> Value {
    let result = v["result"].clone();
    let pending = &v["pendingUserInput"];
    let resolved = pending.get("resolved") == Some(&Value::Bool(true));
    if pending.is_null() || resolved {
        return result;
    }
    let mut out = match result {
        Value::Object(map) => Value::Object(map),
        // `{...null}` in JS is `{}`; result is always the parser's object here.
        _ => Value::Object(serde_json::Map::new()),
    };
    out["state"] = json!("W");
    out["evidence"] = json!("request_user_input");
    out
}

/// goalStateForClassify: the ✅ sub-state (achieved / interact / null).
fn goal_state_for(result: &Value) -> Value {
    if result["state"].as_str() != Some("D") {
        return Value::Null;
    }
    let goal = js_text(&result["goal"]);
    let goal = goal.trim();
    if goal.is_empty() || goal == "—" || goal == "-" {
        return Value::Null;
    }
    if result["phase"].as_str() == Some("done") {
        json!("achieved")
    } else {
        json!("interact")
    }
}

/// resolveGoalState: the model-reasoned value wins (when recognized), the
/// phase mapping is the fallback; non-D is always null.
fn resolve_goal_state(v: &Value) -> Value {
    if v["state"].as_str() != Some("D") {
        return Value::Null;
    }
    let model = &v["modelValue"];
    if model == &json!("achieved") || model == &json!("interact") {
        return model.clone();
    }
    goal_state_for(&v["result"])
}

/// classifyGroupKey: D compounds with its goalState (D-G / D-N / D); every
/// other letter passes through unchanged.
fn classify_group_key(v: &Value) -> Value {
    let state = &v["state"];
    if state.as_str() != Some("D") {
        return state.clone();
    }
    match v["goalState"].as_str() {
        Some("achieved") => json!("D-G"),
        Some("interact") => json!("D-N"),
        _ => json!("D"),
    }
}

/// Build the classify system prompt (instructions only, no data). The API
/// error signatures quoted for the E-detection line come from the caller —
/// api-error-policy still owns that table on the JS side.
fn build_system_prompt(v: &Value) -> Value {
    let prior = v["priorGoal"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("无");
    let signatures = v["errorSignatures"].as_str().unwrap_or("");
    let prompt = format!(
        r#"你是任务状态分析器。你需要判断【当前】闭环任务的状态。请严格按以下步骤思考，最后只输出三行结果。

【背景】一个会话里可能先后讨论过多个不同任务（任务A做完后用户又提了任务B）。你只关心【最后一个任务】，不要被前面已结束的旧任务干扰。

【步骤1·分组】在脑内把对话记录按任务切分成若干段：每当用户提出一个全新的、与上文不同的需求时，就开启一个新段。连续围绕同一需求的几轮对话属于同一段。系统注入消息（🔇开头、"检测到任务""[自动恢复""继续："开头）不是新任务，归入当前段；而且它们是系统自动发出的、【不代表真人用户在催促或推动继续】——判定第3行 D/W 时必须忽略这些注入消息的"推进"含义，只依据真人用户的真实意图判断。

【步骤2·定位】找出最后一条消息所属的段，那就是"当前任务"。前面已结束的段全部忽略--哪怕它们判定结果是"已完成"，也不代表当前状态。

【步骤3·判定】只对"当前任务"这一段判定，输出三行：

先读进度与状态：把当前任务段里用户提出的每条要求逐条列出、回记录里找落点（进度），再看清眼下卡在谁身上（状态：助手还在做 / 已正常收尾 / 在等用户拿主意或回答 / 在等后台任务或回调 / 被 API 异常截断）。第2行的阶段就是这份读数的结论，不要只看最后一句。

第1行：当前任务的目标 —— 一句话说清"要做成什么"，必须可验证。
       写法：动词 + 对象（必要时带范围），如"把登录页改成暗色主题""给目录卡片加 git 状态行""修复 /api/classify 的 500"。
       · 这一段里用户提了多个并列要求时，目标要全部覆盖（用"、"并列，如"换 logo、修页脚链接"），不要只写最后一条。
       · 只写做完后的可观察结果，不写过程或手段（"分析一下""看看代码""继续""优化下"都不能当目标）。
       · 自检：只看这个目标，能不能一眼判断做没做完？不能就改写成能判断的说法。
       语言跟随对话语言：中文用中文（≤20 汉字）；英文用英文（≤10 words, e.g. "Fix login page styling"）。
       严格忽略招呼、反问、确认、推进类消息（如"hi""你好""如何了""做到哪了""继续""好了吗" / "hi", "how is it going", "continue"）--这些不是任务目标。
       已有目标「{prior}」，如仍围绕同一任务请保持一致（可以更具体，但不要变成另一件事）。
       如果当前任务段没有任何具体任务（纯招呼/闲聊/系统消息），输出「-」。

第2行：当前任务的阶段，必须原样输出以下五个中文词之一（无论对话语言）：
       规划中 / 实现中 / 验证中 / 收尾中 / 已完成
       判断方法：先把第1行覆盖的要求逐条列出来，再回记录里找每条的落点。
       · 只要还有一条没有落地（没做、做了一半、只说要做什么、结果没验证过）→ 不能判「已完成」，按进度选 规划中/实现中/验证中/收尾中。
       · 只有每条要求都有可验证的结果、且没有遗留的下一步 → 才判「已完成」。
       下列情况都不算「已完成」：助手只是口头说"已完成/搞定了"而记录里看不到结果；助手把问题抛回给用户；收尾了但仍有没做的部分；只是这一轮对话结束了。
       换句话说：「已完成」= 目标达成，是唯一表示"这件事做完了"的阶段；其余四个阶段都表示"还没做完"。
       AI 在等用户回复时不应判为「已完成」；最新用户消息如果提出了新的具体需求，即使 AI 还没开始做，也应判「规划中」而非「已完成」。

第3行：仅一个字母，判断【当前任务段】接下来该谁行动：
       D = 本轮执行成功（助手完成了本轮要求，正常收尾、没有反问、也不需要再继续；这只描述 turn outcome，不代表任务板任务已完成）
       W = 等用户（本轮助手已停下，主动权在用户手里）：助手在反问/征求意见/让用户做选择；或用户表达了犹豫；或任务还没全部做完但助手这一轮已结束——本系统不会自动替用户续接，未完成的部分一律等用户明确指示再继续，所以都判 W
       E = API 异常中断（助手回复末尾含 {signatures} 等故障信息，回答被截断而非正常完成）
       P = AI 还在处理中（回复为空、或明显话没说完，还没到判断的时候）

关键区分 D vs W：
  · 助手已把本轮要求做完、正常收尾、没有后续动作 → D（执行成功；任务板仍由用户手动标记完成）
  · 任务还没全部做完、但助手这一轮已经停下（在反问、阶段性停顿、或等用户指示）→ W（交回用户；系统不自动续接）
  · 最新一条是用户的推进消息、AI 还没回应 → 判 P（还在处理），不要判 D
判断时看当前任务段的整体走向，不是看最后一句有没有问号。回复为空/话没说完判 P。API故障截断判 E。

第3行与第2行各答各的，不要互相迁就：第3行只说"这一轮谁行动"（D/W/P/E），
这件事到底做没做完由第2行说（「已完成」= 达成目标，其余 = 还没做完、后面还得有人接着干）。
所以 D + 非「已完成」是正常组合（这一轮正常收尾，但目标还没达成，等用户再推一把）。

判 W 的典型信号（出现其一即判 W，即使任务整体还没做完）：
  · 助手在回复末尾向用户提出"需要用户拿主意/做决定"的请求——二选一、"要不要我做X"、"先做哪个"、"请指定优先级/范围"、"要我现在就动手吗"、"等你确认后再做"。
  · 拿不准该判什么时，判 W（宁可等用户，也不要自作主张替用户继续）。

⚠️ 若对话明显还在进行中（最后是助手消息且话没说完、或助手正在执行操作），第3行直接判 P，不要硬猜。
⚠️ 只有真正做完当前任务才判 D；AI 在等用户回复、或任务还没收尾，都不能判 D。

只输出这三行结果。不要输出分组过程、不要加序号、解释、引号、空行。"#
    );
    json!({ "prompt": prompt })
}

/// The logic-bearing vocabulary calls, one dispatch entry. `input` is the JS
/// bridge's JSON.stringify payload; parsed with json_lenient per the
/// JS→Rust boundary convention.
pub fn request(op: &str, input: &str) -> Result<String, String> {
    let v: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("classify_vocab_invalid_input: {e}"))?;
    let out = match op {
        "applyUserInputEvidence" => apply_user_input_evidence(&v),
        "goalStateForClassify" => goal_state_for(&v["result"]),
        "resolveGoalState" => resolve_goal_state(&v),
        "classifyGroupKey" => classify_group_key(&v),
        "buildSystemPrompt" => build_system_prompt(&v),
        _ => return Err(format!("classify_vocab_unknown_op: {op}")),
    };
    Ok(out.to_string())
}

/// The constant tables as one JSON document; `src/classify/vocab.js` freezes
/// this snapshot at load and derives its lookups locally.
pub fn catalog() -> Result<String, String> {
    Ok(json!({
        "classifyDisplay": {
            "D": {
                "label": "执行成功", "pushType": "succeeded", "pushTitle": "执行成功",
                "voiceText": "本轮执行成功", "ding": "succeeded",
                "cardStatus": "succeeded", "barTint": "succeeded",
            },
            "C": {
                "label": "继续中", "pushType": null, "pushTitle": null,
                "voiceText": null, "ding": null,
                "cardStatus": "running", "barTint": "running",
            },
            "W": {
                "label": "等待用户", "pushType": "waiting", "pushTitle": "等待操作",
                "voiceText": "等待你的操作", "ding": "waiting",
                "cardStatus": "waiting", "barTint": "waiting",
            },
            "B": {
                "label": "后台等待", "pushType": "waiting", "pushTitle": "后台等待",
                "voiceText": "等待后台任务", "ding": "waiting",
                "cardStatus": "background", "barTint": "background",
            },
            "E": {
                "label": "API 异常", "pushType": "error", "pushTitle": "出现异常",
                "voiceText": "API 异常中断，等待重试中", "ding": "error",
                "cardStatus": "error", "barTint": "error",
            },
            "P": {
                "label": "处理中", "pushType": null, "pushTitle": null,
                "voiceText": null, "ding": null,
                "cardStatus": "running", "barTint": "running",
            },
        },
        "phaseLabels": {
            "planning": "规划中", "implementing": "实现中", "verifying": "验证中",
            "wrapping": "收尾中", "done": "已完成",
        },
        "goalStates": { "achieved": "achieved", "interact": "interact" },
        "turnRunStates": ["queued", "running", "waiting", "background", "succeeded", "error", "idle"],
        "openRunStates": ["queued", "running", "waiting", "background"],
        "classifyStates": ["P", "D", "W", "B", "E"],
        "classifyTurnOutcome": {
            "D": "succeeded", "C": "running", "W": "waiting_user",
            "B": "waiting_background", "E": "failed", "P": "running",
        },
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        serde_json::from_str(&parse_classify_result(text).unwrap()).unwrap()
    }
    fn req(op: &str, input: Value) -> Value {
        serde_json::from_str(&request(op, &input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn letters_and_retired_c() {
        assert_eq!(parse("修复登录样式\n实现中\nP")["state"], "P");
        assert_eq!(parse("修复登录样式\n实现中\nC")["state"], "W");
        assert_eq!(parse("修复登录样式\n实现中\nZ")["state"], "W");
        assert_eq!(parse("")["state"], "W");
        assert_eq!(parse("目标\n实现中\n ")["state"], "W");
        // No word+flags intermediate survives.
        assert!(parse("目标\n实现中\nC").get("background").is_none());
        assert!(parse("目标\n实现中\nC").get("error").is_none());
    }

    #[test]
    fn goal_label_strip_and_cap() {
        assert_eq!(
            parse("目标：给卡片加 git 状态行\n实现中\nC")["goal"],
            json!("给卡片加 git 状态行")
        );
        assert_eq!(
            parse("goal: Fix login page styling\n实现中\nC")["goal"],
            json!("Fix login page styling")
        );
        assert_eq!(
            parse(&format!("{}\n实现中\nC", "x".repeat(80)))["goal"]
                .as_str()
                .unwrap()
                .len(),
            60
        );
    }

    #[test]
    fn phase_normalization_layers_and_the_uppercase_quirk() {
        assert_eq!(parse("目标\n实现中\nC")["phase"], json!("implementing"));
        assert_eq!(parse("目标\nverifying\nC")["phase"], json!("verifying"));
        // Pinned quirk: UPPERCASE English lands on the case-insensitive KEY
        // lookup, which returns the Chinese LABEL, not the key.
        assert_eq!(parse("目标\nVERIFYING\nC")["phase"], json!("验证中"));
        assert_eq!(parse("目标\nnonsense-phase\nC")["phase"], Value::Null);
    }

    #[test]
    fn garbage_goals_dropped() {
        assert_eq!(
            parse("API Error: insufficient balance\n实现中\nW")["goal"],
            json!("")
        );
        assert_eq!(parse("status 500\n实现中\nW")["goal"], json!(""));
        assert_eq!(parse("第1行 当前任务目标\n实现中\nW")["goal"], json!(""));
        assert_eq!(parse("任务状态分析\n实现中\nW")["goal"], json!(""));
        assert_eq!(parse("改配色\n实现中\nC")["goal"], json!("改配色"));
    }

    #[test]
    fn thinking_guards() {
        assert_eq!(
            parse("junk reasoning<｜end▁of▁thinking｜>清理缓存\n实现中\nC")["goal"],
            json!("清理缓存")
        );
        assert_eq!(
            parse("<think></think>真目标\n实现中\nD")["goal"],
            json!("真目标")
        );
    }

    #[test]
    fn user_input_evidence() {
        let result = parse("部署修复\n已完成\nD");
        let untouched = req(
            "applyUserInputEvidence",
            json!({"result": result, "pendingUserInput": null}),
        );
        assert_eq!(untouched, result);
        let forced = req(
            "applyUserInputEvidence",
            json!({"result": result, "pendingUserInput": {"resolved": false}}),
        );
        assert_eq!(forced["state"], "W");
        assert_eq!(forced["evidence"], "request_user_input");
        assert_eq!(forced["goal"], json!("部署修复"));
    }

    #[test]
    fn goal_state_layers() {
        let base = json!({"state": "D", "goal": "把登录页改成暗色", "phase": "done"});
        assert_eq!(
            req("goalStateForClassify", json!({"result": base})),
            json!("achieved")
        );
        assert_eq!(
            req(
                "goalStateForClassify",
                json!({"result": {"state": "D", "goal": "把登录页改成暗色", "phase": "verifying"}})
            ),
            json!("interact")
        );
        for goal in ["", "—", " - "] {
            assert_eq!(
                req(
                    "goalStateForClassify",
                    json!({"result": {"state": "D", "goal": goal, "phase": "done"}})
                ),
                Value::Null
            );
        }
        assert_eq!(
            req(
                "goalStateForClassify",
                json!({"result": {"state": "D", "phase": "done"}})
            ),
            Value::Null
        );
        assert_eq!(
            req("goalStateForClassify", json!({"result": null})),
            Value::Null
        );
    }

    #[test]
    fn resolve_prefers_model_value() {
        let mapping = json!({"state": "D", "goal": "把登录页改成暗色", "phase": "done"});
        assert_eq!(
            req(
                "resolveGoalState",
                json!({"state": "D", "modelValue": "interact", "result": mapping})
            ),
            json!("interact")
        );
        assert_eq!(
            req(
                "resolveGoalState",
                json!({"state": "D", "modelValue": null, "result": mapping})
            ),
            json!("achieved")
        );
        assert_eq!(
            req(
                "resolveGoalState",
                json!({"state": "D", "modelValue": "一半", "result": mapping})
            ),
            json!("achieved")
        );
        for letter in ["W", "B", "E", "P", "C"] {
            assert_eq!(
                req(
                    "resolveGoalState",
                    json!({"state": letter, "modelValue": "achieved", "result": mapping})
                ),
                Value::Null
            );
        }
    }

    #[test]
    fn group_key_compounds_only_d() {
        assert_eq!(
            req(
                "classifyGroupKey",
                json!({"state": "D", "goalState": "achieved"})
            ),
            json!("D-G")
        );
        assert_eq!(
            req(
                "classifyGroupKey",
                json!({"state": "D", "goalState": "interact"})
            ),
            json!("D-N")
        );
        assert_eq!(
            req("classifyGroupKey", json!({"state": "D", "goalState": null})),
            json!("D")
        );
        assert_eq!(
            req(
                "classifyGroupKey",
                json!({"state": "W", "goalState": "achieved"})
            ),
            json!("W")
        );
    }

    #[test]
    fn system_prompt_carries_prior_goal_and_vocabulary() {
        let out = req(
            "buildSystemPrompt",
            json!({"priorGoal": "给目录卡片加 git 状态行", "errorSignatures": "“API Error”、“503”"}),
        );
        let p = out["prompt"].as_str().unwrap();
        assert!(p.contains("给目录卡片加 git 状态行"));
        for kw in [
            "D = ",
            "W = ",
            "E = ",
            "P = ",
            "API Error",
            "503",
            "「已完成」= 目标达成",
        ] {
            assert!(p.contains(kw), "prompt must contain {kw}");
        }
        assert!(!p.contains("C = "), "retired C must not be offered");
        let empty = req(
            "buildSystemPrompt",
            json!({"priorGoal": "", "errorSignatures": "x"}),
        )["prompt"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(empty.contains("无"));
        assert!(!empty.contains("undefined"));
    }

    #[test]
    fn lone_surrogate_input_is_lenient() {
        // JSON.stringify turns a lone surrogate into the literal `\ud834`
        // escape text; json_lenient replaces it with U+FFFD instead of
        // rejecting the request (strict serde would fail the whole call).
        let raw = r#"{"result":{"state":"D","goal":"\ud834修复","phase":"done"}}"#;
        let out: Value =
            serde_json::from_str(&request("goalStateForClassify", raw).unwrap()).unwrap();
        assert_eq!(out, json!("achieved"));
    }

    #[test]
    fn catalog_shape() {
        let c: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(c["classifyDisplay"]["D"]["cardStatus"], json!("succeeded"));
        assert_eq!(c["classifyDisplay"]["B"]["cardStatus"], json!("background"));
        assert_eq!(c["classifyStates"].as_array().unwrap().len(), 5);
        assert_eq!(c["phaseLabels"]["done"], json!("已完成"));
        assert_eq!(c["openRunStates"].as_array().unwrap().len(), 4);
    }
}
