//! 单任务的分类作业生命周期。提交前记录作业，回执按同一任务及作业 ID 消费一次。
use super::*;
use context::{Input, Resolution};

impl TaskBoardClassification {
    pub(super) fn on_settled<'a>(
        &self,
        host: Host<'a>,
        session: L<'a>,
        id: L<'a>,
        messages: L<'a>,
        meta: L<'a>,
    ) -> Result<L<'a>> {
        let task = if id.truthy()? {
            host.tasks()?.get_key(id)?
        } else {
            host.null()?
        };
        if !task.optional(c"moduleAssignment")?.truthy()?
            || task.get(c"status")?.is_string("archived")?
        {
            return host.error(if task.truthy()? {
                "not_pending"
            } else {
                "task_not_found"
            });
        }
        let (user, assistant) = context::settled_messages(host, messages)?;
        let text = host.text(user)?;
        let rec = host.record(session)?;
        let mut input = if text.truthy()? {
            Input {
                user: text,
                reply: host.value("")?,
                reference: host.object(&[
                    (c"sessionId", session),
                    (c"dirId", rec.optional(c"dirId")?.or(|| host.dir(task))?),
                    (c"dirLabel", host.null()?),
                    (c"userMsgId", user.optional(c"id")?.or(|| host.null())?),
                    (
                        c"assistantMsgId",
                        assistant.optional(c"id")?.or(|| host.null())?,
                    ),
                    (
                        c"ts",
                        assistant
                            .optional(c"ts")?
                            .or(|| user.optional(c"ts"))?
                            .or(|| host.now())?,
                    ),
                    (c"excerpt", context::slice(text, 140)?),
                ])?,
            }
        } else {
            match context::resolve(host, task)? {
                Resolution::Found(input) => input,
                Resolution::Missing => return host.error("missing_context"),
                Resolution::Unreadable => return host.error("context_unavailable"),
            }
        };
        let run = meta.get(c"runId")?;
        let attribution = if run.truthy()? {
            context::explicit_string(host, run)?.coerce_string()?
        } else {
            let mut key = user
                .optional(c"id")?
                .or(|| input.reference.get(c"userMsgId"))?
                .or(|| host.value(""))?
                .coerce_string()?;
            key.push_str(":");
            key.push(
                &assistant
                    .optional(c"id")?
                    .or(|| input.reference.get(c"assistantMsgId"))?
                    .or(|| host.value(""))?
                    .coerce_string()?,
            );
            key
        };
        let key = task.get(c"id")?.coerce_string()?;
        if !attribution.is_empty() && self.handled.borrow().get(&key) == Some(&attribution) {
            return host.error("attribution_already_handled");
        }
        input.reply = input.reply.or(|| host.text(assistant))?;
        let result = self.enqueue(host, task.get(c"id")?, input)?;
        if result.get(c"queued")?.truthy()? && !attribution.is_empty() {
            let key = task.get(c"id")?.coerce_string()?;
            self.handled.borrow_mut().insert(key, attribution);
        }
        Ok(result)
    }

    fn enqueue<'a>(&self, host: Host<'a>, id: L<'a>, mut input: Input<'a>) -> Result<L<'a>> {
        let task = host.tasks()?.get_key(id)?;
        let assignment = task.optional(c"moduleAssignment")?;
        if !assignment.truthy()? {
            return host.error("not_pending");
        }
        if task.get(c"status")?.is_string("archived")? {
            return host.error("task_archived");
        }
        let key = id.coerce_string()?;
        if self.pending.borrow().contains_key(&key) {
            return host.error("classification_running");
        }
        if assignment
            .get(c"attempts")?
            .or(|| host.value(0.0))?
            .number()?
            >= 2.0
        {
            return host.error("automatic_attempt_limit");
        }
        input.reply = input
            .reply
            .or(|| host.value("（尚无助手回复，仅根据用户提交的任务信息归类）"))?;
        let job = host.0.invoke(c"randomUUID", &[])?;
        let job_key = job.coerce_string()?;
        self.pending.borrow_mut().insert(key.clone(), job_key);
        let attempts = task
            .get(c"moduleAssignment")?
            .get(c"attempts")?
            .or(|| host.value(0.0))?;
        // 较早的数据可能持久化了字符串计数；原有 + 1 会拼接。
        let next = if let Some(mut n) = attempts.string()? {
            n.push_str("1");
            host.value(J::String(n))?
        } else {
            host.value(attempts.number()? + 1.0)?
        };
        save_assignment(
            host,
            task,
            &[
                (c"running", host.value(true)?),
                (c"attempts", next),
                (c"lastAttemptAt", host.now()?),
                (c"lastError", host.value("")?),
            ],
        )?;
        let send = || -> Result<()> {
            let system = host.value(prompts::task_board_system_prompt(false))?;
            let prompt = prompts::targeted(host, task, &input)?;
            let meta = host.object(&[
                (c"sessionName", input.reference.get(c"sessionId")?),
                (c"sessionId", input.reference.get(c"sessionId")?),
                (c"taskId", id),
            ])?;
            let message = host.object(&[
                (c"id", job),
                (c"type", host.value("task_tag")?),
                (c"systemPrompt", system),
                (c"prompt", prompt),
                (c"meta", meta),
            ])?;
            host.0
                .invoke(c"enqueue", &[message, input.reference, id, job])?;
            Ok(())
        };
        if let Err(error) = send() {
            let cause = match host.0.exception_value()? {
                Some(cause) => cause,
                None => host.value(error.to_string())?,
            };
            self.pending.borrow_mut().remove(&key);
            host.0
                .invoke(c"logFailure", &[host.value("enqueue failed")?, id, cause])?;
            self.fail(host, id, host.value("enqueue_failed")?)?;
            return host.error("enqueue_failed");
        }
        host.object(&[(c"ok", host.value(true)?), (c"queued", host.value(true)?)])
    }

    pub(super) fn take_job(&self, id: L, job: L) -> Result<bool> {
        let key = id.coerce_string()?;
        let job = job.coerce_string()?;
        let mut pending = self.pending.borrow_mut();
        if pending.get(&key) != Some(&job) {
            return Ok(false);
        }
        pending.remove(&key);
        Ok(true)
    }

    pub(super) fn fail<'a>(&self, host: Host<'a>, id: L<'a>, error: L<'a>) -> Result<()> {
        let task = host.tasks()?.get_key(id)?;
        if task.optional(c"moduleAssignment")?.truthy()? {
            let reason =
                context::explicit_string(host, error.or(|| host.value("classification_failed"))?)?;
            save_assignment(
                host,
                task,
                &[
                    (c"running", host.value(false)?),
                    (c"lastError", context::slice(reason, 200)?),
                ],
            )?;
        }
        Ok(())
    }

    pub(super) fn apply_result<'a>(
        &self,
        host: Host<'a>,
        id: L<'a>,
        job: L<'a>,
        reference: L<'a>,
        result: L<'a>,
    ) -> Result<()> {
        if !self.take_job(id, job)? {
            return Ok(());
        }
        let task = host.tasks()?.get_key(id)?;
        if !task.optional(c"moduleAssignment")?.truthy()? || task.get(c"deleting")?.truthy()? {
            return Ok(());
        }
        if task.get(c"status")?.is_string("archived")? {
            return save_assignment(
                host,
                task,
                &[
                    (c"running", host.value(false)?),
                    (c"lastError", host.value("classification_cancelled")?),
                ],
            );
        }
        if !result.truthy()? || result.get(c"cancelled")?.truthy()? {
            return self.fail(host, id, host.value("classification_cancelled")?);
        }
        let entries = host
            .core(c"parseTagResult", &[result.get(c"text")?])?
            .get(c"tasks")?;
        let mut entry = None;
        for i in 0..entries.length()? {
            let candidate = entries.element(i)?;
            if candidate.get(c"id")?.equals(id)?
                || (candidate.get(c"id")?.truthy()?
                    && host.tasks()?.get_key(candidate.get(c"id")?)?.truthy()?)
            {
                entry = Some(candidate);
                break;
            }
        }
        let entry = match entry {
            Some(value) => value,
            None => entries.element(0)?,
        };
        if !entry.truthy()? {
            return self.fail(host, id, host.value("empty_classification")?);
        }
        let applied = host.core(
            c"applyTaskClassification",
            &[host.board()?, id, entry, reference, host.now()?],
        )?;
        if !applied.get(c"ok")?.truthy()? {
            return self.fail(host, id, applied.get(c"error")?);
        }
        let key = id.coerce_string()?;
        self.handled.borrow_mut().remove(&key);
        host.save()?;
        host.0.invoke(
            c"notify",
            &[reference.get(c"dirId")?, applied.get(c"touched")?],
        )?;
        Ok(())
    }

    pub(super) fn archive<'a>(&self, host: Host<'a>, task: L<'a>) -> Result<bool> {
        if !task.optional(c"moduleAssignment")?.truthy()?
            || task.get(c"status")?.is_string("archived")?
            || task.get(c"deleting")?.truthy()?
        {
            return Ok(false);
        }
        let key = task.get(c"id")?.coerce_string()?;
        let job = self.pending.borrow_mut().remove(&key);
        if let Some(job) = job {
            host.0
                .catch(|| host.0.invoke(c"cancel", &[host.value(J::String(job))?]))?;
        }
        let dir = host.dir(task)?;
        task.assign(c"status", host.value("archived")?)?;
        task.get(c"moduleAssignment")?
            .assign(c"running", host.value(false)?)?;
        task.get(c"moduleAssignment")?
            .assign(c"lastError", host.value("missing_context")?)?;
        task.assign(c"updatedAt", host.now()?)?;
        host.save()?;
        host.notify(dir, task)?;
        self.handled.borrow_mut().remove(&key);
        Ok(true)
    }

    pub(super) fn recover<'a>(&self, host: Host<'a>, now: L<'a>) -> Result<u32> {
        let tasks = host
            .0
            .global()?
            .get(c"Object")?
            .invoke(c"values", &[host.tasks()?])?;
        let mut changed = 0;
        for i in 0..tasks.length()? {
            let task = tasks.element(i)?;
            let assignment = task.get(c"moduleAssignment")?;
            if !assignment.truthy()?
                || task.get(c"status")?.is_string("archived")?
                || task.get(c"deleting")?.truthy()?
            {
                continue;
            }
            let error = if assignment.get(c"lastError")?.is_string("missing_context")? {
                match context::resolve(host, task)? {
                    Resolution::Unreadable => "context_unavailable",
                    Resolution::Found(_) => "",
                    Resolution::Missing => {
                        changed += u32::from(self.archive(host, task)?);
                        continue;
                    }
                }
            } else {
                if !assignment.get(c"running")?.truthy()? {
                    continue;
                }
                let key = task.get(c"id")?.coerce_string()?;
                if self.pending.borrow().contains_key(&key) {
                    continue;
                }
                assignment.assign(c"running", host.value(false)?)?;
                "classification_interrupted"
            };
            assignment.assign(c"lastError", host.value(error)?)?;
            task.assign(c"updatedAt", now)?;
            host.save()?;
            host.notify(host.dir(task)?, task)?;
            changed += 1;
        }
        Ok(changed)
    }
}

