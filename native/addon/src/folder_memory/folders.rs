use super::*;

pub(super) fn deps(o: L<'_>) -> Result<L<'_>> {
    o.get(c"deps")
}
pub(super) fn root(o: L<'_>) -> Result<L<'_>> {
    deps(o)?.get(c"memoryStoreRoot")
}
pub(super) fn join<'a>(o: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    call(o.get(c"path")?, c"join", args)
}
pub(super) fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
pub(super) fn segment(v: L<'_>) -> Result<L<'_>> {
    let s = printable(fallback(v, "".into())?)?;
    let s = js::js_trim(&s);
    if valid_segment(s) {
        text(v, s)
    } else {
        null(v)
    }
}
pub(super) fn safe_name(v: L<'_>) -> Result<L<'_>> {
    let s = printable(fallback(v, "".into())?)?;
    let s = js::js_trim(&s);
    let valid = s.len() > 3
        && s.to_ascii_lowercase().ends_with(".md")
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.- ".contains(c) || ('一'..='龥').contains(&c));
    if valid {
        text(v, s)
    } else {
        null(v)
    }
}
pub(super) fn session<'a>(o: L<'a>, r: L<'a>) -> Result<L<'a>> {
    join(
        o,
        &[
            root(o)?,
            string(r.get(c"dirId")?)?,
            text(o, "sessions")?,
            string(r.get(c"id")?)?,
        ],
    )
}
pub(super) fn shared<'a>(o: L<'a>, id: L<'a>) -> Result<L<'a>> {
    join(o, &[root(o)?, string(id)?, text(o, "_shared")?])
}
pub(super) fn machine(o: L<'_>) -> Result<L<'_>> {
    join(o, &[root(o)?, text(o, "_machine")?])
}
pub(super) fn cli<'a>(o: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let id = segment(id)?;
    if id.nullish()? {
        return Ok(id);
    }
    join(o, &[root(o)?, text(o, "_cli")?, id])
}
pub(super) fn scoped<'a>(o: L<'a>, id: L<'a>, area: &str, child: L<'a>) -> Result<L<'a>> {
    let id = segment(id)?;
    let child = segment(child)?;
    if id.nullish()? || child.nullish()? {
        return null(o);
    }
    join(o, &[root(o)?, id, text(o, area)?, child])
}
pub(super) fn primary(cli: L<'_>) -> Result<&'static str> {
    Ok(if cli.is_string("codex")? || cli.is_string("codex-exp")? {
        "AGENTS.md"
    } else {
        "CLAUDE.md"
    })
}
pub(super) fn task_id(r: L<'_>) -> Result<L<'_>> {
    r.get(c"taskState")?.optional(c"taskId")
}
pub(super) fn bound_task(r: L<'_>) -> Result<L<'_>> {
    let t = r.get(c"taskBoundTaskId")?;
    if t.truthy()? {
        Ok(t)
    } else {
        task_id(r)
    }
}
pub(super) fn scope_dir<'a>(o: L<'a>, r: L<'a>, scope: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if scope.is_string("shared")? {
        return shared(o, r.get(c"dirId")?);
    }
    if scope.is_string("machine")? {
        return machine(o);
    }
    if scope.is_string("cli")? {
        let c = opts.optional(c"cli")?;
        return cli(o, if c.truthy()? { c } else { r.get(c"cli")? });
    }
    if scope.is_string("skill")? {
        return scoped(o, r.get(c"dirId")?, "skills", opts.optional(c"skill")?);
    }
    if scope.is_string("task")? {
        let mut t = opts.optional(c"taskId")?;
        if !t.truthy()? {
            t = task_id(r)?
        }
        if !t.truthy()? {
            t = opts.optional(c"fallbackTaskId")?
        }
        return scoped(o, r.get(c"dirId")?, "tasks", t);
    }
    session(o, r)
}
pub(super) fn limit(scope: L<'_>) -> Result<L<'_>> {
    num(
        scope,
        if scope.is_string("task")? {
            65536.
        } else if scope.is_string("machine")?
            || scope.is_string("cli")?
            || scope.is_string("skill")?
        {
            32768.
        } else {
            131072.
        },
    )
}
pub(super) fn ensure_shared(o: L<'_>, rules: &Rules, id: L<'_>) -> Result<bool> {
    match shared(o, id)
        .and_then(path)
        .and_then(|dir| seed(o.get(c"ports")?, rules, &dir))
    {
        Ok(done) => Ok(done),
        Err(err) => {
            let msg = if let Some(e) = o.exception_value()? {
                printable(e.get(c"message")?)?
            } else {
                err.reason
            };
            let logger = deps(o)?.get(c"logger")?;
            let logger = if logger.truthy()? {
                logger
            } else {
                o.global()?.get(c"console")?
            };
            call(
                logger,
                c"warn",
                &[text(
                    o,
                    &format!(
                        "[multicc/memory] shared seed {} failed: {msg}",
                        printable(id)?
                    ),
                )?],
            )?;
            Ok(false)
        }
    }
}
fn mkdir<'a>(o: L<'a>, dir: L<'a>) -> Result<()> {
    call(
        o.get(c"fs")?,
        c"mkdirSync",
        &[dir, fields(o, &[("recursive", flag(o, true)?)])?],
    )?;
    Ok(())
}
fn exists<'a>(o: L<'a>, file: L<'a>) -> Result<bool> {
    call(o.get(c"fs")?, c"existsSync", &[file])?.truthy()
}
fn write<'a>(o: L<'a>, file: L<'a>, body: L<'a>) -> Result<()> {
    call(o.get(c"fs")?, c"writeFileSync", &[file, body])?;
    Ok(())
}
pub(super) fn auto<'a>(owner: L<'a>, record: L<'a>, entries: L<'a>) -> Result<L<'a>> {
    if !record.truthy()? || !record.get(c"dirId")?.truthy()? || !record.get(c"id")?.truthy()? {
        return undefined(owner);
    }
    owner.catch(|| {
        let dir = session(owner, record)?;
        mkdir(owner, dir)?;
        let file = join(owner, &[dir, text(owner, "_auto.md")?])?;
        if !entries.truthy()? || !entries.get(c"length")?.truthy()? {
            owner.catch(|| call(owner.get(c"fs")?, c"unlinkSync", &[file]))?;
            return Ok(());
        }
        let count = entries.get(c"length")?.number()? as u32;
        let mut rows = Vec::new();
        for i in 0..count {
            let entry = entries.element(i)?;
            let kind = printable(entry.get(c"type")?)?;
            let text = printable(entry.get(c"text")?)?;
            rows.push(format!("- [{kind}] {text}"));
        }
        let heading = "# 自动提炼记忆（辅助 AI 从周期复盘或被清理的历史中提炼；本文件会被自动覆盖，想长期保留请另写 .md）";
        let contents = format!("{heading}\n\n{}\n", rows.join("\n"));
        write(owner, file, text(owner, &contents)?)
    })?;
    undefined(owner)
}

