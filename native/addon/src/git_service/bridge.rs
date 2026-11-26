//! Only live V8 values (actor options, evidence and user callbacks) remain on the
//! event loop. Nested transactions reenter the actor after the previous lease ends.
use super::{dispatch, GitContext};
use crate::{
    host_methods::{async_result, env, function, variadic_method},
    repo_actor,
    route_response::*,
};
use napi::bindgen_prelude::{FromNapiValue, JsValue as _, Promise};
use napi_derive::napi;
use serde_json::{json, Value};
mod ports;
use ports::launch;

fn js_string(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
fn undefined(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&V::Undefined)
}
fn parse<'a>(a: L<'a>, json: &str) -> Result<L<'a>> {
    call(a.global()?.get(c"JSON")?, c"parse", &[text(a, json)?])
}
fn stringify(v: L<'_>) -> Result<String> {
    js_string(call(v.global()?.get(c"JSON")?, c"stringify", &[v])?)
}
fn project<'a>(v: L<'a>, keys: &[&str]) -> Result<L<'a>> {
    if v.nullish()? {
        return Ok(v);
    }
    let out = fields(v, &[])?;
    for k in keys {
        let key = text(v, k)?;
        let val = v.get_key(key)?;
        if !val.undefined()? {
            out.set_key(key, val)?;
        }
    }
    Ok(out)
}
fn sequence<'a>(a: L<'a>, items: &[L<'a>]) -> Result<L<'a>> {
    let out = a.global()?.get(c"Array")?.construct(&[])?;
    for (i, v) in items.iter().enumerate() {
        out.set_element(i as u32, *v)?;
    }
    Ok(out)
}
fn arg_at<'a>(a: L<'a>, args: &[L<'a>], i: usize) -> Result<L<'a>> {
    match args.get(i) {
        Some(v) => Ok(*v),
        None => undefined(a),
    }
}
fn fail<'a>(a: L<'a>, message: &str) -> Result<L<'a>> {
    Err(a
        .global()?
        .get(c"Error")?
        .construct(&[text(a, message)?])?
        .throw_error())
}
fn error_text(e: L<'_>) -> Result<String> {
    for key in [c"stderr", c"message"] {
        let field = e.optional(key)?;
        if field.truthy()? {
            return Ok(js_string(field)?.trim().into());
        }
    }
    Ok(if e.truthy()? {
        js_string(e)?.trim().into()
    } else {
        String::new()
    })
}
fn permission_denied(s: &str) -> bool {
    let lower = s.to_lowercase();
    [
        "operation not permitted",
        "unable to get current working directory",
        "permission denied",
    ]
    .iter()
    .any(|v| lower.contains(v))
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|v| matches!(v, "eperm" | "eacces"))
}

fn tools_missing(s: &str) -> bool {
    [
        "xcode-select:",
        "xcrun: error:",
        "No developer tools were found",
        "invalid active developer path",
        "Command line tools are missing",
        "command line tools are missing",
    ]
    .iter()
    .any(|v| s.contains(v))
}

