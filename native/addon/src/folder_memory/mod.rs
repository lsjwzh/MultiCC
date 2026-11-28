//! Live V8 adapters for the synchronous memory API. The filesystem inventory,
//! editing and selection share the core implementation across all four facades.
mod folders;
mod retrieval;
mod service;

use crate::{host_methods::function, route_response::*};
use multicc_core::{
    curated_memory::{
        self as core,
        rules::{Rules, LEGACY},
        snapshot,
    },
    js::{self, JsString},
};
use napi_derive::napi;
use std::{
    cell::RefCell,
    cmp::Ordering,
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

fn value(v: L<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(v.env(), v.raw(), 0, &mut Vec::new()) }
}
fn js_string(v: L<'_>) -> Result<JsString> {
    Ok(string(v)?.string()?.unwrap_or_default())
}
fn printable(v: L<'_>) -> Result<String> {
    Ok(js_string(v)?.to_string_lossy())
}
fn optional_string(v: L<'_>) -> Result<JsString> {
    if v.nullish()? {
        Ok(JsString::new())
    } else {
        js_string(v)
    }
}
fn path(v: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(printable(v)?))
}
fn undefined(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn array(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Array(vec![]))
}
fn method<'a>(
    owner: L<'a>,
    api: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    api.set_key(text(api, name)?, function(owner, name, length, count, run)?)
}
fn strings(v: L<'_>) -> Result<Vec<String>> {
    let mut out = vec![];
    if v.truthy()? {
        v.for_each(|e| {
            out.push(printable(e)?);
            Ok(())
        })?
    }
    Ok(out)
}
fn snapshot(a: L<'_>, cap: L<'_>, opts: L<'_>) -> Result<V> {
    let dir = path(a)?;
    let cap = cap.explicit_number()?.max(0.) as usize;
    let primary = strings(opts.optional(c"primaryNames")?)?;
    let markers = strings(opts.optional(c"priorityEntryMarkers")?)?;
    let mut error = None;
    let result = snapshot::build(&dir, cap, &primary, &markers, |a_name, b_name| {
        let compare = || call(text(a, a_name)?, c"localeCompare", &[text(a, b_name)?])?.number();
        if error.is_some() {
            return Ordering::Equal;
        }
        match compare() {
            Ok(n) => n.partial_cmp(&0.).unwrap_or(Ordering::Equal),
            Err(e) => {
                error = Some(e);
                Ordering::Equal
            }
        }
    });
    if let Some(e) = error {
        Err(e)
    } else {
        Ok(result)
    }
}
fn store(ports: L<'_>) -> Result<L<'_>> {
    let api = fields(
        ports,
        &[
            ("DEFAULT_CURATED_FILE", text(ports, core::FILE)?),
            ("ENTRY_DELIMITER", text(ports, core::DELIMITER)?),
        ],
    )?;
    method(ports, api, "readMemoryFolder", 3, 3, |_, a| {
        a[0].from_value(snapshot(a[0], a[1], a[2])?.get("text").unwrap())
    })?;
    method(ports, api, "buildMemoryFolderSnapshot", 2, 3, |_, a| {
        a[0].from_value(&snapshot(a[0], a[1], a[2])?)
    })?;
    method(ports, api, "scanMemoryContent", 1, 1, |_, a| {
        let s = a[0]
            .string()?
            .ok_or_else(|| a[0].type_error("content.includes is not a function"))?;
        a[0].from_value(
            &core::scan(&s.to_string_lossy())
                .map(V::from)
                .unwrap_or(V::Null),
        )
    })?;
    method(ports, api, "memoryFilePriority", 1, 2, |_, a| {
        num(
            a[0],
            snapshot::priority(&printable(fallback(a[0], "".into())?)?, &strings(a[1])?).into(),
        )
    })?;
    method(ports, api, "readCuratedEntries", 1, 1, |_, a| {
        a[0].from_value(&core::entry_list(core::entries(&path(a[0])?)?))
    })?;
    method(ports, api, "atomicWrite", 2, 2, |_, a| {
        let data = match value(a[1])? {
            V::String(s) => s.utf8_lossy_bytes(),
            V::Bytes(b) => b,
            _ => return Err(a[1].type_error("content must be a string or Buffer")),
        };
        core::write(&path(a[0])?, &data)?;
        undefined(a[0])
    })?;
    method(ports, api, "applyCuratedMemoryAction", 1, 1, |p, a| {
        let input = a[0];
        let dir = input.get(c"dir")?;
        let op = input.get(c"action")?;
        let content = input.get(c"content")?;
        let needle = input.get(c"oldText")?;
        let limit = input.get(c"charLimit")?;
        let file = input.get(c"fileName")?;
        if !dir.truthy()? {
            return p.from_value(&core::error("memory directory is required"));
        }
        let Some(op) = op.string()? else {
            return p.from_value(&core::error("action must be add, replace, or remove"));
        };
        let op = op.to_string_lossy();
        if !matches!(&*op, "add" | "replace" | "remove") {
            return p.from_value(&core::error("action must be add, replace, or remove"));
        }
        let file = path(call(
            p.get(c"path")?,
            c"join",
            &[
                dir,
                if file.undefined()? {
                    text(p, core::FILE)?
                } else {
                    file
                },
            ],
        )?)?;
        p.from_value(&core::action(
            &file,
            &op,
            optional_string(content)?,
            optional_string(needle)?,
            if limit.undefined()? {
                2200.0.into()
            } else {
                value(limit)?
            },
        ))
    })?;
    Ok(api)
}
thread_local! {
    static HOST_RENAMES: RefCell<HashSet<PathBuf>> = RefCell::new(HashSet::new());
}

// A hook that seeds the same directory recursively uses the native commit for
// its nested write. Other directories and other JS threads keep their own hook.
struct ActiveHostRename(PathBuf);
impl Drop for ActiveHostRename {
    fn drop(&mut self) {
        HOST_RENAMES.with(|active| active.borrow_mut().remove(&self.0));
    }
}

fn seed(p: L<'_>, rules: &Rules, dir: &Path) -> Result<bool> {
    let fs = p.get(c"fs")?;
    let rename = fs.get(c"renameSync")?;
    if rename.equals(p.get(c"rename")?)? {
        return Ok(rules.seed(dir)?);
    }
    let key = dir.canonicalize().unwrap_or_else(|_| dir.to_owned());
    if !HOST_RENAMES.with(|active| active.borrow_mut().insert(key.clone())) {
        return Ok(rules.seed(dir)?);
    }
    let _active = ActiveHostRename(key);
    rules.seed_with_rename(dir, |source, staged| {
        rename.call(
            fs,
            &[
                text(p, &source.to_string_lossy())?,
                text(p, &staged.to_string_lossy())?,
            ],
        )?;
        Ok(())
    })
}
fn builtin<'a>(p: L<'a>, rules: Arc<Rules>) -> Result<L<'a>> {
    let api = fields(p, &[])?;
    let legacy = fields(p, &[])?;
    let builtin = array(p)?;
    for (i, (name, k)) in [
        ("DOCS_REGISTRY_RULE", "docsRegistry"),
        ("SECRET_VAULT_RULE", "secretVault"),
        ("SHARED_FILES_RULE", "sharedFiles"),
    ]
    .into_iter()
    .enumerate()
    {
        let body = text(p, &rules.0[i])?;
        let marker = text(p, rules.marker(i))?;
        let old = p.from_value(&V::Array(vec![LEGACY[i].into()]))?.freeze()?;
        legacy.set_key(text(p, k)?, old)?;
        api.set_key(text(p, name)?, body)?;
        api.set_key(text(p, &format!("{name}_MARKER"))?, marker)?;
        builtin.set_element(
            i as u32,
            fields(
                p,
                &[("rule", body), ("marker", marker), ("legacyMarkers", old)],
            )?,
        )?;
    }
    api.set(c"LEGACY_MARKERS", legacy.freeze()?)?;
    api.set(c"BUILTIN_RULES", builtin.freeze()?)?;
    let check = rules.clone();
    method(p, api, "hasDocsRegistryRule", 1, 1, move |p, a| {
        flag(p, check.marked(&printable(a[0])?, 0))
    })?;
    method(p, api, "ensureBuiltinSharedMemory", 1, 1, move |p, a| {
        flag(p, seed(p, &rules, &path(a[0])?)?)
    })?;
    Ok(api)
}
#[napi]
pub fn folder_memory_apis(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let rules = Arc::new(Rules::load(&path(p.get(c"skills")?)?)?);
    let curated = store(p)?;
    let builtin = builtin(p, rules.clone())?;
    let retrieval = retrieval::api(p, rules.clone())?;
    let service = service::api(p, curated, retrieval, rules)?;
    Ok(fields(
        p,
        &[
            ("curatedMemoryStore", curated),
            ("builtinMemoryRules", builtin),
            ("memoryRetrievalHost", retrieval),
            ("folderMemoryService", service),
        ],
    )?
    .raw())
}
