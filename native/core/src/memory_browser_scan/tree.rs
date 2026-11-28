use super::*;

fn section(folder: Folder) -> V {
    let mut fields = Vec::new();
    let key = match folder.scope {
        "cli" => "cli",
        "skill" => "skill",
        "task" => "taskId",
        _ => "sessionId",
    };
    if let Some(sub) = folder.sub {
        fields.push((key, sub.clone().into()));
        if folder.scope == "session" {
            fields.extend([
                ("label", sub.into()),
                ("cli", V::Null),
                ("live", false.into()),
            ]);
        }
    }
    fields.extend([("dir", folder.dir.into()), ("rel", folder.rel.into())]);
    let tokens = folder.files.iter().map(|f| f.tokens).sum::<u64>();
    let files = V::Array(
        folder
            .files
            .into_iter()
            .map(|file| {
                let title = if file.parsed.title.is_empty() {
                    file.slug
                } else {
                    file.parsed.title
                };
                V::object(vec![
                    ("name", file.name.into()),
                    ("rel", file.rel.into()),
                    ("path", file.path.into()),
                    ("size", number(file.size)),
                    ("tokens", V::Number(file.tokens as f64)),
                    ("title", title.into()),
                    ("mtime", file.mtime.map_or(V::Null, Into::into)),
                ])
            })
            .collect(),
    );
    if matches!(folder.scope, "shared" | "session") {
        fields.extend([("tokens", V::Number(tokens as f64)), ("files", files)]);
    } else {
        fields.extend([("files", files), ("tokens", V::Number(tokens as f64))]);
    }
    V::object(fields)
}
pub(super) fn build(snapshot: Snapshot, root: &Path, limit: usize) -> V {
    let mut tokens = 0u64;
    let mut file_count = 0usize;
    let mut tally = |f: &Folder| {
        file_count += f.files.len();
        tokens += f.files.iter().map(|e| e.tokens).sum::<u64>();
    };
    tally(&snapshot.machine);
    let machine = section(snapshot.machine);
    let clis = snapshot
        .clis
        .into_iter()
        .filter(|f| !f.files.is_empty())
        .map(|f| {
            tally(&f);
            section(f)
        })
        .collect();
    let mut projects = Vec::new();
    let mut session_count = 0;
    let mut project_count = 0;
    for proj in snapshot.projects {
        let mut count = 0;
        let mut sum = 0;
        let (mut shared, mut skills, mut tasks, mut sessions) = (V::Null, vec![], vec![], vec![]);
        for folder in proj.folders {
            tally(&folder);
            count += folder.files.len();
            sum += folder.files.iter().map(|f| f.tokens).sum::<u64>();
            match folder.scope {
                "shared" => shared = section(folder),
                "skill" if !folder.files.is_empty() => skills.push(section(folder)),
                "task" if !folder.files.is_empty() => tasks.push(section(folder)),
                "session" => sessions.push(section(folder)),
                _ => {}
            }
        }
        session_count += sessions.len();
        project_count += usize::from(count > 0);
        projects.push(V::object(vec![
            ("dirId", proj.id.into()),
            ("name", V::Null),
            ("dirPath", V::Null),
            ("tokens", V::Number(sum as f64)),
            ("fileCount", number(count)),
            ("shared", shared),
            ("skills", V::Array(skills)),
            ("tasks", V::Array(tasks)),
            ("sessions", V::Array(sessions)),
        ]));
    }
    V::object(vec![
        ("root", root.to_string_lossy().as_ref().into()),
        ("machine", machine),
        ("clis", V::Array(clis)),
        ("projects", V::Array(projects)),
        (
            "meta",
            V::object(vec![
                ("projectCount", number(project_count)),
                ("sessionCount", number(session_count)),
                ("fileCount", number(file_count)),
                ("tokenTotal", V::Number(tokens as f64)),
                ("truncated", snapshot.truncated.into()),
                ("maxFiles", number(limit)),
            ]),
        ),
    ])
}