fn classify(s: &str) -> Option<&'static str> {
    if permission_denied(s) {
        Some("GIT_PERMISSION_DENIED")
    } else if tools_missing(s) {
        Some("GIT_TOOLS_MISSING")
    } else {
        None
    }
}
fn simple<'a>(s: L<'a>, name: &'static str, args: &[L<'a>]) -> Result<L<'a>> {
    let actor = s.get(c"actor")?;
    let cwd = arg_at(s, args, 0)?;
    let raw = if name == "gitRun" {
        arg_at(s, args, 1)?
    } else {
        parse(
            s,
            if name == "gitIsRepo" {
                r#"["rev-parse","--is-inside-work-tree"]"#
            } else {
                r#"["rev-parse","HEAD"]"#
            },
        )?
    };
    let opts = if name == "gitRun" {
        arg_at(s, args, 2)?
    } else {
        fields(s, &[])?
    };
    let job = async_result(s, || {
        if repo_actor::uses_default_run_git(actor)? {
            repo_actor::run_git(actor, cwd, raw, opts)
        } else {
            call(actor, c"runGit", &[cwd, raw, opts])
        }
    })?;
    if name == "gitRun" {
        return Ok(job);
    }
    let yes = function(s, "", 1, 1, move |s, a| {
        flag(s, name == "gitHasCommit" || js_string(a[0])? == "true")
    })?;
    let no = function(fields(s, &[("path", cwd)])?, "", 1, 1, move |s, a| {
        if name == "gitIsRepo" {
            let msg = error_text(a[0])?;
            if let Some(code) = classify(&msg) {
                let e = s.global()?.get(c"Error")?.construct(&[text(s, &msg)?])?;
                e.set(c"code", text(s, code)?)?;
                e.set(c"path", s.get(c"path")?)?;
                return Err(e.throw_error());
            }
        }
        flag(s, false)
    })?;
    call(job, c"then", &[yes, no])
}
struct Op {
    kind: &'static str,
    opts: Option<usize>,
    len: usize,
}
fn spec(name: &str) -> Op {
    let (kind, opts, len) = match name {
        "gitRun" => ("", Some(2), 2),
        "gitIsRepo" | "gitHasCommit" => ("", None, 1),
        "gitBaseBranch" => ("base-branch", None, 1),
        "gitWorktreeSnapshot" => ("worktree-snapshot", None, 1),
        "gitExportSessionBundle" => ("session-bundle-export", None, 3),
        "gitImportSessionBundle" => ("session-bundle-import", None, 4),
        "gitEnsureExcluded" => ("ensure-excluded", None, 1),
        "gitWorktreeAdd" => ("worktree-add", Some(3), 3),
        "gitWorktreeCommitAll" => ("commit-all", Some(2), 2),
        "gitWorktreeValidate" => ("worktree-validate", Some(3), 3),
        "gitWorktreeDetach" => ("worktree-detach", Some(3), 3),
        "gitWorktreeRollbackCreate" => ("worktree-create-rollback", Some(3), 3),
        "gitWorktreeRemove" => ("worktree-remove", Some(3), 3),
        "gitRebaseConflicts" => ("rebase-state", None, 1),
        "gitWorktreeMergeState" => ("merge-state", Some(2), 2),
        "gitMergeBack" => ("merge-back", Some(2), 2),
        "gitSyncFromBase" => ("sync-from-base", Some(2), 2),
        "gitRebaseResolve" => ("rebase-resolve", Some(3), 3),
        "gitCarryCollect" => ("relocate-carry-collect", None, 2),
        "gitCarryApply" => ("relocate-carry-apply", None, 3),
        "gitSplitFacts" => ("split-off-collect", None, 2),
        "gitCarryVerify" => ("split-off-verify", None, 3),
        "gitRelocateWorktree" => ("", Some(3), 3),
        "gitWorktreeSplitOff" => ("", None, 1),
        "checkMergedJsSyntax" => ("", None, 4),
        _ => unreachable!(),
    };
    Op { kind, opts, len }
}
fn scoped(name: &str) -> bool {
    matches!(
        name,
        "gitExportSessionBundle"
            | "gitImportSessionBundle"
            | "gitMergeBack"
            | "gitSyncFromBase"
            | "gitRebaseResolve"
            | "gitWorktreeMergeState"
    )
}
const OPTIONS: &[&str] = &[
    "__trackCreatedResources",
    "operationId",
    "repoKey",
    "sessionId",
    "baseBranch",
    "abortOnConflict",
    "active",
    "carry",
    "force",
    "planned",
    "requireExistingBranch",
    "skipBackup",
    "syncFromBase",
    "withMetadata",
];
const SESSION: &[&str] = &["id", "branch", "worktreePath", "workspaceState"];
fn schedule<'a>(s: L<'a>, name: &'static str, args: &[L<'a>]) -> Result<L<'a>> {
    if matches!(name, "gitRun" | "gitIsRepo" | "gitHasCommit") {
        return simple(s, name, args);
    }
    let op = spec(name);
    let first = arg_at(s, args, 0)?;
    let second = arg_at(s, args, 1)?;
    let options = match op.opts {
        Some(i) => arg_at(s, args, i)?,
        None => undefined(s)?,
    };
    let opts = call(
        s.global()?.get(c"Object")?,
        c"assign",
        &[fields(s, &[])?, options],
    )?;
    let mut cwd = first;
    let mut owned = args.to_vec();
    if scoped(name) {
        cwd = first.optional(c"path")?;
        if !owned.is_empty() {
            owned[0] = project(first, &["path", "baseBranch"])?;
        }
        if owned.len() > 1 {
            owned[1] = project(second, SESSION)?;
        }
        let wt = second.optional(c"worktreePath")?;
        let br = second.optional(c"branch")?;
        if matches!(name, "gitExportSessionBundle" | "gitImportSessionBundle") {
            if !cwd.truthy()? {
                return fail(s, "dir.path is required");
            }
            if name == "gitExportSessionBundle" && !br.truthy()? {
                return fail(s, "session.branch is required");
            }
            if name == "gitImportSessionBundle" && !wt.truthy()? {
                return fail(s, "session.worktreePath is required");
            }
            if !arg_at(s, args, 2)?.truthy()? {
                return fail(
                    s,
                    if name == "gitImportSessionBundle" {
                        "tmpBundle is required"
                    } else {
                        "tmpPath is required"
                    },
                );
            }
            if name == "gitImportSessionBundle" && !arg_at(s, args, 3)?.truthy()? {
                return fail(s, "sourceBranch is required");
            }
            if name == "gitExportSessionBundle" && owned.len() > 3 {
                let n = owned[3].explicit_number()?;
                owned[3] = if n.is_finite() {
                    num(s, n)?
                } else {
                    text(s, "Infinity")?
                };
            }
        } else if name == "gitWorktreeMergeState" && (!first.truthy()? || !second.truthy()?) {
            return parse(
                s,
                r#"{"mergeReady":false,"dirty":false,"ahead":0,"reason":"no-worktree"}"#,
            );
        } else if matches!(
            name,
            "gitMergeBack" | "gitRebaseResolve" | "gitSyncFromBase"
        ) {
            let missing = !first.truthy()?
                || !wt.truthy()?
                || (name != "gitRebaseResolve" && !br.truthy()?);
            if missing || !std::path::Path::new(&js_string(wt)?).exists() {
                let v = if name == "gitMergeBack" || !missing {
                    json!({"ok":false,"code":"worktree_missing","error":"session has no worktree"})
                } else {
                    json!({"ok":false,"error":"session has no worktree"})
                };
                return parse(s, &v.to_string());
            }
        }
        if name != "gitWorktreeMergeState" {
            opts.set(c"sessionId", second.optional(c"id")?)?;
        }
    }
    if name == "gitWorktreeSnapshot" && !first.truthy()? {
        return fail(s, "worktreePath is required");
    }
    if name == "gitRelocateWorktree" {
        for (i, v) in owned.iter_mut().take(3).enumerate() {
            *v = project(
                *v,
                if i == 2 {
                    SESSION
                } else {
                    &["path", "baseBranch"]
                },
            )?;
        }
    }
    if name == "gitWorktreeSplitOff" && owned.len() > 1 && !second.nullish()? {
        let input = project(second, &["sessionId", "baseCommit"])?;
        input.set(c"source", project(second.optional(c"source")?, SESSION)?)?;
        input.set(
            c"target",
            project(
                second.optional(c"target")?,
                &["sessionId", "worktreePath", "branch"],
            )?,
        )?;
        owned[1] = input;
    }
    if name == "gitWorktreeAdd" {
        opts.set(c"sessionId", second)?;
    }
    if matches!(
        name,
        "gitWorktreeRemove" | "gitWorktreeRollbackCreate" | "gitWorktreeDetach"
    ) && !opts.get(c"sessionId")?.truthy()?
    {
        let fallback = arg_at(s, args, 2)?;
        let val = if second.truthy()? {
            second
        } else if fallback.truthy()? {
            fallback
        } else {
            text(s, "session")?
        };
        let path = js_string(val)?;
        let id = std::path::Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        opts.set(c"sessionId", text(s, &id)?)?;
    }
    if let Some(i) = op.opts.filter(|i| *i < owned.len()) {
        owned[i] = project(opts, OPTIONS)?;
    }
    let task = fields(
        s,
        &[
            ("service", s),
            ("name", text(s, name)?),
            ("args", sequence(s, &owned)?),
            ("opts", opts),
            ("errors", s.global()?.get(c"Array")?.construct(&[])?),
        ],
    )?;
    if name == "checkMergedJsSyntax" {
        task.set(c"customGit", arg_at(s, args, 3)?)?;
    }
    if op.kind.is_empty() {
        return launch(task, undefined(s)?, name);
    }
    let run = function(task, "", 1, 1, move |task, args| {
        launch(task, args[0], name)
    })?;
    let actor = s.get(c"actor")?;
    let options = if name == "gitWorktreeAdd" && opts.get(c"planned")?.truthy()? {
        fields(s, &[("sessionId", second)])?
    } else {
        opts
    };
    let job = async_result(s, || {
        let kind = text(s, op.kind)?;
        if repo_actor::uses_default_run(actor)? {
            repo_actor::run(actor, cwd, kind, run, options)
        } else {
            call(actor, c"run", &[cwd, kind, run, options])
        }
    })?;
    if name == "gitEnsureExcluded" {
        let handle = function(s, "", 1, 1, |s, args| {
            let msg = args[0].get(c"message")?;
            call(
                s.global()?.get(c"console")?,
                c"warn",
                &[text(s, "[multicc] gitEnsureExcluded failed:")?, msg],
            )?;
            fields(s, &[("ok", flag(s, false)?), ("error", msg)])
        })?;
        return call(job, c"catch", &[handle]);
    }
    let field = match name {
        "gitBaseBranch" => Some(c"branch"),
        "gitRebaseConflicts" => Some(c"conflicts"),
        "gitWorktreeMergeState" => Some(c"state"),
        "gitWorktreeCommitAll" if !opts.get(c"withMetadata")?.truthy()? => Some(c"committed"),
        _ => None,
    };
    match field {
        Some(key) => call(
            job,
            c"then",
            &[function(s, "", 1, 1, move |_, a| a[0].get(key))?],
        ),
        None => Ok(job),
    }
}

