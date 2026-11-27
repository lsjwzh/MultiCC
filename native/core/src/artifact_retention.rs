//! Local publication dependency graph shared by the gateway and the Node compatibility host.
use crate::docs_memory_routes::{artifact_id_from_url, valid_artifact_id};
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};
use url::Url;

#[derive(PartialEq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}
impl Stamp {
    fn of(meta: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            size: meta.len(),
            modified: meta.modified().ok(),
            #[cfg(unix)]
            identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
            #[cfg(not(unix))]
            created: meta.created().ok(),
        }
    }
}
type Cache = IndexMap<PathBuf, (Stamp, Vec<String>)>;
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(IndexMap::new()));
fn cached(path: &Path, stamp: &Stamp) -> Option<Vec<String>> {
    let cache = CACHE.lock().ok()?;
    cache
        .get(path)
        .filter(|(old, _)| old == stamp)
        .map(|(_, ids)| ids.clone())
}
fn remember(path: PathBuf, stamp: Stamp, ids: Vec<String>) {
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= 1000 && !cache.contains_key(&path) {
            cache.shift_remove_index(0);
        }
        cache.insert(path, (stamp, ids));
    }
}
const MAX_FILES: usize = 10_000;
const MAX_BYTES: u64 = 64 << 20;
static LINKS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?m)(?:^|[\s"'`(<\[={])((?:/artifacts/|\.{1,2}/)[^\s"'`<>\])}]+)"#)
        .unwrap()
});

fn related(entry: &Value) -> impl Iterator<Item = &str> {
    entry["relatedArtifactIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| valid_artifact_id(id))
}

#[derive(Default)]
struct Budget {
    files: usize,
    bytes: u64,
}

fn scan(
    root: &Path,
    id: &str,
    budget: &mut Budget,
    links: &mut VecDeque<String>,
) -> io::Result<()> {
    match fs::symlink_metadata(root) {
        Ok(m) if m.file_type().is_symlink() => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        _ => (),
    }
    let mut files = vec![PathBuf::from(id)];
    while let Some(rel) = files.pop() {
        budget.files += 1;
        if budget.files > MAX_FILES {
            return Err(io::Error::other(
                "artifact dependency scan exceeded file limit",
            ));
        }
        let path = root.join(&rel);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if meta.is_dir() {
            let first_child = files.len();
            for entry in fs::read_dir(&path)? {
                if files.len() + budget.files >= MAX_FILES {
                    return Err(io::Error::other(
                        "artifact dependency scan exceeded file limit",
                    ));
                }
                files.push(rel.join(entry?.file_name()));
            }
            files[first_child..].sort_by(|a, b| b.cmp(a));
        } else if meta.is_file()
            && matches!(
                rel.extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "htm"
                    | "html"
                    | "css"
                    | "js"
                    | "cjs"
                    | "mjs"
                    | "json"
                    | "map"
                    | "svg"
                    | "xml"
                    | "md"
                    | "txt"
                    | "yaml"
                    | "yml"
            )
        {
            let remaining = MAX_BYTES - budget.bytes;
            if meta.len() > remaining {
                return Err(io::Error::other(
                    "artifact dependency scan exceeded byte limit",
                ));
            }
            let stamp = Stamp::of(&meta);
            if let Some(ids) = cached(&path, &stamp) {
                budget.bytes += meta.len();
                links.extend(ids);
                continue;
            }
            let mut bytes = Vec::new();
            fs::File::open(&path)?
                .take(remaining + 1)
                .read_to_end(&mut bytes)?;
            budget.bytes += bytes.len() as u64;
            if budget.bytes > MAX_BYTES {
                return Err(io::Error::other(
                    "artifact dependency scan exceeded byte limit",
                ));
            }
            let text = String::from_utf8_lossy(&bytes).replace("\\/", "/");
            let base = Url::parse(&format!(
                "https://artifact.invalid/artifacts/{}",
                rel.to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/")
            ))
            .map_err(io::Error::other)?;
            let mut ids = IndexSet::new();
            for link in LINKS.captures_iter(&text) {
                if let Some(id) = base
                    .join(&link[1])
                    .ok()
                    .and_then(|url| artifact_id_from_url(Some(url.path())))
                {
                    ids.insert(id);
                }
            }
            let ids: Vec<_> = ids.into_iter().collect();
            remember(path, stamp, ids.clone());
            links.extend(ids);
        }
    }
    Ok(())
}

pub fn retained(entries: &[Value], roots: &[PathBuf]) -> io::Result<IndexSet<String>> {
    let mut pending = VecDeque::new();
    let mut declared: HashMap<String, Vec<&str>> = HashMap::new();
    for entry in entries {
        let id = artifact_id_from_url(entry["url"].as_str());
        if let Some(id) = &id {
            declared
                .entry(id.clone())
                .or_default()
                .extend(related(entry));
        }
        if entry["permanent"] == true {
            pending.extend(id);
            pending.extend(related(entry).map(str::to_owned));
        }
    }
    let mut budget = Budget::default();
    let mut seen = IndexSet::new();
    while let Some(id) = pending.pop_front() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if seen.len() > MAX_FILES + 1 {
            return Err(io::Error::other(
                "artifact dependency scan exceeded artifact limit",
            ));
        }
        if let Some(others) = declared.get(&id) {
            pending.extend(others.iter().map(|s| s.to_string()));
        }
        for root in roots {
            scan(root, &id, &mut budget, &mut pending)?;
        }
    }
    Ok(seen)
}
