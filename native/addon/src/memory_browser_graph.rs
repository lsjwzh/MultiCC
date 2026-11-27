//! The scan runs off-thread for the production filesystem. Only after it
//! finishes do we ask the live maps for display names and session state.
use crate::{host_api::*, host_methods::raw};
use multicc_core::memory_browser_scan::{self as scan, Files, NativeFiles, View};
use napi::{
    bindgen_prelude::{AsyncTask, ToNapiValue},
    ScopedTask,
};
use std::{
    collections::VecDeque,
    ffi::CStr,
    path::{Path, PathBuf},
};

struct Job {
    root: PathBuf,
    view: View,
    limit: usize,
    filter: Option<String>,
}
impl<'task> ScopedTask<'task> for Job {
    type Output = V;
    type JsValue = Unknown<'task>;
    fn compute(&mut self) -> Result<V> {
        let mut files = NativeFiles::new(&self.root);
        let Ok(dto) = scan::scan(
            &mut files,
            &self.root,
            self.view,
            self.limit,
            self.filter.as_deref(),
        );
        Ok(dto)
    }
    fn resolve(&mut self, env: &'task Env, dto: V) -> Result<Unknown<'task>> {
        let value = unsafe { crate::js_bridge::write_value(env.raw(), &dto)? };
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), value) })
    }
}

