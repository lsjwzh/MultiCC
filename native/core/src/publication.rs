//! Helpers for default commit messages and extracting release notes.

pub fn quick_commit_message(porcelain: &str) -> String {
    let rows: Vec<_> = porcelain.lines().filter(|line| line.len() >= 3).collect();
    if rows.is_empty() {
        return "chore: update working tree".into();
    }
    let files = format!(
        "{} file{}",
        rows.len(),
        if rows.len() == 1 { "" } else { "s" }
    );
    let verb = if rows
        .iter()
        .all(|line| line.as_bytes()[..2].iter().any(|b| b"?A".contains(b)))
    {
        "add"
    } else if rows.iter().all(|line| line.as_bytes()[..2].contains(&b'D')) {
        "remove"
    } else {
        "update"
    };
    let mut names = Vec::new();
    for line in &rows {
        let Some(relative) = line.get(3..) else {
            continue;
        };
        let name = relative
            .trim_matches('"')
            .rsplit(" -> ")
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        // Git can quote paths with escapes; avoid putting an encoded path or
        // control character into the suggested message.
        if name.is_empty() || name.contains('\\') || name.chars().any(char::is_control) {
            return format!("chore: {verb} {files}");
        }
        if !names.contains(&name) {
            names.push(name);
        }
    }
    if names.is_empty() {
        return format!("chore: {verb} {files}");
    }
    let shown = names.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    let more = if rows.len() > 3 {
        format!(" and {} more", rows.len() - 3)
    } else {
        String::new()
    };
    format!("chore: {verb} {shown}{more}")
}

pub fn release_notes(changelog: &str, version: &str) -> Result<String, String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("发布版本必须使用 vX.Y.Z 格式".into());
    }
    let expected = format!("v{version}");
    let mut selected = Vec::new();
    let mut collecting = false;
    let mut matches = 0;
    for line in changelog.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            collecting = heading.split_whitespace().next() == Some(expected.as_str());
            if collecting {
                matches += 1;
            }
        }
        if collecting {
            selected.push(line);
        }
    }
    if matches != 1 {
        return Err(format!(
            "CHANGELOG.md 必须且只能包含一个 {expected} 版本条目"
        ));
    }
    let notes = selected.join("\n").trim().to_owned();
    if selected.iter().skip(1).all(|line| line.trim().is_empty()) {
        return Err(format!("{expected} 的发布说明正文不能为空"));
    }
    Ok(notes + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_exactly_one_version_without_validating_historical_notes() {
        let changelog = "# Changelog\n\n## v2.8.5 — Restore startup\n\n- Restore desktop startup.\n\n## v2.8.4 — 旧版本\n\n- 历史记录。\n";
        let notes = release_notes(changelog, "v2.8.5").unwrap();
        assert!(notes.contains("Restore desktop startup"));
        assert!(!notes.contains("v2.8.4"));
        assert!(release_notes(changelog, "2.8.4")
            .unwrap()
            .contains("历史记录"));
        assert!(release_notes(changelog, "2.8.50").is_err());
        assert!(release_notes("## v2.8.5 — Release\n\n", "2.8.5").is_err());
        assert!(release_notes("## v2.8.5 A\nNotes\n## v2.8.5 B\nNotes", "2.8.5").is_err());
        assert!(release_notes(changelog, "2.8").is_err());
    }

    #[test]
    fn quick_commits_preserve_readable_filenames() {
        assert_eq!(
            quick_commit_message(" M src/app.js\n?? a/b.txt\n M c.js\n D d.js\n"),
            "chore: update app.js, b.txt, c.js and 1 more"
        );
        assert_eq!(quick_commit_message("?? 中文.md\n"), "chore: add 中文.md");
        assert_eq!(
            quick_commit_message("?? \"\\344\\270\\255.md\"\n"),
            "chore: add 1 file"
        );
        assert_eq!(
            quick_commit_message(" D old.txt\n"),
            "chore: remove old.txt"
        );
    }
}
