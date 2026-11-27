use super::*;

pub(super) fn setup(p: L<'_>) -> Result<L<'_>> {
    let h = host(p)?;
    let classification = h.get(c"Classification")?.construct(&[])?;
    p.set(c"classification", classification)?;
    let cp = pick(
        p,
        &[
            c"board",
            c"records",
            c"core",
            c"recentTaskIds",
            c"loadHistory",
            c"resolvedTask",
            c"save",
            c"notify",
        ],
    )?;
    cp.set(c"isSystemInjected", deps(p)?.get(c"isSystemInjected")?)?;
    cp.set(c"noteRunState", p.get(c"attention")?.get(c"noteRunState")?)?;
    cp.set(
        c"randomUUID",
        function(p.get(c"crypto")?, "randomUUID", 0, 0, |crypto, _| {
            call(crypto, c"randomUUID", &[])
        })?,
    )?;
    let queue = deps(p)?.get(c"auxQueue")?;
    cp.set(
        c"cancel",
        function(queue, "cancel", 1, 1, |q, a| call(q, c"cancel", a))?,
    )?;
    cp.set(
        c"enqueue",
        function(p, "enqueue", 4, 4, |p, a| {
            let job_context = fields(
                p,
                &[
                    ("ports", p),
                    ("ref", a[1]),
                    ("taskId", a[2]),
                    ("jobId", a[3]),
                ],
            )?;
            let job = call(deps(p)?.get(c"auxQueue")?, c"enqueue", &[a[0]])?;
            let done = then(job, job_context, |ctx, result| {
                let p = ctx.get(c"ports")?;
                call(
                    p.get(c"classification")?,
                    c"complete",
                    &[
                        p.get(c"classificationPorts")?,
                        ctx.get(c"taskId")?,
                        ctx.get(c"jobId")?,
                        ctx.get(c"ref")?,
                        result[0],
                    ],
                )
            })?;
            recover(done, job_context, |ctx, err| {
                let p = ctx.get(c"ports")?;
                call(
                    p.get(c"classification")?,
                    c"rejected",
                    &[
                        p.get(c"classificationPorts")?,
                        ctx.get(c"taskId")?,
                        ctx.get(c"jobId")?,
                        err[0],
                    ],
                )
            })?;
            undef(p)
        })?,
    )?;
    cp.set(
        c"logFailure",
        function(p, "logFailure", 3, 3, |p, a| {
            let msg = reason(a[2])?;
            call(
                p.get(c"logger")?,
                c"log",
                &[text(
                    p,
                    &format!(
                        "[multicc/taskboard] classify {} for {}: {msg}",
                        fold_string(a[0])?,
                        fold_string(a[1])?
                    ),
                )?],
            )
        })?,
    )?;
    cp.set(
        c"logGoal",
        function(p, "logGoal", 3, 3, |p, a| {
            call(
                p.get(c"logger")?,
                c"log",
                &[text(
                    p,
                    &format!(
                        "[multicc/taskboard] onClassifyGoal: updated task {} for {} phase={}",
                        fold_string(a[0])?,
                        fold_string(a[1])?,
                        fold_string(fallback(a[2], "?".into())?)?
                    ),
                )?],
            )
        })?,
    )?;
    p.set(c"classificationPorts", cp)?;
    function(p, "scanPendingClassifications", 0, 1, |p, a| {
        let time = if a[0].undefined()? {
            call(p.global()?.get(c"Date")?, c"now", &[])?
        } else {
            a[0]
        };
        call(
            p.get(c"classification")?,
            c"scan",
            &[p.get(c"classificationPorts")?, time],
        )
    })
}
fn reason(err: L<'_>) -> Result<String> {
    let msg = err.optional(c"message")?;
    fold_string(if msg.truthy()? { msg } else { err })
}
pub(super) fn public<'a>(p: L<'a>, api: L<'a>) -> Result<()> {
    for (name, count) in [("onTurnEnd", 2), ("onClassifyGoal", 4)] {
        api.set_key(
            text(p, name)?,
            function(
                p,
                name,
                if count == 4 { 3 } else { 2 },
                count,
                move |p, a| {
                    let cp = arg(p.get(c"classificationPorts")?)?;
                    let result = if name == "onTurnEnd" {
                        task_board_turn_end(env(p), cp, arg(a[1])?, arg(a[0])?)
                    } else {
                        task_board_classify_goal(
                            env(p),
                            cp,
                            arg(a[0])?,
                            arg(a[1])?,
                            arg(a[2])?,
                            arg(default_object(a[3])?)?,
                        )
                    };
                    if let Err(err) = result {
                        let message = match p.exception_value()? {
                            Some(err) => reason(err)?,
                            None => err.reason,
                        };
                        call(
                            p.get(c"logger")?,
                            c"log",
                            &[text(
                                p,
                                &format!("[multicc/taskboard] {name} error: {message}"),
                            )?],
                        )?;
                    }
                    undef(p)
                },
            )?,
        )?;
    }
    api.set(
        c"onTaskAttributionSettled",
        function(p, "onTaskAttributionSettled", 2, 4, |p, a| {
            let messages = if a[2].undefined()? { array(p)? } else { a[2] };
            call(
                p.get(c"classification")?,
                c"settled",
                &[
                    p.get(c"classificationPorts")?,
                    a[0],
                    a[1],
                    messages,
                    default_object(a[3])?,
                ],
            )
        })?,
    )
}
