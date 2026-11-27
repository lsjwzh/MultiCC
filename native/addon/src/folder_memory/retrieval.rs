use super::*;
use multicc_core::curated_memory::retrieval as kernel;

fn append_diagnostics(target: L<'_>, diags: Vec<V>) -> Result<()> {
    for d in diags {
        call(target, c"push", &[target.from_value(&d)?])?;
    }
    Ok(())
}

pub(super) fn api<'a>(p: L<'a>, rules: Arc<Rules>) -> Result<L<'a>> {
    let names = ["claude", "codex", "codex-exp", "codebuddy", "qoder", "pi"]
        .into_iter()
        .map(V::from)
        .collect();
    let clis = p
        .global()?
        .get(c"Set")?
        .construct(&[p.from_value(&V::Array(names))?])?;
    let owner = fields(p, &[("ports", p), ("clis", clis)])?;
    let api = fields(p, &[("SYSTEM_PROMPT_SECRET_RULE_CLIS", clis)])?;
    method(owner, api, "chunks", 1, 1, |o, a| {
        let input = printable(a[0])?;
        o.from_value(&V::Array(
            kernel::chunks(&input).into_iter().map(V::from).collect(),
        ))
    })?;
    method(owner, api, "safeFiles", 3, 3, |o, a| {
        if !a[1].truthy()? {
            return array(o);
        }
        let mut diags = vec![];
        let files = kernel::safe_files(&path(a[0])?, &path(a[1])?, &mut diags);
        append_diagnostics(a[2], diags)?;
        o.from_value(&V::Array(
            files
                .into_iter()
                .map(|f| {
                    V::object(vec![
                        ("file", f.file.to_string_lossy().as_ref().into()),
                        ("name", f.name.into()),
                        ("text", f.text.into()),
                    ])
                })
                .collect(),
        ))
    })?;
    method(owner, api, "retrieveMemory", 4, 4, move |o, a| {
        retrieve(o, &rules, a[0], Some(a[1]), a[2], a[3])
    })?;
    Ok(api)
}

pub(super) fn retrieve<'a>(
    owner: L<'a>,
    rules: &Rules,
    root: L<'a>,
    external: Option<L<'a>>,
    r: L<'a>,
    query: L<'a>,
) -> Result<L<'a>> {
    let task = folders::bound_task(r)?;
    let mut scopes = vec![];
    for (name, key) in [
        ("machine", c"machineDir"),
        ("cli", c"cliDir"),
        ("shared", c"sharedDir"),
        ("task", c"taskDir"),
        ("own", c"sessionDir"),
    ] {
        let folder = if let Some(f) = external {
            match name {
                "machine" => call(f, key, &[]),
                "cli" => call(f, key, &[r.get(c"cli")?]),
                "shared" => call(f, key, &[r.get(c"dirId")?]),
                "task" => call(f, key, &[r.get(c"dirId")?, task]),
                _ => call(f, key, &[r]),
            }
        } else {
            match name {
                "machine" => folders::machine(owner),
                "cli" => folders::cli(owner, r.get(c"cli")?),
                "shared" => folders::shared(owner, r.get(c"dirId")?),
                "task" => folders::scoped(owner, r.get(c"dirId")?, "tasks", task),
                _ => folders::session(owner, r),
            }
        }?;
        if folder.truthy()? {
            scopes.push(kernel::Scope {
                name,
                folder: path(folder)?,
                skill: None,
            })
        }
    }
    let paths = owner.get(c"ports")?.get(c"path")?;
    let skills = path(call(
        paths,
        c"join",
        &[root, string(r.get(c"dirId")?)?, text(owner, "skills")?],
    )?)?;
    let root = path(root)?;
    let mut diags = vec![];
    for name in kernel::skills(&root, &skills, &mut diags) {
        let key = text(owner, &name)?;
        let folder = if let Some(f) = external {
            if !call(f, c"safeSegment", &[key])?.truthy()? {
                continue;
            }
            call(f, c"skillDir", &[r.get(c"dirId")?, key])?
        } else {
            if !folders::valid_segment(js::js_trim(&name)) {
                continue;
            }
            folders::scoped(owner, r.get(c"dirId")?, "skills", key)?
        };
        if folder.truthy()? {
            scopes.push(kernel::Scope {
                name: "skill",
                folder: path(folder)?,
                skill: Some(name),
            })
        }
    }
    let cli = r.get(c"cli")?;
    let cli = if cli.is_string("claude-exp")? {
        text(owner, "claude")?
    } else {
        cli
    };
    let short = call(owner.get(c"clis")?, c"has", &[cli])?.truthy()?;
    let inventory = kernel::inventory(
        &root,
        scopes,
        &value(task)?,
        V::String(optional_string(query)?),
        rules,
        short,
        &mut diags,
    );
    let items = array(owner)?;
    let candidates = array(owner)?;
    let mut count = 0;
    for (i, row) in inventory.iter().enumerate() {
        let item = owner.from_value(row)?;
        items.set_element(i as u32, item)?;
        if matches!(row.get("selected"), Some(V::Bool(true))) {
            candidates.set_element(count, item)?;
            count += 1;
        }
    }
    fields(
        owner,
        &[
            ("inventory", items),
            ("candidates", candidates),
            ("diagnostics", owner.from_value(&V::Array(diags))?),
        ],
    )
}