const METHODS: &[&str] = &[
    "gitRun",
    "gitIsRepo",
    "gitHasCommit",
    "gitBaseBranch",
    "gitWorktreeSnapshot",
    "gitExportSessionBundle",
    "gitImportSessionBundle",
    "gitEnsureExcluded",
    "gitWorktreeAdd",
    "gitWorktreeCommitAll",
    "gitWorktreeValidate",
    "gitWorktreeDetach",
    "gitWorktreeRollbackCreate",
    "gitWorktreeRemove",
    "gitRebaseConflicts",
    "gitWorktreeMergeState",
    "gitMergeBack",
    "gitSyncFromBase",
    "gitRebaseResolve",
    "gitRelocateWorktree",
    "gitWorktreeSplitOff",
    "checkMergedJsSyntax",
];
#[napi]
pub fn git_service_api(
    env: Env,
    actor: Unknown<'_>,
    node_exec_path: String,
    bind_context: Unknown<'_>,
) -> Result<sys::napi_value> {
    let actor = L::new(&env, actor);
    let s = fields(
        actor,
        &[
            ("actor", actor),
            ("node", text(actor, &node_exec_path)?),
            ("bindContext", L::new(&env, bind_context)),
        ],
    )?;
    let api = fields(
        s,
        &[
            ("defaultRepoActor", actor),
            (
                "WORKTREE_SUBDIR",
                text(s, multicc_core::docs_memory_routes::WORKTREE_SUBDIR)?,
            ),
        ],
    )?;
    for &name in METHODS {
        let f = variadic_method(&env, s, name, spec(name).len, move |s, args| {
            async_result(s, || schedule(s, name, args))
        })?;
        api.set_key(text(s, name)?, f)?;
    }
    for (name, predicate) in [
        (
            "isPermissionDeniedGitError",
            permission_denied as fn(&str) -> bool,
        ),
        ("isDeveloperToolsMissingGitError", tools_missing),
    ] {
        api.set_key(
            text(s, name)?,
            function(s, name, 1, 1, move |s, a| {
                flag(s, predicate(&error_text(a[0])?))
            })?,
        )?;
    }
    Ok(api.raw())
}
