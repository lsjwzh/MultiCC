//! Keep task aliases and worktrees owned by live sessions out of task cleanup.
use crate::{
    host_methods::{async_result, function},
    route_response::*,
};
use napi_derive::napi;
#[napi]
pub fn task_board_worktree_ports(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let lookup = function(p, "getBoardTask", 1, 1, |p, a| {
        let tasks = p.get(c"board")?.get(c"tasks")?;
        let own = call(p.global()?.get(c"Object")?, c"hasOwn", &[tasks, a[0]])?;
        if !own.truthy()? {
            return null(p);
        }
        let t = tasks.get_key(a[0])?;
        if t.truthy()? && !t.get(c"mergedInto")?.truthy()? {
            Ok(t)
        } else {
            null(p)
        }
    })?;
    let cleanup = function(p, "withCleanup", 3, 3, |p, a| {
        async_result(p, || {
            let deps = p.get(c"deps")?;
            if deps.get(c"withTaskWorktreeCleanup")?.kind()? == sys::ValueType::napi_function {
                return call(deps, c"withTaskWorktreeCleanup", a);
            }
            let records = call(p.get(c"records")?, c"values", &[])?;
            let copies = call(p.global()?.get(c"Array")?, c"from", &[records])?;
            for i in 0..copies.get(c"length")?.number()? as u32 {
                if copies
                    .element(i)?
                    .get(c"worktreePath")?
                    .equals(a[0].get(c"worktreePath")?)?
                {
                    return fields(
                        p,
                        &[
                            ("ok", flag(p, false)?),
                            ("code", text(p, "workspace_cleanup_unavailable")?),
                        ],
                    );
                }
            }
            let removed = a[1].call_plain(&[fields(p, &[])?])?;
            let pending = call(p.global()?.get(c"Promise")?, c"resolve", &[removed])?;
            call(pending, c"then", &[a[2]])
        })
    })?;
    Ok(fields(p, &[("getBoardTask", lookup), ("withCleanup", cleanup)])?.raw())
}
