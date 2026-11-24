//! Ignore one occurrence of a task problem. Board views are fresh per operation;
//! each view resolves its problem only if a stored entry or toggle needs it.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as J;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

#[napi]
pub const AIR_TODO_IGNORE_LIMIT: u32 = 500;

#[napi]
pub fn air_todo_ignore_kinds() -> Vec<String> {
    vec!["error".into(), "waiting".into()]
}

fn array<'a>(anchor: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let result = anchor.from_value(&J::Array(vec![]))?;
    for (i, v) in values.iter().enumerate() {
        result.set_element(i as u32, *v)?;
    }
    Ok(result)
}

fn object<'a>(anchor: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let result = anchor.from_value(&J::Object(vec![]))?;
    for &(k, v) in fields {
        result.set(k, v)?;
    }
    Ok(result)
}

fn kind<'a>(kinds: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let value = raw.optional(c"kind")?;
    if kinds.get(c"has")?.call(kinds, &[value])?.truthy()? {
        raw.get(c"kind")
    } else {
        raw.from_value(&J::Null)
    }
}

fn entry<'a>(id: L<'a>, kind: L<'a>, stamp: f64) -> Result<L<'a>> {
    object(
        id,
        &[
            (c"taskId", id),
            (c"kind", kind),
            (c"stamp", id.from_value(&J::Number(stamp))?),
        ],
    )
}

#[napi]
pub fn air_normalize_ignores(
    env: Env,
    input: Unknown<'_>,
    limit: Unknown<'_>,
    kinds: Unknown<'_>,
) -> Result<sys::napi_value> {
    let list = L::new(&env, input);
    let kinds = L::new(&env, kinds);
    let limit = L::new(&env, limit);
    let mut items = Vec::new();
    if list.is_array()? {
        let seen = list.global()?.get(c"Set")?.construct(&[])?;
        list.for_each_while(|raw| {
            if !raw.truthy()? || raw.get(c"taskId")?.kind()? != sys::ValueType::napi_string {
                return Ok(true);
            }
            let value = raw.get(c"taskId")?;
            let trim = value.get(c"trim")?;
            if trim.kind()? != sys::ValueType::napi_function {
                return Err(value.type_error("raw.taskId.trim is not a function"));
            }
            let id = trim.call(value, &[])?;
            if !id.truthy()? || seen.get(c"has")?.call(seen, &[id])?.truthy()? {
                return Ok(true);
            }
            let stamp = raw.get(c"stamp")?.explicit_number()?;
            items.push(entry(
                id,
                kind(kinds, raw)?,
                if stamp.is_finite() { stamp } else { 0.0 },
            )?);
            seen.get(c"add")?.call(seen, &[id])?;
            let cap = limit.explicit_number()?;
            Ok(cap.is_nan() || (items.len() as f64) < cap)
        })?;
    }
    Ok(array(list, &items)?.raw())
}

#[derive(Copy, Clone)]
struct Problem<'a> {
    kind: L<'a>,
    occurred_at: f64,
}

fn updated_at(view: L<'_>) -> Result<f64> {
    let n = view.get(c"updatedAt")?.number()?;
    Ok(if n.is_finite() && n > 0.0 { n } else { 0.0 })
}

fn owner_unavailable(error: L<'_>) -> Result<bool> {
    error
        .optional(c"code")?
        .is_string("SESSION_WORK_OWNER_UNAVAILABLE")
}

struct Runtime<'a> {
    ports: L<'a>,
    deps: L<'a>,
    kinds: L<'a>,
}

