use super::*;

pub(super) fn record_id<'a>(session: L<'a>, id: L<'a>, crypto: L<'a>) -> Result<L<'a>> {
    let h = call(crypto, c"createHash", &[text(id, "sha256")?])?;
    let bytes = join(id, &[session, text(id, "\0")?, id])?;
    let updated = call(h, c"update", &[bytes, text(id, "utf8")?])?;
    let digest = call(updated, c"digest", &[text(id, "hex")?])?;
    join(
        id,
        &[
            text(id, "task_")?,
            call(digest, c"slice", &[num(id, 0.)?, num(id, 32.)?])?,
        ],
    )
}
pub(super) fn observe<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(a[0])?;
        let session = read(o, c"sessionId")?;
        let task = read(o, c"taskId")?;
        let status = with_default(read(o, c"status")?, text(p, "running")?)?;
        let detail = default_object(read(o, c"detail")?)?;
        if !session.truthy()? || !task.truthy()? {
            return Err(p.type_error("task observation requires sessionId and taskId"));
        }
        let id = record_id(session, task, p.get(c"cryptoImpl")?)?;
        let normalized = normal(detail)?;
        transaction(
            p,
            &[
                ("session", session),
                ("task", task),
                ("status", status),
                ("detail", normalized),
                ("id", id),
            ],
            c"mutate",
            |f, a| {
                let p = f.get(c"state")?;
                let time = at(p)?;
                let id = f.get(c"id")?;
                let rows = a[0].get(c"tasks")?;
                let mut task = rows.get_key(id)?;
                let detail = f.get(c"detail")?;
                let status = f.get(c"status")?;
                if !task.truthy()? {
                    task = fields(
                        f,
                        &[
                            ("id", id),
                            ("taskId", string(f.get(c"task")?)?),
                            ("parentSessionId", string(f.get(c"session")?)?),
                            ("status", text(f, "running")?),
                            ("kind", fallback(detail.get(c"kind")?, "task".into())?),
                            (
                                "description",
                                fallback(detail.get(c"description")?, "".into())?,
                            ),
                            ("toolUseId", fallback(detail.get(c"toolUseId")?, V::Null)?),
                            ("outputFile", fallback(detail.get(c"outputFile")?, V::Null)?),
                            ("lastOutput", text(f, "")?),
                            ("error", null(f)?),
                            ("createdAt", time),
                            ("updatedAt", time),
                            ("completedAt", null(f)?),
                        ],
                    )?;
                    write_entry(rows, id, task)?;
                }
                if terminal(p, task.get(c"status")?, c"TERMINAL_TASK_STATES")?
                    && !task.get(c"status")?.equals(status)?
                {
                    let out = copy(task)?;
                    out.set(c"idempotent", flag(f, true)?)?;
                    return Ok(out);
                }
                task.assign(c"status", status)?;
                task.assign(c"updatedAt", time)?;
                if detail.get(c"kind")?.truthy()? {
                    task.assign(c"kind", detail.get(c"kind")?)?;
                }
                if detail.get(c"description")?.truthy()? {
                    task.assign(
                        c"description",
                        slice(detail.get(c"description")?, 0., Some(1000.))?,
                    )?;
                }
                for k in [c"toolUseId", c"outputFile"] {
                    if detail.get(k)?.truthy()? {
                        task.assign(k, string(detail.get(k)?)?)?;
                    }
                }
                if !detail.get(c"lastOutput")?.nullish()? {
                    task.assign(
                        c"lastOutput",
                        slice(detail.get(c"lastOutput")?, -4000., None)?,
                    )?;
                }
                if !detail.get(c"error")?.nullish()? {
                    task.assign(c"error", slice(detail.get(c"error")?, 0., Some(2000.))?)?;
                }
                if terminal(p, status, c"TERMINAL_TASK_STATES")? {
                    let prior = task.get(c"completedAt")?;
                    task.assign(c"completedAt", if prior.truthy()? { prior } else { time })?;
                }
                copy(task)
            },
        )
    })
}
pub(super) fn interrupt<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        transaction(p, &[], c"mutate", |f, a| {
            let p = f.get(c"state")?;
            let time = at(p)?;
            let result = array(p)?;
            let states = p.get(c"TERMINAL_TASK_STATES")?;
            let excluded = call(f.global()?.get(c"Array")?, c"from", &[states])?;
            let filter = fields(f, &[("status", fields(f, &[("$nin", excluded)])?)])?;
            candidates(a[0],c"tasks",filter)?.for_each(|task|{
            if terminal(p,task.get(c"status")?,c"TERMINAL_TASK_STATES")? {return Ok(());}
            task.assign(c"status",text(f,"interrupted")?)?;
            task.assign(c"error",text(f,"MultiCC restarted; the CLI-owned task cannot be proven alive or resumed")?)?;
            task.assign(c"completedAt",time)?;task.assign(c"updatedAt",time)?;
            let id=join(f,&[text(f,"task:")?,task.get(c"id")?,text(f,":interrupted")?])?;
            let msg=join(f,&[text(f,"🔇【内置任务已中断】Task/Agent ")?,task.get(c"taskId")?,text(f," 在 MultiCC 服务重启时仍未结束；CLI 子进程无法被可靠恢复，系统没有假定它仍在运行。请检查已有输出后决定是否重跑。")?])?;
            let payload=fields(f,&[("type",text(f,"task.interrupted")?),("taskId",task.get(c"taskId")?),("deliveryText",msg)])?;
            result_outbox(p,a[0],id,task.get(c"parentSessionId")?,payload,fields(f,&[("type",text(f,"task")?),("taskId",task.get(c"id")?)])?,time)?;
            call(result,c"push",&[copy(task)?])?;Ok(())
        })?;
            Ok(result)
        })
    })
}