struct LiveFiles<'a> {
    owner: L<'a>,
    fs: L<'a>,
    root: L<'a>,
    projects: VecDeque<L<'a>>,
    sessions: VecDeque<L<'a>>,
}
impl<'a> LiveFiles<'a> {
    fn path(&self, path: &Path) -> Result<L<'a>> {
        text(self.fs, &path.to_string_lossy())
    }
    fn safe(&self, path: L<'a>) -> Result<bool> {
        let fs = self.fs;
        if !call(fs, c"existsSync", &[self.root])?.truthy()? {
            return Ok(false);
        }
        let real = call(fs, c"realpathSync", &[self.root])?
            .coerce_string()?
            .to_string_lossy();
        if !call(fs, c"existsSync", &[path])?.truthy()? {
            return Ok(false);
        }
        let candidate = call(fs, c"realpathSync", &[path])?
            .coerce_string()?
            .to_string_lossy();
        Ok(Path::new(&candidate).starts_with(Path::new(&real)))
    }
    fn entries(&self, path: &Path, directories: bool) -> Result<Vec<String>> {
        let path = self.path(path)?;
        if !self.safe(path)? {
            return Ok(vec![]);
        }
        let entries = if directories {
            let options = fields(self.fs, &[("withFileTypes", flag(self.fs, true)?)])?;
            call(self.fs, c"readdirSync", &[path, options])?
        } else {
            call(self.fs, c"readdirSync", &[path])?
        };
        let mut names = Vec::new();
        entries.for_each(|entry| {
            let name = if directories {
                if !call(entry, c"isDirectory", &[])?.truthy()? {
                    return Ok(());
                }
                entry.get(c"name")?
            } else {
                entry
            };
            if let Some(s) = name.string()? {
                names.push(s.to_string_lossy());
            }
            Ok(())
        })?;
        Ok(names)
    }
}
impl Files for LiveFiles<'_> {
    type Error = napi::Error;
    fn directories(&self, dir: &Path) -> Vec<String> {
        self.fs
            .catch(|| self.entries(dir, true))
            .ok()
            .flatten()
            .unwrap_or_default()
    }
    fn names(&self, dir: &Path) -> Vec<String> {
        self.fs
            .catch(|| self.entries(dir, false))
            .ok()
            .flatten()
            .unwrap_or_default()
    }
    fn read(&self, path: &Path, timestamp: bool) -> Option<(String, Option<String>)> {
        self.fs
            .catch(|| {
                let file = self.path(path)?;
                if !self.safe(file)? {
                    return Ok(None);
                }
                let raw = call(self.fs, c"readFileSync", &[file, text(file, "utf8")?])?
                    .coerce_string()?
                    .to_string_lossy();
                let mtime = if timestamp {
                    self.fs.catch(|| {
                        let time = call(self.fs, c"statSync", &[file])?.get(c"mtime")?;
                        Ok(call(time, c"toISOString", &[])?
                            .coerce_string()?
                            .to_string_lossy())
                    })?
                } else {
                    None
                };
                Ok(Some((raw, mtime)))
            })
            .ok()
            .flatten()
            .flatten()
    }
    fn project(&mut self, id: &str) -> Result<()> {
        self.projects
            .push_back(lookup(self.owner, c"directories", text(self.owner, id)?)?);
        Ok(())
    }
    fn session(&mut self, id: &str) -> Result<()> {
        self.sessions.push_back(lookup(
            self.owner,
            c"persistedSessions",
            text(self.owner, id)?,
        )?);
        Ok(())
    }
}
fn lookup<'a>(owner: L<'a>, map: &CStr, id: L<'a>) -> Result<L<'a>> {
    call(owner.get(c"deps")?.get(map)?, c"get", &[id])
}
fn next_record<'a>(
    owner: L<'a>,
    records: &mut VecDeque<L<'a>>,
    map: &CStr,
    id: L<'a>,
) -> Result<L<'a>> {
    match records.pop_front() {
        Some(record) => Ok(record),
        None => lookup(owner, map, id),
    }
}
// Only links whose object counter inherited a method need host coercion. The
// worker leaves the parts in encounter order and supplies their edge indices.
fn finish_inherited_edges(dto: L<'_>) -> Result<()> {
    let indices = dto.get(c"inheritedEdgeIndices")?;
    if indices.undefined()? {
        return Ok(());
    }
    let edges = dto.get(c"edges")?;
    let counters = fields(dto, &[])?;
    indices.for_each(|index| {
        let edge = edges.get_key(index)?;
        let parts = edge.get(c"strength")?;
        let mut number = 0.;
        let mut string = None::<multicc_core::js::JsString>;
        parts.for_each(|part| {
            if let Some(n) = part.number_value()? {
                if let Some(value) = string.as_mut() {
                    value.push(&part.coerce_string()?);
                } else {
                    number += n;
                }
                return Ok(());
            }
            let initial = counters.get_key(part.element(0)?)?;
            let count = part.element(1)?.number()? as usize;
            if !initial.truthy()? || initial.number_value()?.is_some() {
                let block = if initial.truthy()? {
                    initial.number()?
                } else {
                    0.
                } + count as f64;
                if let Some(value) = string.as_mut() {
                    value.push(&num(dto, block)?.coerce_string()?);
                } else {
                    number += block;
                }
            } else {
                if string.is_none() {
                    string = Some(num(dto, number)?.coerce_string()?);
                }
                if let Some(value) = string.as_mut() {
                    value.push(&initial.coerce_string()?);
                    value.push_str(&"1".repeat(count));
                }
            }
            Ok(())
        })?;
        let strength = match string {
            Some(value) => dto.from_value(&V::String(value))?,
            None => num(dto, number)?,
        };
        edge.set(c"strength", strength)
    })?;
    dto.delete(c"inheritedEdgeIndices")
}
fn finish<'a>(
    owner: L<'a>,
    dto: L<'a>,
    view: View,
    mut projects: VecDeque<L<'a>>,
    mut sessions: VecDeque<L<'a>>,
) -> Result<L<'a>> {
    if view == View::Graph {
        finish_inherited_edges(dto)?;
    } else {
        // JS accepts integer-valued Numbers above usize::MAX as display limits.
        dto.get(c"meta")?.set(c"maxFiles", owner.get(c"treeLimit")?)?;
    }
    let mut visible = Vec::new();
    dto.get(c"projects")?.for_each(|project| {
        let id = project.get(c"dirId")?;
        let dir = next_record(owner, &mut projects, c"directories", id)?;
        let graph = view == View::Graph;
        let count = project
            .get(if graph { c"count" } else { c"fileCount" })?
            .number()?;
        if !graph {
            project.get(c"sessions")?.for_each(|entry| {
                let id = entry.get(c"sessionId")?;
                let record = next_record(owner, &mut sessions, c"persistedSessions", id)?;
                if record.truthy()? {
                    if record.get(c"label")?.truthy()? {
                        entry.set(c"label", record.get(c"label")?)?;
                    }
                    entry.set(c"cli", fallback(record.get(c"cli")?, V::Null)?)?;
                    entry.set(c"live", flag(entry, true)?)?;
                }
                Ok(())
            })?;
        }
        if count == 0. && (!graph || !dir.optional(c"name")?.truthy()?) {
            return Ok(());
        }
        let name = dir.optional(c"name")?;
        project.set(
            c"name",
            if name.truthy()? {
                name
            } else {
                call(id, c"slice", &[num(id, 0.)?, num(id, 8.)?])?
            },
        )?;
        if !graph {
            project.set(c"dirPath", fallback(dir.optional(c"path")?, V::Null)?)?;
        }
        let rank = if graph {
            count
        } else {
            project.get(c"tokens")?.number()?
        };
        visible.push((rank, project));
        Ok(())
    })?;
    visible.sort_by(|a, b| b.0.total_cmp(&a.0));
    let out = array(dto)?;
    for (i, (_, row)) in visible.into_iter().enumerate() {
        out.set_element(i as u32, row)?;
    }
    dto.set(c"projects", out)?;
    Ok(dto)
}

