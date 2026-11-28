use super::{
    rules::{Rules, LEGACY},
    scan,
};
use crate::js::{self, JsValue as V};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use regex::Regex;
use std::{
    collections::HashSet,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};

const MAX: u64 = 1024 * 1024;
static SECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"\n[{s}]*§[{s}]*\n", s = js::regex::SPACE)).unwrap());
static PARAGRAPH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\n[{s}]*§[{s}]*\n|\n[{s}]*\n",
        s = js::regex::SPACE
    ))
    .unwrap()
});
pub fn chunks(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for paragraph in PARAGRAPH.split(text) {
        let mut start = 0;
        for (at, _) in paragraph.match_indices("\n- [") {
            out.push(&paragraph[start..at]);
            start = at + 1;
        }
        out.push(&paragraph[start..]);
    }
    out.into_iter()
        .map(js::js_trim)
        .filter(|s| {
            !s.is_empty()
                && (!s.starts_with('#') || s.contains('\n'))
                && !s.contains("（暂无内容）")
        })
        .collect()
}
pub struct File {
    pub file: PathBuf,
    pub name: String,
    pub text: String,
}
pub fn diagnostic(path: &Path, why: impl Into<String>) -> V {
    V::object(vec![
        ("path", path.to_string_lossy().as_ref().into()),
        ("reason", why.into().into()),
    ])
}
fn descend(root: &Path, folder: &Path, diags: &mut Vec<V>) -> Option<Dir> {
    let mut dir = match Dir::open_ambient_dir(root, ambient_authority()) {
        Ok(d) => d,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                diags.push(diagnostic(root, e.to_string()))
            }
            return None;
        }
    };
    let relative = folder.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() || relative.to_string_lossy().starts_with("..") {
        return None;
    }
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        match dir.symlink_metadata(name) {
            Ok(m) if m.is_symlink() => return None,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    diags.push(diagnostic(folder, e.to_string()))
                }
                return None;
            }
            _ => (),
        }
        match dir.open_dir_nofollow(name) {
            Ok(child) => dir = child,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    diags.push(diagnostic(folder, e.to_string()))
                }
                return None;
            }
        }
    }
    Some(dir)
}
pub fn skills(root: &Path, folder: &Path, diags: &mut Vec<V>) -> Vec<String> {
    let Some(dir) = descend(root, folder, diags) else {
        return Vec::new();
    };
    let result = (|| -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        for e in dir.entries()? {
            let e = e?;
            if e.file_type()?.is_dir() {
                names.push(e.file_name().to_string_lossy().into_owned())
            }
        }
        Ok(names)
    })();
    result.unwrap_or_else(|e| {
        if e.kind() != io::ErrorKind::NotFound {
            diags.push(diagnostic(folder, e.to_string()))
        }
        vec![]
    })
}
pub fn safe_files(root: &Path, folder: &Path, diags: &mut Vec<V>) -> Vec<File> {
    let Some(dir) = descend(root, folder, diags) else {
        return Vec::new();
    };
    let result = (|| -> io::Result<Vec<File>> {
        let mut names = vec![];
        for e in dir.entries()? {
            let n = e?.file_name().to_string_lossy().into_owned();
            if n.to_lowercase().ends_with(".md") {
                names.push(n)
            }
        }
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut files = vec![];
        let mut opts = OpenOptions::new();
        opts.read(true).follow(FollowSymlinks::No);
        for name in names {
            let meta = dir.symlink_metadata(&name)?;
            if !meta.is_file() {
                continue;
            }
            let file = folder.join(&name);
            if meta.len() > MAX {
                diags.push(diagnostic(&file, "file_too_large"));
                continue;
            }
            let input = dir.open_with(&name, &opts)?;
            if !input.metadata()?.is_file() {
                continue;
            }
            let mut bytes = vec![];
            input.take(MAX + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX {
                diags.push(diagnostic(&file, "file_too_large"));
                continue;
            }
            files.push(File {
                file,
                name,
                text: String::from_utf8_lossy(&bytes).into_owned(),
            })
        }
        Ok(files)
    })();
    result.unwrap_or_else(|e| {
        if e.kind() != io::ErrorKind::NotFound {
            diags.push(diagnostic(folder, e.to_string()))
        }
        vec![]
    })
}
pub struct Scope {
    pub name: &'static str,
    pub folder: PathBuf,
    pub skill: Option<String>,
}
fn version(body: &str) -> V {
    crate::task_shell::reference::digest(&body.into()).into()
}
pub fn inventory(
    root: &Path,
    scopes: Vec<Scope>,
    task_id: &V,
    query: V,
    rules: &Rules,
    short: bool,
    diags: &mut Vec<V>,
) -> Vec<V> {
    let mut rows = Vec::new();
    for scope in scopes {
        for file in safe_files(root, &scope.folder, diags) {
            let skip: HashSet<_> = SECTION
                .split(&file.text)
                .filter(|entry| (0..3).any(|i| rules.marked(entry, i)))
                .flat_map(chunks)
                .collect();
            let path = file
                .file
                .strip_prefix(root)
                .expect("scoped file")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            for (i, s) in chunks(&file.text).into_iter().enumerate() {
                if skip.contains(s)
                    || (0..3).any(|i| s.contains(rules.marker(i)) || s.contains(LEGACY[i]))
                {
                    continue;
                }
                if scan(s).is_some() {
                    diags.push(diagnostic(&file.file, "unsafe_content"));
                    continue;
                }
                let mut row = vec![
                    ("id", format!("memory:{path}#{i}").into()),
                    ("version", version(s)),
                    ("mode", format!("memory:{}", scope.name).into()),
                    ("kind", "memory".into()),
                    ("scope", scope.name.into()),
                    ("name", file.name.as_str().into()),
                    ("path", path.as_str().into()),
                    (
                        "taskId",
                        if scope.name == "task" {
                            task_id.clone()
                        } else {
                            V::Null
                        },
                    ),
                    ("taskName", format!("{} · {path}", scope.name).into()),
                    ("excerpt", s.into()),
                ];
                if let Some(s) = &scope.skill {
                    row.push(("skill", s.as_str().into()))
                }
                rows.push(V::object(row));
            }
        }
    }
    let ranked = crate::memory_retrieval::select_entries(&V::object(vec![
        ("entries", V::Array(rows)),
        ("query", query),
    ]));
    let mut out = vec![];
    for (i, (id, name)) in [
        ("docs-registry", "文档与服务登记"),
        ("secret-vault", "敏感信息保险箱"),
        ("shared-files", "共享文件约定"),
    ]
    .into_iter()
    .take(if short { 1 } else { 3 })
    .enumerate()
    {
        out.push(V::object(vec![
            ("id", format!("builtin:{id}").into()),
            ("version", version(&rules.0[i])),
            ("mode", "memory:builtin".into()),
            ("kind", "memory".into()),
            ("scope", "builtin".into()),
            ("taskName", format!("MultiCC · {name}").into()),
            ("excerpt", rules.0[i].as_str().into()),
            ("priority", 1000.0.into()),
            ("selected", true.into()),
            ("reason", "builtin".into()),
            ("atomic", true.into()),
        ]))
    }
    if let Some(V::Array(rows)) = ranked.get("inventory") {
        out.extend_from_slice(rows)
    }
    out
}
