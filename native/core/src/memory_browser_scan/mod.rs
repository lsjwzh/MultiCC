//! Scan the same ordered memory scopes for the graph and tree. The HTTP host
//! uses NativeFiles on a worker. Callers with a virtual filesystem supply its
//! directory, read and timestamp operations to the very same traversal.
mod disk;
mod graph;
mod tree;
use crate::js::JsValue as V;
use crate::memory_markdown::{self, Parsed};
pub use disk::NativeFiles;
use std::path::{Path, PathBuf};

pub trait Files {
    type Error;
    fn directories(&self, dir: &Path) -> Vec<String>;
    fn names(&self, dir: &Path) -> Vec<String>;
    fn read(&self, path: &Path, timestamp: bool) -> Option<(String, Option<String>)>;
    fn project(&mut self, _id: &str) -> Result<(), Self::Error> {
        Ok(())
    }
    fn session(&mut self, _id: &str) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum View {
    Graph,
    Tree,
}

struct File {
    name: String,
    slug: String,
    path: String,
    rel: String,
    size: usize,
    tokens: u64,
    mtime: Option<String>,
    parsed: Parsed,
}

struct Folder {
    scope: &'static str,
    sub: Option<String>,
    rel: String,
    dir: String,
    files: Vec<File>,
}

struct Project {
    id: String,
    folders: Vec<Folder>,
}
struct Snapshot {
    machine: Folder,
    clis: Vec<Folder>,
    projects: Vec<Project>,
    truncated: bool,
}

fn global(s: &str) -> bool {
    matches!(s, "_machine" | "_cli")
}
fn js_sort(names: &mut [String]) {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}
fn physical(root: &Path, rel: &str) -> PathBuf {
    root.join(rel)
}
fn number(n: usize) -> V {
    V::Number(n as f64)
}

struct Walker<'a, F> {
    files: &'a mut F,
    root: &'a Path,
    view: View,
    limit: usize,
    count: usize,
    truncated: bool,
}

impl<F: Files> Walker<'_, F> {
    fn folder(&mut self, scope: &'static str, sub: Option<String>, rel: String) -> Folder {
        let dir = physical(self.root, &rel);
        let mut names = self.files.names(&dir);
        if self.view == View::Tree {
            js_sort(&mut names);
        }
        let mut files = Vec::new();
        for name in names {
            if !name
                .as_bytes()
                .last_chunk::<3>()
                .is_some_and(|s| s.eq_ignore_ascii_case(b".md"))
            {
                continue;
            }
            if self.count >= self.limit {
                self.truncated = true;
                break;
            }
            let path = dir.join(&name);
            let Some((raw, mtime)) = self.files.read(&path, self.view == View::Tree) else {
                continue;
            };
            let slug = name[..name.len() - 3].to_owned();
            let parsed = memory_markdown::parse(&raw, &slug);
            files.push(File {
                slug,
                path: path.to_string_lossy().into_owned(),
                rel: format!("{rel}/{name}"),
                name,
                size: raw.len(),
                tokens: crate::token_estimate::estimate(raw.encode_utf16()),
                mtime,
                parsed,
            });
            self.count += 1;
        }
        Folder {
            scope,
            sub,
            rel,
            dir: dir.to_string_lossy().into_owned(),
            files,
        }
    }
    fn projects(&self) -> Vec<String> {
        self.files
            .directories(self.root)
            .into_iter()
            .filter(|s| !global(s))
            .collect()
    }
}

pub fn scan<F: Files>(
    files: &mut F,
    root: &Path,
    view: View,
    limit: usize,
    filter: Option<&str>,
) -> Result<V, F::Error> {
    let mut walker = Walker {
        files,
        root,
        view,
        limit,
        count: 0,
        truncated: false,
    };
    let ids = (view == View::Graph).then(|| walker.projects());
    let machine = walker.folder("machine", None, "_machine".into());
    let clis = walker
        .files
        .directories(&root.join("_cli"))
        .into_iter()
        .filter(|cli| !global(cli))
        .map(|cli| {
            let rel = format!("_cli/{cli}");
            walker.folder("cli", Some(cli), rel)
        })
        .collect();
    let mut projects = Vec::new();
    for id in ids.unwrap_or_else(|| walker.projects()) {
        if filter.is_some_and(|f| f != id) {
            continue;
        }
        if view == View::Tree {
            walker.files.project(&id)?;
        }
        let mut folders = vec![walker.folder("shared", None, format!("{id}/_shared"))];
        for (tier, scope) in [
            ("skills", "skill"),
            ("tasks", "task"),
            ("sessions", "session"),
        ] {
            let mut subs = walker.files.directories(&root.join(&id).join(tier));
            if scope == "session" && view == View::Tree {
                js_sort(&mut subs);
            }
            for sub in subs {
                if scope != "session" && (global(&sub) || sub.starts_with('.')) {
                    continue;
                }
                let rel = format!("{id}/{tier}/{sub}");
                let folder = walker.folder(scope, Some(sub.clone()), rel);
                if view == View::Tree && scope == "session" {
                    walker.files.session(&sub)?;
                }
                folders.push(folder);
            }
        }
        if view == View::Graph {
            walker.files.project(&id)?;
        }
        projects.push(Project { id, folders });
    }
    let snapshot = Snapshot {
        machine,
        clis,
        projects,
        truncated: walker.truncated,
    };
    Ok(match view {
        View::Graph => graph::build(snapshot, limit),
        View::Tree => tree::build(snapshot, root, limit),
    })
}
