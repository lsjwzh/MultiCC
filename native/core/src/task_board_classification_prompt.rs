//! 任务归档的提示词协议。所有对话截断和拼接以 UTF-16 码元为单位。
use crate::js::JsString;

const TAG_SYSTEM: &str = r#"你是 multicc 的任务归档器。multicc 同时运行多个 AI 会话，你负责把每轮对话归档到「模块-任务」两级任务板上。
输入包含：现有模块与任务清单、本轮对话（用户消息+助手回复）。
输出严格 JSON（不要 markdown 围栏、不要任何解释文字）：
{"tasks":[{"id":"现有任务id或new","title":"任务标题","module":"模块名","areas":["代码路径或功能区域"]}]}

规则：
1. 一轮对话可归入多个任务（最多3个），也可以不归入任何任务：闲聊、寒暄、状态询问、纯知识问答输出 {"tasks":[]}。
2. 优先归入现有任务：延续同一目标/同一代码区域，或只是标题措辞不同但实际工作同类 → 必须复用现有任务id（此时 title/module 可省略），不要重复建卡。
3. 确属新工作才建新任务：id 填 "new"，title ≤20字、概括任务目标（如「实现任务板后端」），不要写成本轮动作（如「回答了问题」）。
4. module 是任务的上层分组，按子系统/目录聚合（例：「服务端」「前端 UI」「移动 App」「发布运维」「文档」）。优先复用现有模块名，确实不匹配才新建。
5. areas 列本轮涉及的代码路径/文件/功能区（≤5项），没有就给空数组。"#;

const BACKFILL_SYSTEM: &str = r#"你是 multicc 的任务归档器。multicc 同时运行多个 AI 会话，现在要把一个会话的历史对话批量归档到「模块-任务」两级任务板上。
输入包含：现有模块与任务清单、该会话的编号轮次列表（每轮=用户消息+助手回复摘要）。
输出严格 JSON（不要 markdown 围栏、不要任何解释文字）：
{"tasks":[{"id":"现有任务id或new","title":"任务标题","module":"模块名","areas":["代码路径或功能区域"],"turns":[轮次编号]}]}

规则：
1. turns 列出属于该任务的轮次编号（整数，来自输入）。一个轮次可属于多个任务；闲聊、寒暄、状态询问轮次不要归入任何任务。
2. 相邻多轮做同一件事 → 归成一个任务，不要一轮一个任务。整个会话通常归出 1-5 个任务。
3. 优先归入现有任务：目标/代码区域相同，或只是标题措辞不同但实际工作同类时，必须复用现有任务id（title/module 可省略）；确属新工作才 id:"new"。
4. title ≤20字、概括任务目标；module 按子系统/目录聚合（例：「服务端」「前端 UI」「移动 App」「发布运维」「文档」），优先复用现有模块名。
5. areas 列该任务涉及的代码路径/文件/功能区（≤5项）。"#;

pub fn system_prompt(backfill: bool) -> &'static str {
    if backfill {
        BACKFILL_SYSTEM
    } else {
        TAG_SYSTEM
    }
}

pub struct BoardList {
    pub modules: Vec<JsString>,
    pub tasks: Vec<JsString>,
}

pub enum Conversation {
    Turn { user: JsString, reply: JsString },
    History(Vec<Option<JsString>>),
}

pub fn history_turn(number: JsString, user: JsString, reply: JsString) -> JsString {
    let mut line = JsString::from("【轮次 ");
    line.push(&number);
    line.push_str("】\n用户：");
    line.push(&user.truncate_units(500));
    line.push_str("\n助手：");
    line.push(&reply.truncate_units(700));
    line
}

fn list(out: &mut JsString, items: &[JsString]) {
    if items.is_empty() {
        out.push_str("（空）");
    }
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push_str("\n");
        }
        out.push_str("- ");
        out.push(item);
    }
}

pub fn render(
    board: BoardList,
    session: JsString,
    directory: Option<JsString>,
    conversation: Conversation,
) -> JsString {
    let backfill = matches!(conversation, Conversation::History(_));
    let mut out = JsString::from("【现有模块】\n");
    list(&mut out, &board.modules);
    out.push_str(if backfill {
        "\n\n【现有任务】（id | 模块 | 标题）\n"
    } else {
        "\n\n【现有任务】（id | 模块 | 标题 | 区域）\n"
    });
    list(&mut out, &board.tasks);
    out.push_str(if backfill {
        "\n\n【会话】"
    } else {
        "\n\n【本轮对话】会话："
    });
    out.push(&session);
    if let Some(dir) = directory {
        out.push_str("（目录：");
        out.push(&dir);
        out.push_str("）");
    }
    match conversation {
        Conversation::Turn { user, reply } => {
            out.push_str("\n用户：");
            out.push(&user.truncate_units(1200));
            out.push_str("\n助手：");
            out.push(&reply.truncate_units(1800));
        }
        Conversation::History(turns) => {
            out.push_str(&format!("，共 {} 轮：\n", turns.len()));
            for (i, turn) in turns.into_iter().enumerate() {
                if i > 0 {
                    out.push_str("\n\n");
                }
                if let Some(line) = turn {
                    out.push(&line);
                }
            }
        }
    }
    out.push_str("\n\n请输出 JSON。");
    out
}