pub(super) fn ensure<'a>(owner: L<'a>, rules: &Rules, record: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let own = session(owner, record)?;
    let shared = shared(owner, record.get(c"dirId")?)?;
    owner.catch(|| {
        mkdir(owner, own)?;
        mkdir(owner, shared)?;
        ensure_shared(owner, rules, record.get(c"dirId")?)?;
        mkdir(owner, machine(owner)?)?;
        let cli_dir = cli(owner, record.get(c"cli")?)?;
        if cli_dir.truthy()? { mkdir(owner, cli_dir)?; }
        let task = scoped(owner, record.get(c"dirId")?, "tasks", task_id(record)?)?;
        if task.truthy()? { mkdir(owner, task)?; }

        let primary = primary(record.get(c"cli")?)?;
        let file = join(owner, &[own, text(owner, primary)?])?;
        if !exists(owner, file)? {
            let label = record.get(c"label")?;
            let label = printable(if label.truthy()? { label } else { record.get(c"id")? })?;
            let contents = format!("# 本会话私有记忆\n\n> 「{label}」会话专属的长期记忆，只有本会话读得到。\n> 把值得长期记住的东西写进本文件夹的 .md（决定 / 踩过的坑 / 进行中的任务 / 用户偏好）。\n> 想让本项目所有会话都看到的，写到公共记忆文件夹（见注入提示里的路径）。\n\n（暂无内容）\n");
            write(owner, file, text(owner, &contents)?)?;
        }
        let readme = join(owner, &[shared, text(owner, "README.md")?])?;
        if !exists(owner, readme)? {
            let contents = "# 公共记忆（本项目所有会话共享）\n\n> 这里的内容会在本目录下原生 CLI 会话启动/重建时进入上下文快照。放跨会话复用的项目知识、约定、稳定事实。\n> 一事一文件、精炼；临时/私有的东西请写进各自会话的私有记忆文件夹，不要放这里。\n";
            write(owner, readme, text(owner, contents)?)?;
        }
        let auto_file = join(owner, &[own, text(owner, "_auto.md")?])?;
        if !exists(owner, auto_file)? {
            let entries = call(deps(owner)?, c"getMemoryEntries", &[record])?;
            if entries.truthy()? && entries.get(c"length")?.truthy()? {
                auto(owner, record, entries)?;
            }
        }
        Ok(())
    })?;
    Ok((own, shared))
}
pub(super) fn files<'a>(o: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    let out = array(o)?;
    let Some(names) = o.catch(|| strings(call(o.get(c"fs")?, c"readdirSync", &[dir])?))? else {
        return Ok(out);
    };
    let mut names = names;
    names.retain(|s| s.to_lowercase().ends_with(".md"));
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for (i, name) in names.into_iter().enumerate() {
        let name = text(o, &name)?;
        let content = o
            .catch(|| {
                call(
                    o.get(c"fs")?,
                    c"readFileSync",
                    &[join(o, &[dir, name])?, text(o, "utf8")?],
                )
            })?
            .unwrap_or(text(o, "")?);
        out.set_element(
            i as u32,
            fields(o, &[("name", name), ("content", content)])?,
        )?
    }
    Ok(out)
}
