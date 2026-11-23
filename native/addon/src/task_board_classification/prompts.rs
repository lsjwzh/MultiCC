//! 从宿主读取看板字段，保留活值、引擎转换和读取顺序。
use super::*;
use multicc_core::task_board_classification_prompt as prompt;

#[napi]
pub fn task_board_system_prompt(backfill: bool) -> &'static str {
    prompt::system_prompt(backfill)
}
fn prompt_text(value: L) -> Result<JsString> {
    if !value.truthy()? {
        return Ok(JsString::new());
    }
    context::explicit_string(Host(value), value)?.coerce_string()
}

fn board_list<'a>(board: L<'a>, recent_ids: L<'a>, backfill: bool) -> Result<prompt::BoardList> {
    let modules = board
        .global()?
        .get(c"Object")?
        .invoke(c"values", &[board.get(c"modules")?])?;
    let mut names = Vec::new();
    for i in 0..modules.length()? {
        names.push(modules.element(i)?.get(c"name")?.coerce_string()?);
    }
    let ids = recent_ids.call_plain(&[board])?;
    let mut tasks = Vec::new();
    for i in 0..ids.length()? {
        tasks.push(board.get(c"tasks")?.get_key(ids.element(i)?)?);
    }
    let mut lines = Vec::with_capacity(tasks.len());
    for task in tasks {
        let module = board.get(c"modules")?.get_key(task.get(c"moduleId")?)?;
        let mut line = task.get(c"id")?.coerce_string()?;
        line.push_str(" | ");
        if module.truthy()? {
            line.push(&module.get(c"name")?.coerce_string()?);
        } else {
            line.push_str("?");
        }
        line.push_str(" | ");
        line.push(&task.get(c"title")?.coerce_string()?);
        if !backfill {
            let areas = context::slice(task.get(c"areas")?, 3)?;
            line.push_str(" | ");
            line.push(
                &areas
                    .invoke(c"join", &[Host(board).value(", ")?])?
                    .coerce_string()?,
            );
        }
        lines.push(line);
    }
    Ok(prompt::BoardList {
        modules: names,
        tasks: lines,
    })
}

fn turn_lines(turns: L) -> Result<Vec<Option<JsString>>> {
    if !turns.is_array()? {
        return Err(turns.type_error("turns.map is not a function"));
    }
    let mut lines = Vec::new();
    for i in 0..turns.length()? {
        // 稀疏轮次数组的 map + join 保留空行及轮次总数。
        if turns.has(&std::ffi::CString::new(i.to_string()).expect("十进制索引"))? {
            let turn = turns.element(i)?;
            lines.push(Some(prompt::history_turn(
                turn.get(c"n")?.coerce_string()?,
                prompt_text(turn.get(c"user")?)?,
                prompt_text(turn.get(c"reply")?)?,
            )));
        } else {
            lines.push(None);
        }
    }
    Ok(lines)
}

#[napi]
pub fn task_board_user_prompt(
    env: Env,
    options: Unknown<'_>,
    recent_ids: Unknown<'_>,
    backfill: bool,
) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let host = Host(options);
    let recent_ids = L::new(&env, recent_ids);
    let board = options.get(c"board")?;
    let session = options.get(c"sessionLabel")?;
    let dir = options.get(c"dirLabel")?;
    let label = || session.or(|| host.value("?"))?.coerce_string();
    let directory = || -> Result<Option<JsString>> {
        if dir.truthy()? {
            Ok(Some(dir.coerce_string()?))
        } else {
            Ok(None)
        }
    };
    let rendered = if backfill {
        let turns = options.get(c"turns")?;
        let board = board_list(board, recent_ids, true)?;
        let history = prompt::Conversation::History(turn_lines(turns)?);
        prompt::render(board, label()?, directory()?, history)
    } else {
        let user = options.get(c"userText")?;
        let reply = options.get(c"replyText")?;
        let board = board_list(board, recent_ids, false)?;
        prompt::render(
            board,
            label()?,
            directory()?,
            prompt::Conversation::Turn {
                user: prompt_text(user)?,
                reply: prompt_text(reply)?,
            },
        )
    };
    Ok(host.value(J::String(rendered))?.raw())
}

pub(super) fn targeted<'a>(
    host: Host<'a>,
    task: L<'a>,
    input: &context::Input<'a>,
) -> Result<L<'a>> {
    let board = host.board()?;
    let session = input.reference.get(c"sessionId")?;
    let label = host
        .record(session)?
        .optional(c"label")?
        .or(|| input.reference.get(c"sessionId"))?;
    let board = board_list(board, host.0.get(c"recentTaskIds")?, false)?;
    let mut out = prompt::render(
        board,
        label.or(|| host.value("?"))?.coerce_string()?,
        None,
        prompt::Conversation::Turn {
            user: prompt_text(input.user)?,
            reply: prompt_text(input.reply)?,
        },
    );
    out.push_str("\n\n【本次要求】\n这是用户已确认创建的任务，占位任务 id 为 ");
    out.push(&task.get(c"id")?.coerce_string()?);
    out.push_str("。\n必须输出恰好一个任务并保留 id \"");
    out.push(&task.get(c"id")?.coerce_string()?);
    out.push_str("\"；这里只做模块/标题归类，不合并任务身份。\n必须给出最终 title、module 和 areas，不能返回空 tasks。");
    host.value(J::String(out))
}
