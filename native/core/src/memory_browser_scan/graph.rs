use super::*;
use indexmap::IndexMap;
use std::collections::HashMap;

struct Node {
    id: String,
    project: String,
    scope: &'static str,
    sub: Option<String>,
    dto: Vec<(&'static str, V)>,
}

#[derive(Default)]
struct Graph {
    nodes: Vec<Node>,
    by_id: HashMap<String, usize>,
    slugs: HashMap<String, HashMap<String, Vec<usize>>>,
    machine: HashMap<String, usize>,
    cli: HashMap<String, usize>,
    pending: Vec<(usize, String, u32)>,
}

impl Graph {
    fn folder(&mut self, folder: Folder, project: &str) {
        for file in folder.files {
            let prefix = match &folder.sub {
                Some(sub) => format!("{}:{sub}", folder.scope),
                None => folder.scope.to_owned(),
            };
            let id = format!("{project}::{prefix}::{}", file.slug);
            let index = self.nodes.len();
            self.by_id.insert(id.clone(), index);
            self.slugs
                .entry(project.into())
                .or_default()
                .entry(file.slug.clone())
                .or_default()
                .push(index);
            match folder.scope {
                "cli" => {
                    self.cli.entry(file.slug.clone()).or_insert(index);
                }
                "machine" => {
                    self.machine.entry(file.slug.clone()).or_insert(index);
                }
                _ => {}
            }
            let session = if folder.scope == "session" {
                folder.sub.as_deref()
            } else {
                None
            };
            let summary = if file.parsed.summary.is_empty() {
                "（无摘要）".into()
            } else {
                V::String(file.parsed.summary)
            };
            let kind = memory_markdown::node_kind(&file.name, &file.parsed.kind);
            let dto = vec![
                ("id", id.clone().into()),
                ("slug", file.slug.into()),
                ("file", file.name.into()),
                ("title", file.parsed.title.into()),
                ("summary", summary),
                ("type", kind.into()),
                ("scope", folder.scope.into()),
                ("sessionId", session.map_or(V::Null, Into::into)),
                ("sub", folder.sub.as_deref().map_or(V::Null, Into::into)),
                ("dirId", project.into()),
                ("size", number(file.size)),
                ("path", file.path.into()),
                ("rel", file.rel.into()),
                ("tokens", V::Number(file.tokens as f64)),
                ("missing", false.into()),
            ];
            self.nodes.push(Node {
                id,
                project: project.into(),
                scope: folder.scope,
                sub: folder.sub.clone(),
                dto,
            });
            for (slug, count) in file.parsed.links {
                self.pending.push((index, slug, count));
            }
        }
    }

    fn resolve(&self, from: usize, slug: &str) -> Option<usize> {
        let node = &self.nodes[from];
        let candidates = self.slugs.get(&node.project).and_then(|f| f.get(slug));
        let Some(candidates) = candidates else {
            if node.scope == "cli" {
                return self
                    .cli
                    .get(slug)
                    .filter(|&&i| i != from)
                    .or_else(|| self.machine.get(slug))
                    .copied();
            }
            return self
                .machine
                .get(slug)
                .or_else(|| self.cli.get(slug))
                .copied();
        };
        if node.sub.is_some() {
            if let Some(i) = candidates.iter().find(|&&i| {
                let n = &self.nodes[i];
                n.scope == node.scope && n.sub == node.sub
            }) {
                return Some(*i);
            }
        }
        candidates
            .iter()
            .find(|&&i| self.nodes[i].scope == "shared")
            .or(candidates.first())
            .copied()
    }

