//! Apply the planner's changes to the live board mirror before returning to the
//! caller. Existing task objects and tracked proxies keep their identities.
use crate::js_live::LiveValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_board_planning_result(
    env: Env,
    action: String,
    args: Unknown<'_>,
    output: Unknown<'_>,
    replace: Unknown<'_>,
    map_tasks: Unknown<'_>,
) -> Result<sys::napi_value> {
    let args = LiveValue::new(&env, args);
    let output = LiveValue::new(&env, output);
    let replace = LiveValue::new(&env, replace);
    let tasks = || args.get(c"board")?.get(c"tasks");
    let changes = output.get(c"changes")?;
    if changes.truthy()? {
        changes.for_each(|entry| {
            let (id, value) = entry.iterator_pair()?;
            if tasks()?.get_key(id)?.truthy()? {
                replace.call_plain(&[tasks()?.get_key(id)?, value])?;
            } else {
                tasks()?.set_key(id, value)?;
            }
            Ok(())
        })?;
    }
    let result = match action.as_str() {
        "normalizePlanningTask" => {
            replace.call_plain(&[args.get(c"task")?, output.get(c"task")?])?
        }
        "markPlannedTaskStarted" | "alignStageWithStatus" => {
            let task = args.get(c"task")?;
            if task.truthy()? {
                replace.call_plain(&[task, output.get(c"task")?])?;
            }
            output.get(c"result")?
        }
        "createPlannedTask" | "updatePlannedTask" | "movePlannedTask" | "renameTask" => {
            let result = output.get(c"result")?;
            if result.optional(c"task")?.truthy()? {
                let board_tasks = tasks()?;
                let id = result.get(c"task")?.get(c"id")?;
                result.assign(c"task", board_tasks.get_key(id)?)?;
            }
            result
        }
        "plannedTasksInStage" | "renumberStage" => {
            // Use the host map port for sparse arrays and Array species.
            LiveValue::new(&env, map_tasks)
                .call_plain(&[output.get(c"result")?, args.get(c"board")?])?
        }
        _ => output.get(c"result")?,
    };
    Ok(result.raw())
}