impl<'a> Runtime<'a> {
    fn views(&self) -> Result<Option<L<'a>>> {
        self.ports
            .catch(|| self.ports.get(c"taskViews")?.call(self.ports, &[]))
    }

    fn problem(&self, view: L<'a>) -> Result<Problem<'a>> {
        let cached = view.get(c"problem")?;
        if !cached.nullish()? {
            return Ok(Problem {
                kind: cached.get(c"kind")?,
                occurred_at: cached.get(c"occurredAt")?.number()?,
            });
        }
        let empty = Problem {
            kind: self.ports.from_value(&J::Null)?,
            occurred_at: 0.0,
        };
        let found = if self.deps.get(c"problemOf")?.kind()? == sys::ValueType::napi_function {
            let inspect = || -> Result<Problem<'a>> {
                let value = self
                    .deps
                    .get(c"problemOf")?
                    .call(self.deps, &[view.get(c"task")?])?;
                if !value.truthy()? {
                    return Ok(empty);
                }
                let kind = kind(self.kinds, value)?;
                let occurred_at = if value.get(c"occurredAt")?.explicit_number()? > 0.0 {
                    value.get(c"occurredAt")?.explicit_number()?
                } else {
                    0.0
                };
                Ok(Problem { kind, occurred_at })
            };
            match inspect() {
                Ok(result) => result,
                Err(error) => {
                    let exception = self.ports.exception_value()?.ok_or(error)?;
                    if owner_unavailable(exception)? {
                        return Err(exception.throw_error());
                    }
                    empty
                }
            }
        } else {
            empty
        };
        view.set(
            c"problem",
            object(
                view,
                &[
                    (c"kind", found.kind),
                    (
                        c"occurredAt",
                        view.from_value(&J::Number(found.occurred_at))?,
                    ),
                ],
            )?,
        )?;
        Ok(found)
    }

    fn load(&self) -> Result<Vec<L<'a>>> {
        let mut items = self.ports.get(c"items")?;
        if items.nullish()? {
            items = self.ports.get(c"load")?.call(self.ports, &[])?;
            self.ports.set(c"items", items)?;
        }
        let length = items.get(c"length")?.number()? as u32;
        (0..length).map(|i| items.element(i)).collect()
    }

    fn valid(&self, item: L<'a>, view: L<'a>) -> Result<bool> {
        let stored_kind = item.get(c"kind")?;
        let stamp = item.get(c"stamp")?.number()?;
        let updated_since = updated_at(view)? > stamp;
        if !stored_kind.truthy()? {
            return Ok(!updated_since);
        }
        let problem = self.problem(view)?;
        if !problem.kind.equals(stored_kind)? || problem.occurred_at > stamp {
            return Ok(false);
        }
        Ok(problem.occurred_at > 0.0 || !updated_since)
    }

    fn effective(&self, views: Option<L<'a>>, strict: bool) -> Result<Vec<L<'a>>> {
        let Some(views) = views else {
            return self.load();
        };
        let filter = || -> Result<Vec<L<'a>>> {
            let mut kept = Vec::new();
            for item in self.load()? {
                let view = views.get(c"get")?.call(views, &[item.get(c"taskId")?])?;
                if !view.nullish()? && self.valid(item, view)? {
                    kept.push(item);
                }
            }
            Ok(kept)
        };
        match filter() {
            Err(error) if !strict => {
                let exception = self.ports.exception_value()?.ok_or(error)?;
                if owner_unavailable(exception)? {
                    self.load()
                } else {
                    Err(exception.throw_error())
                }
            }
            result => result,
        }
    }

    fn read(&self) -> Result<L<'a>> {
        let ids = self
            .effective(self.views()?, false)?
            .into_iter()
            .map(|row| row.get(c"taskId"))
            .collect::<Result<Vec<_>>>()?;
        array(self.ports, &ids)
    }

    fn refusal<T>(&self, status: u16, code: &str, message: &str) -> Result<T> {
        let e = self
            .ports
            .global()?
            .get(c"Error")?
            .construct(&[self.ports.from_value(&J::string(message))?])?;
        e.set(c"status", self.ports.from_value(&J::Number(status.into()))?)?;
        e.set(c"code", self.ports.from_value(&J::string(code))?)?;
        Err(e.throw_error())
    }

    fn todos(&self) -> Result<L<'a>> {
        if self.deps.get(c"readTodos")?.kind()? == sys::ValueType::napi_function {
            if let Some(value) = self
                .deps
                .catch(|| self.deps.get(c"readTodos")?.call(self.deps, &[]))?
            {
                return Ok(value);
            }
        }
        array(self.ports, &[])
    }

    fn toggle(&self, input: L<'a>) -> Result<L<'a>> {
        let key = input.string()?.unwrap_or_default().trim();
        if key.is_empty() {
            return self.refusal(400, "task_id_required", "taskId is required");
        }
        let Some(views) = self.views()? else {
            return self.refusal(503, "todo_ignore_unavailable", "任务表暂时不可用");
        };
        let id = input.from_value(&J::String(key))?;
        if !views.get(c"has")?.call(views, &[id])?.truthy()? {
            return self.refusal(404, "task_not_found", "任务不存在");
        }
        let view = views.get(c"get")?.call(views, &[id])?;
        let mut next = self.effective(Some(views), true)?;
        let mut previous = None;
        for (i, row) in next.iter().enumerate() {
            if row.get(c"taskId")?.equals(id)? {
                previous = Some(i);
                break;
            }
        }
        let kind = if let Some(i) = previous {
            next.remove(i).get(c"kind")?
        } else {
            let problem = self.problem(view)?;
            if !problem.kind.truthy()? {
                return self.refusal(
                    400,
                    "todo_ignore_not_applicable",
                    "只有出错或等待回复的任务可以忽略",
                );
            }
            if next.len() >= AIR_TODO_IGNORE_LIMIT as usize {
                return self.refusal(
                    409,
                    "todo_ignore_limit_reached",
                    &format!("最多只能忽略 {AIR_TODO_IGNORE_LIMIT} 个任务"),
                );
            }
            let updated = updated_at(view)?;
            let stamp = if problem.occurred_at > 0.0 {
                problem.occurred_at
            } else if updated > 0.0 {
                updated
            } else {
                let date = input.global()?.get(c"Date")?;
                date.get(c"now")?.call(date, &[])?.number()?
            };
            next.push(entry(id, problem.kind, stamp)?);
            problem.kind
        };
        let items = array(input, &next)?;
        self.ports.get(c"save")?.call(self.ports, &[items])?;
        self.ports.set(c"items", items)?;
        let kind = if kind.truthy()? {
            kind
        } else {
            input.from_value(&J::Null)?
        };
        object(
            input,
            &[
                (c"ignored", input.from_value(&J::Bool(previous.is_none()))?),
                (c"kind", kind),
                (c"taskIds", self.read()?),
                (c"todos", self.todos()?),
            ],
        )
    }
}

#[napi]
pub fn air_todo_ignore_run(
    env: Env,
    ports: Unknown<'_>,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let runtime = Runtime {
        ports,
        deps: ports.get(c"deps")?,
        kinds: ports.get(c"kinds")?,
    };
    Ok(match op.as_str() {
        "read" => runtime.read()?,
        "toggle" => runtime.toggle(L::new(&env, input))?,
        _ => {
            return Err(napi::Error::from_reason(
                "unknown Air todo ignore operation",
            ))
        }
    }
    .raw())
}