fn run<'a>(owner: L<'a>, arg: L<'a>, view: View, background: bool) -> Result<L<'a>> {
    let root = owner.get(c"root")?;
    let mut job = Job {
        root: root.coerce_string()?.to_string_lossy().into(),
        view,
        limit: owner
            .get(if view == View::Tree {
                c"treeLimit"
            } else {
                c"graphLimit"
            })?
            .number()? as usize,
        filter: if view == View::Graph && arg.truthy()? && !arg.is_string("all")? {
            Some(
                arg.string()?
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default(),
            )
        } else {
            None
        },
    };
    if background {
        let task = AsyncTask::new(job);
        let handle = unsafe { AsyncTask::to_napi_value(owner.env(), task) }?;
        let done = function(owner, "applyMemoryLabels", 1, 1, move |owner, args| {
            finish(owner, args[0], view, VecDeque::new(), VecDeque::new())
        })?;
        return call(raw(owner, handle), c"then", &[done]);
    }
    let mut files = LiveFiles {
        owner,
        fs: owner.get(c"fs")?,
        root,
        projects: VecDeque::new(),
        sessions: VecDeque::new(),
    };
    let dto = scan::scan(
        &mut files,
        &job.root,
        view,
        job.limit,
        job.filter.take().as_deref(),
    )?;
    finish(
        owner,
        owner.from_value(&dto)?,
        view,
        files.projects,
        files.sessions,
    )
}

pub(crate) fn attach<'a>(api: L<'a>, deps: L<'a>, root: L<'a>) -> Result<()> {
    fn limit<'a>(deps: L<'a>, key: &CStr, default: f64) -> Result<L<'a>> {
        let n = deps.get(key)?.number_value()?.unwrap_or(0.);
        num(
            deps,
            if n > 0. && n.fract() == 0. {
                n
            } else {
                default
            },
        )
    }
    let owner = fields(
        deps,
        &[
            ("deps", deps),
            ("fs", deps.get(c"fs")?),
            ("root", root),
            ("graphLimit", limit(deps, c"maxGraphNodes", 600.)?),
            ("treeLimit", limit(deps, c"maxTreeFiles", 2000.)?),
        ],
    )?;
    let background = deps.get(c"nativeMemoryScan")?.truthy()?;
    for (key, async_key, view, arity) in [
        ("buildMemoryGraph", "buildMemoryGraphAsync", View::Graph, 1),
        ("buildMemoryTree", "buildMemoryTreeAsync", View::Tree, 0),
    ] {
        let f = function(owner, key, arity, 1, move |owner, args| {
            run(owner, args[0], view, false)
        })?;
        api.define_key(text(api, key)?, f)?;
        if background {
            let f = function(owner, async_key, arity, 1, move |owner, args| {
                run(owner, args[0], view, true)
            })?;
            call(
                api.global()?.get(c"Object")?,
                c"defineProperty",
                &[api, text(api, async_key)?, fields(api, &[("value", f)])?],
            )?;
        }
    }
    Ok(())
}