    fn missing(&mut self, project: String, slug: String) -> usize {
        let id = format!("{project}::missing::{slug}");
        let index = self.nodes.len();
        let mut title = String::new();
        let mut in_separator = false;
        for ch in slug.chars() {
            let sep = matches!(ch, '-' | '_');
            if !sep {
                title.push(ch);
            } else if !in_separator {
                title.push(' ');
            }
            in_separator = sep;
        }
        let dto = vec![
            ("id", id.clone().into()),
            ("slug", slug.clone().into()),
            ("file", format!("{slug}.md").into()),
            ("title", title.into()),
            ("summary", "（尚未创建的记忆 · 被引用但文件不存在）".into()),
            ("type", "missing".into()),
            ("scope", "missing".into()),
            ("sessionId", V::Null),
            ("dirId", project.clone().into()),
            ("size", number(0)),
            ("path", V::Null),
            ("rel", V::Null),
            ("tokens", number(0)),
            ("missing", true.into()),
        ];
        self.nodes.push(Node {
            id,
            project,
            scope: "missing",
            sub: None,
            dto,
        });
        index
    }
}

/// Each markdown file counted links in an ordinary object. References named
/// after an inherited method therefore produce a string when JS adds 1. Keep
/// their partial counts for the owning isolate, where those methods live.
enum Strength {
    Number(u64),
    WithPrototype(Vec<V>),
}

impl Strength {
    fn add(&mut self, slug: &str, count: u32) {
        let inherited = matches!(
            slug,
            "constructor"
                | "toString"
                | "toLocaleString"
                | "valueOf"
                | "hasOwnProperty"
                | "propertyIsEnumerable"
                | "isPrototypeOf"
                | "__defineGetter__"
                | "__defineSetter__"
                | "__lookupGetter__"
                | "__lookupSetter__"
        );
        match self {
            Self::Number(total) if !inherited => *total += u64::from(count),
            Self::Number(total) => {
                *self = Self::WithPrototype(vec![
                    V::Number(*total as f64),
                    V::Array(vec![slug.into(), V::Number(f64::from(count))]),
                ]);
            }
            Self::WithPrototype(parts) => parts.push(if inherited {
                V::Array(vec![slug.into(), V::Number(f64::from(count))])
            } else {
                V::Number(f64::from(count))
            }),
        }
    }
}

pub(super) fn build(snapshot: Snapshot, limit: usize) -> V {
    let mut graph = Graph::default();
    graph.folder(snapshot.machine, "_machine");
    for cli in snapshot.clis {
        let project = cli.rel.clone();
        graph.folder(cli, &project);
    }
    let mut projects = Vec::new();
    for project in snapshot.projects {
        let start = graph.nodes.len();
        for folder in project.folders {
            graph.folder(folder, &project.id);
        }
        projects.push(V::object(vec![
            ("dirId", project.id.into()),
            ("name", V::Null),
            ("count", number(graph.nodes.len() - start)),
        ]));
    }
    let mut truncated = snapshot.truncated;
    let mut edges = IndexMap::<(String, String), Strength>::new();
    let mut missing = HashMap::new();
    for (from, slug, count) in std::mem::take(&mut graph.pending) {
        let from = graph.by_id[&graph.nodes[from].id];
        let target = match graph.resolve(from, &slug) {
            Some(i) => i,
            None => {
                let key = (graph.nodes[from].project.clone(), slug.clone());
                if let Some(i) = missing.get(&key) {
                    *i
                } else if graph.nodes.len() < limit {
                    let i = graph.missing(key.0.clone(), key.1.clone());
                    missing.insert(key, i);
                    i
                } else {
                    truncated = true;
                    continue;
                }
            }
        };
        let source = &graph.nodes[from].id;
        let target = &graph.nodes[target].id;
        if source != target {
            edges
                .entry((source.clone(), target.clone()))
                .or_insert(Strength::Number(0))
                .add(&slug, count);
        }
    }
    let mut degree = HashMap::<String, usize>::new();
    let mut inherited_edges = Vec::new();
    let edges = edges
        .into_iter()
        .enumerate()
        .map(|(index, ((source, target), strength))| {
            *degree.entry(source.clone()).or_default() += 1;
            *degree.entry(target.clone()).or_default() += 1;
            V::object(vec![
                ("source", source.into()),
                ("target", target.into()),
                ("type", "reference".into()),
                (
                    "strength",
                    match strength {
                        Strength::Number(total) => V::Number(total as f64),
                        Strength::WithPrototype(parts) => {
                            inherited_edges.push(number(index));
                            V::Array(parts)
                        }
                    },
                ),
            ])
        })
        .collect();
    let nodes = graph
        .nodes
        .into_iter()
        .map(|mut n| {
            n.dto
                .push(("degree", number(degree.get(&n.id).copied().unwrap_or(0))));
            V::object(n.dto)
        })
        .collect();
    let mut result = vec![
        ("nodes", V::Array(nodes)),
        ("edges", V::Array(edges)),
        ("projects", V::Array(projects)),
        ("truncated", truncated.into()),
    ];
    if !inherited_edges.is_empty() {
        result.push(("inheritedEdgeIndices", V::Array(inherited_edges)));
    }
    V::object(result)
}