fn save_assignment<'a>(host: Host<'a>, task: L<'a>, patch: &[(&CStr, L<'a>)]) -> Result<()> {
    let previous = task.get(c"moduleAssignment")?;
    let assignment = host.object(&[
        (c"running", host.value(false)?),
        (c"attempts", host.value(0.0)?),
        (c"lastAttemptAt", host.value(0.0)?),
        (c"lastError", host.value("")?),
        (c"seed", host.value("")?),
    ])?;
    assignment.spread_from(previous)?;
    for (key, value) in patch {
        assignment.set(key, *value)?;
    }
    task.assign(c"moduleAssignment", assignment)?;
    task.assign(c"updatedAt", host.now()?)?;
    host.save()?;
    let module = task.get(c"moduleId")?;
    let dir = if module.truthy()? {
        host.board()?
            .get(c"modules")?
            .get_key(task.get(c"moduleId")?)?
            .optional(c"dirId")?
    } else {
        host.null()?
    };
    let dir = dir.or(|| {
        let refs = task.get(c"refs")?;
        for i in 0..refs.length()? {
            let r = refs.element(i)?;
            if r.get(c"dirId")?.truthy()? {
                return r.get(c"dirId")?.or(|| host.null());
            }
        }
        host.null()
    })?;
    host.notify(dir, task)
}
