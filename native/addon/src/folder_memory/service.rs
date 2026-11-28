use super::folders::*;
use super::*;

fn validate(d: L<'_>) -> Result<()> {
    if !d.truthy()? || d.kind()? != sys::ValueType::napi_object {
        return Err(d.type_error("[folder-memory] dependencies are required"));
    }
    for name in [c"fs", c"path", c"memoryStoreRoot"] {
        if !d.get(name)?.truthy()? {
            return Err(d.type_error("[folder-memory] filesystem dependencies are required"));
        }
    }
    if d.get(c"directories")?.optional(c"get")?.kind()? != sys::ValueType::napi_function {
        return Err(d.type_error("[folder-memory] directories.get is required"));
    }
    for name in [c"readMemoryFolder", c"getMemoryEntries"] {
        if d.get(name)?.kind()? != sys::ValueType::napi_function {
            return Err(d.type_error(&format!(
                "[folder-memory] {} is required",
                name.to_string_lossy()
            )));
        }
    }
    Ok(())
}
fn read<'a>(o: L<'a>, dir: L<'a>, cap: f64, names: &[&str], markers: &[&str]) -> Result<L<'a>> {
    if !dir.truthy()? {
        return text(o, "");
    }
    let opts = fields(
        o,
        &[(
            "primaryNames",
            o.from_value(&V::Array(names.iter().map(|s| V::from(*s)).collect()))?,
        )],
    )?;
    if !markers.is_empty() {
        opts.set(
            c"priorityEntryMarkers",
            o.from_value(&V::Array(markers.iter().map(|s| V::from(*s)).collect()))?,
        )?
    }
    let d = deps(o)?;
    let reader = d.get(c"readMemoryFolder")?;
    if reader.equals(o.get(c"defaultRead")?)? {
        let result = snapshot(dir, num(o, cap)?, opts)?;
        return o.from_value(result.get("text").unwrap());
    }
    reader.call(d, &[dir, num(o, cap)?, opts])
}
fn block<'a>(o: L<'a>, rules: &Rules, r: L<'a>) -> Result<L<'a>> {
    if !r.truthy()?
        || !r.get(c"dirId")?.truthy()?
        || !r.get(c"id")?.truthy()?
        || r.get(c"type")?.is_string("aux")?
        || r.get(c"type")?.is_string("gateway")?
    {
        return null(o);
    }
    let (own, shared) = ensure(o, rules, r)?;
    let own_body = read(
        o,
        own,
        5000.,
        &[
            primary(r.get(c"cli")?)?,
            "AGENTS.md",
            "CLAUDE.md",
            "MEMORY.md",
        ],
        &[],
    )?;
    let shared_body = read(
        o,
        shared,
        4000.,
        &["MEMORY.md"],
        &[rules.marker(0), LEGACY[0]],
    )?;
    let machine_dir = machine(o)?;
    let machine_body = read(o, machine_dir, 2000., &["MEMORY.md"], &[])?;
    let cli_id = r.get(c"cli")?;
    let cli_dir = cli(o, cli_id)?;
    let cli_body = read(o, cli_dir, 1200., &["MEMORY.md"], &[])?;
    let task_id = task_id(r)?;
    let task_dir = scoped(o, r.get(c"dirId")?, "tasks", task_id)?;
    let task_body = read(o, task_dir, 2000., &["MEMORY.md"], &[])?;
    let own_path = printable(own)?;
    let shared_path = printable(shared)?;
    let machine_path = printable(machine_dir)?;
    let cli_name = printable(cli_id)?;
    let cli_path = printable(fallback(cli_dir, "(invalid cli name)".into())?)?;
    let task_name = printable(fallback(task_id, "none".into())?)?;
    let task_path = printable(fallback(task_dir, "(no bound task)".into())?)?;
    let skills_path = printable(join(
        o,
        &[root(o)?, string(r.get(c"dirId")?)?, text(o, "skills")?],
    )?)?;
    let prefix = format!(
        r#"[Memory store | native session snapshot] You have a persistent memory folder (kept in the multicc data area, outside this repository and outside git). The body below is snapshotted when the native CLI session starts or is rebuilt; writes during the session land on disk immediately and are confirmed by the tool result, but they do not rewrite the system prompt of an already-running session.
- Private memory (visible only to this session) folder: {own_path}
- Shared memory (all sessions of this project) folder: {shared_path}
- Machine-global (all sessions on this machine) folder: {machine_path}
- CLI-specific ({cli_name}) folder: {cli_path}
- Task-level (current task {task_name}) folder: {task_path}
- Skill memory root: {skills_path} (Read on demand; not auto-injected)
- To save a short, stable fact, prefer the managed memory endpoint (atomic write, dedupe, capacity and safety checks):
  curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action" -H 'Content-Type: application/json' -d '{{"action":"add","scope":"own","content":"the fact to remember"}}'
  action is one of add / replace / remove; replace/remove also take oldText.
  scope tiers: own = this session / shared = this project / task = current task (located automatically; pass taskId to target one) / machine = machine-global (highest bar) / cli = current CLI only / skill = skill memory (also pass skill=<skill name>). Longer topic notes can still be written directly with Write/Edit as standalone .md files.

"#
    );
    let mut sections = vec![];
    for (heading, body) in [
        (
            "Machine-global memory (shared by every session on this machine)".to_string(),
            machine_body,
        ),
        (format!("CLI memory ({cli_name})"), cli_body),
        ("Task memory".into(), task_body),
        (
            "Private memory".into(),
            fallback(own_body, "(empty)".into())?,
        ),
        (
            "Shared memory".into(),
            fallback(shared_body, "(empty)".into())?,
        ),
    ] {
        if body.truthy()? && call(body, c"trim", &[])?.truthy()? {
            let mut section = JsString::from_rust_str(&format!("[{heading}]\n"));
            section.push(&js_string(body)?);
            sections.push(section)
        }
    }
    let mut result = JsString::from_rust_str(&prefix);
    result.push(&JsString::join(&sections, &"\n\n".into()));
    result.push_str("\n[End of memory store]");
    o.from_value(&V::String(result))
}
fn role<'a>(o: L<'a>, rules: &Rules, r: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let managed = opts.optional(c"managed")?.truthy()?;
    if !r.truthy()? {
        return null(o);
    }
    let mut base = r.get(c"rolePrompt")?;
    if !base.truthy()? {
        let dir = r.get(c"dirId")?;
        if dir.truthy()? {
            let d = call(deps(o)?.get(c"directories")?, c"get", &[dir])?;
            base = d.optional(c"rolePrompt")?
        }
    }
    let mut parts = vec![];
    if base.truthy()? {
        parts.push(js_string(base)?)
    }
    if !managed {
        let b = block(o, rules, r)?;
        if b.truthy()? {
            parts.push(js_string(b)?)
        }
    }
    if parts.is_empty() {
        null(o)
    } else {
        o.from_value(&V::String(JsString::join(&parts, &"\n\n".into())))
    }
}
fn guidance<'a>(o: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let root = printable(root(o)?)?;
    let cli = printable(r.get(c"cli")?)?;
    let dir = printable(r.get(c"dirId")?)?;
    let id = printable(r.get(c"id")?)?;
    let task = printable(bound_task(r)?)?;
    text(
        o,
        &format!(
            r#"记忆目录 {root}（作用域：_machine、_cli/{cli}、{dir}/_shared、{dir}/tasks/{task}、{dir}/sessions/{id}、{dir}/skills，按需读取）。写稳定事实：POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action，JSON {{"action":"add|replace|remove","scope":"own|shared|task|skill|machine|cli","content":"..."}}（replace/remove 加 oldText，skill 加 skill）。"#
        ),
    )
}
fn create<'a>(p: L<'a>, rules: Arc<Rules>, d: L<'a>) -> Result<L<'a>> {
    validate(d)?;
    let owner = fields(
        p,
        &[
            ("ports", p.get(c"ports")?),
            ("clis", p.get(c"clis")?),
            ("defaultRead", p.get(c"defaultRead")?),
            ("deps", d),
            ("fs", d.get(c"fs")?),
            ("path", d.get(c"path")?),
        ],
    )?;
    call(d.get(c"directories")?, c"keys", &[])?.for_each(|id| {
        ensure_shared(owner, &rules, id)?;
        Ok(())
    })?;
    let api = fields(p, &[])?;
    for (name, n) in [
        ("retrieve", 2),
        ("guidance", 1),
        ("buildBlock", 1),
        ("cliDir", 1),
        ("curatedLimit", 1),
        ("ensureDirs", 1),
        ("ensureShared", 1),
        ("listFiles", 1),
        ("machineDir", 0),
        ("primaryFileName", 1),
        ("resolveRolePrompt", 1),
        ("safeFileName", 1),
        ("safeSegment", 1),
        ("scopeDir", 3),
        ("sessionDir", 1),
        ("sharedDir", 1),
        ("skillDir", 2),
        ("taskDir", 2),
        ("writeAutoFile", 2),
    ] {
        let rules = rules.clone();
        method(
            owner,
            api,
            name,
            n,
            if name == "resolveRolePrompt" { 2 } else { n },
            move |o, a| match name {
                "retrieve" => {
                    ensure(o, &rules, a[0])?;
                    super::retrieval::retrieve(o, &rules, root(o)?, None, a[0], a[1])
                }
                "guidance" => guidance(o, a[0]),
                "buildBlock" => block(o, &rules, a[0]),
                "cliDir" => cli(o, a[0]),
                "curatedLimit" => limit(a[0]),
                "ensureDirs" => {
                    let (own, shared) = ensure(o, &rules, a[0])?;
                    fields(o, &[("own", own), ("shared", shared)])
                }
                "ensureShared" => flag(o, ensure_shared(o, &rules, a[0])?),
                "listFiles" => files(o, a[0]),
                "machineDir" => machine(o),
                "primaryFileName" => text(o, primary(a[0])?),
                "resolveRolePrompt" => role(o, &rules, a[0], a[1]),
                "safeFileName" => safe_name(a[0]),
                "safeSegment" => segment(a[0]),
                "scopeDir" => scope_dir(o, a[0], a[1], a[2]),
                "sessionDir" => session(o, a[0]),
                "sharedDir" => shared(o, a[0]),
                "skillDir" => scoped(o, a[0], "skills", a[1]),
                "taskDir" => scoped(o, a[0], "tasks", a[1]),
                _ => auto(o, a[0], a[1]),
            },
        )?;
    }
    api.freeze()
}
pub(super) fn api<'a>(
    p: L<'a>,
    curated: L<'a>,
    retrieval: L<'a>,
    rules: Arc<Rules>,
) -> Result<L<'a>> {
    let owner = fields(
        p,
        &[
            ("ports", p),
            ("clis", retrieval.get(c"SYSTEM_PROMPT_SECRET_RULE_CLIS")?),
            ("defaultRead", curated.get(c"readMemoryFolder")?),
        ],
    )?;
    let api = fields(p, &[])?;
    for (name, cap) in [
        ("SESSION_MEM_CAP", 5000),
        ("SHARED_MEM_CAP", 4000),
        ("TASK_MEM_CAP", 2000),
        ("CLI_MEM_CAP", 1200),
        ("MACHINE_MEM_CAP", 2000),
        ("SESSION_CURATED_MEM_CAP", 131072),
        ("SHARED_CURATED_MEM_CAP", 131072),
        ("TASK_CURATED_MEM_CAP", 65536),
        ("SKILL_CURATED_MEM_CAP", 32768),
        ("CLI_CURATED_MEM_CAP", 32768),
        ("MACHINE_CURATED_MEM_CAP", 32768),
    ] {
        api.set_key(text(p, name)?, num(p, f64::from(cap))?)?;
    }
    method(
        owner,
        api,
        "createFolderMemoryService",
        1,
        1,
        move |p, a| create(p, rules.clone(), a[0]),
    )?;
    Ok(api)
}
