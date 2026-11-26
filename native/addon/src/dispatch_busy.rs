//! Dispatch, queue diagnostics and task retention share one ordered veto list.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

#[napi]
pub fn create_dispatch_busy_reasons(env: Env, probes: Unknown<'_>) -> Result<sys::napi_value> {
    let probes = L::new(&env, probes);
    let check = function(probes, "dispatchTargetBusyReasons", 1, 1, |probes, args| {
        let id = args[0];
        let reasons = probes.from_value(&V::Array(Vec::new()))?;
        let mut count = 0;
        for (key, busy, failed) in [
            (
                c"occupied",
                "workspace_occupied",
                "workspace_occupied_check_failed",
            ),
            (c"runActive", "run_active", "run_active_check_failed"),
            (c"leased", "repo_lease", "repo_lease_check_failed"),
            (
                c"shellBusy",
                "task_shell_workspace_busy",
                "task_shell_busy_check_failed",
            ),
        ] {
            let reason = match probes.get(key)?.call_plain(&[id]) {
                Ok(result) if result.truthy()? => text(probes, busy)?,
                Ok(_) => continue,
                Err(_) => {
                    let cause = probes.exception_value()?;
                    if key == c"occupied" {
                        if let Some(cause) = cause {
                            fallback(cause.optional(c"code")?, V::from(failed))?
                        } else {
                            text(probes, failed)?
                        }
                    } else {
                        text(probes, failed)?
                    }
                }
            };
            reasons.set_element(count, reason)?;
            count += 1;
        }
        // A hint explains an existing veto. Its absence or failure cannot block delivery.
        if count > 0 {
            if let Some(hint) = probes.catch(|| probes.get(c"stuckHint")?.call_plain(&[id]))? {
                if hint.truthy()? {
                    reasons.set_element(count, hint)?;
                }
            }
        }
        Ok(reasons)
    })?;
    Ok(check.raw())
}
