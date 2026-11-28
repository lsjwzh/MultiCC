//! 常驻车道在物理进程启动前固定配置；每个回合仍持有自己的重试和结果归属。
use super::*;
use multicc_core::agy_stream::{effort, resident};
use std::collections::BTreeMap;

fn strings(value: L<'_>) -> Result<Vec<String>> {
    let mut args = Vec::new();
    value.for_each(|v| {
        args.push(v.coerce_string()?.to_string_lossy());
        Ok(())
    })?;
    Ok(args)
}

pub(super) fn configure(st: Stream<'_>, opts: L<'_>) -> Result<()> {
    let s = st.state;
    let env = s.get(c"childEnv")?;
    st.service(
        c"routerToolHost",
        c"prepareResidentMcp",
        &[env, st.record.get(c"cli")?, st.cs.get(c"cwd")?],
    )?;
    let args = resident::base_args(&strings(st.invocation.get(c"args")?)?);
    let gateway = st.port(c"gatewayPath", &[])?;
    let cmd = st
        .invocation
        .get(c"cmd")?
        .coerce_string()?
        .to_string_lossy();
    let mut argv = vec!["agy-stream-bridge".to_owned(), cmd];
    argv.extend(args);
    let mut vars = BTreeMap::new();
    let keys = call(s.global()?.get(c"Object")?, c"keys", &[env])?;
    keys.for_each(|key| {
        let val = env.get_key(key)?;
        if !val.undefined()? {
            vars.insert(
                key.coerce_string()?.to_string_lossy(),
                val.coerce_string()?.to_string_lossy(),
            );
        }
        Ok(())
    })?;
    let selection = s.get(c"spawnOpts")?;
    let mut identity = vec![gateway.coerce_string()?.to_string_lossy()];
    // 未选模型时，effectiveModel 会在首次 init 后从空值变成 reportedModel。
    // 实际传给子进程的模型已在 argv 中，收到报告本身不会改变启动配置。
    for key in [c"agyAccountKey", c"rawModel", c"rawEffort"] {
        identity.push(selection.optional(key)?.coerce_string()?.to_string_lossy());
    }
    identity.push(
        st.invocation
            .get(c"payload")?
            .coerce_string()?
            .to_string_lossy()
            .trim_start()
            .starts_with('/')
            .to_string(),
    );
    let fingerprint = resident::config_key(
        &argv,
        &st.cs.get(c"cwd")?.coerce_string()?.to_string_lossy(),
        &vars,
        &identity,
    )
    .map_err(|err| napi::Error::from_reason(format!("读取 agy 启动配置失败：{err}")))?;
    let expires = st.cs.get(c"_routerToolProcess")?.optional(c"expiresAt")?;
    if !expires.nullish()? {
        opts.set(
            c"rotateCapability",
            flag(
                s,
                expires.number()? <= call(s.global()?.get(c"Date")?, c"now", &[])?.number()?,
            )?,
        )?;
    }
    opts.set(c"launchKey", text(s, &fingerprint)?)?;
    opts.set(c"relocateWhenIdle", flag(s, true)?)?;
    opts.set(c"cmd", gateway)?;
    opts.set(
        c"onSpawn",
        st.callback("onSpawn", 1, |st, a| {
            let capability = st.cs.get(c"_routerToolProcess")?;
            if !capability.nullish()? {
                call(capability, c"bind", &[a[0]])?;
            }
            undefined(st.state)
        })?,
    )?;
    opts.set(
        c"baseArgs",
        s.from_value(&V::Array(argv.into_iter().map(V::from).collect()))?,
    )?;
    if !opts.get(c"resume")?.truthy()? {
        opts.set(c"sessionId", null(s)?)?;
    }
    Ok(())
}

pub(super) fn defer(st: Stream<'_>, evt: L<'_>) -> Result<bool> {
    if !st
        .invocation
        .get(c"streamBackend")?
        .is_string("agy-stream-json")?
    {
        return Ok(false);
    }
    let s = st.state;
    let kind = evt.optional(c"event")?;
    let result = evt.optional(c"result")?;
    if kind.is_string("result")?
        && !result.optional(c"status")?.is_string("SUCCESS")?
        && result
            .optional(c"error")?
            .string()?
            .is_some_and(|v| effort::unsupported(&v.to_string_lossy()))
        && strings(st.invocation.get(c"args")?)?
            .iter()
            .any(|a| a == "--effort")
    {
        s.set(c"agyRejection", evt)?;
        return Ok(true);
    }
    if !kind.is_string("init")? {
        s.set(c"agyOutputObserved", flag(s, true)?)?;
    }
    Ok(false)
}

pub(super) fn retry(st: Stream<'_>) -> Result<bool> {
    let s = st.state;
    let evt = s.get(c"agyRejection")?;
    if !evt.truthy()? {
        return Ok(false);
    }
    let runner = s.get(c"runner")?;
    if !st
        .port(c"isCurrentTurnRunner", &[st.cs, st.turn, runner])?
        .truthy()?
    {
        return Ok(false);
    }
    let facts = st.service(c"attemptRuntime", c"snapshot", &[st.session])?;
    let blocked = s.get(c"agyOutputObserved")?.truthy()?
        || runner.get(c"killReason")?.truthy()?
        || runner.get(c"modelTimeoutStopping")?.truthy()?
        || st.turn.get(c"resultDurable")?.truthy()?
        || st.port(c"meaningfulTurnOutput", &[st.cs])?.truthy()?
        || st.port(c"turnHasSideEffects", &[st.cs])?.truthy()?
        || facts.optional(c"visibleOutputObserved")?.truthy()?
        || facts.optional(c"toolIntentObserved")?.truthy()?
        || facts.optional(c"sideEffectObserved")?.truthy()?;
    let opts = s.get(c"spawnOpts")?;
    let account = opts
        .optional(c"agyAccountKey")?
        .string()?
        .map(|v| v.to_string_lossy())
        .unwrap_or_else(|| multicc_core::agy_models::account_key(None));
    let model = opts
        .optional(c"effectiveModel")?
        .string()?
        .map(|v| v.to_string_lossy())
        .unwrap_or_default();
    if let Some(args) = effort::recover(
        &strings(st.invocation.get(c"args")?)?,
        &account,
        &model,
        st.turn.get(c"agyEffortRetried")?.truthy()?,
        blocked,
    ) {
        let invocation = crate::js_live::spread(st.invocation)?;
        invocation.set(
            c"args",
            s.from_value(&V::Array(args.into_iter().map(V::from).collect()))?,
        )?;
        let prepared = crate::js_live::spread(s.get(c"prepared")?)?;
        prepared.set(c"invocation", invocation)?;
        st.turn.assign(c"agyEffortRetried", flag(s, true)?)?;
        if s.catch(|| {
            st.port(
                c"runChatTurnStreaming",
                &[
                    st.session,
                    st.cs,
                    st.record,
                    prepared,
                    st.provider,
                    st.turn,
                    s.get(c"prepareInvocation")?,
                    s.get(c"autoTurn")?,
                    runner.get(c"apiRetryAttempt")?,
                ],
            )
        })?
        .is_some_and(|v| v.is_true().unwrap_or(false))
        {
            st.port(
                c"chatBroadcast",
                &[
                    st.session,
                    fields(
                        s,
                        &[
                            ("type", text(s, "system")?),
                            ("subtype", text(s, "warning")?),
                            (
                                "message",
                                text(s, "该模型不接受当前思考强度，已调整参数重试。")?,
                            ),
                        ],
                    )?,
                ],
            )?;
            return Ok(true);
        }
    }
    st.port(
        c"applyAdapterChatEvent",
        &[
            st.provider,
            st.cs,
            st.record,
            st.session,
            evt,
            s.get(c"forward")?,
            st.turn,
            runner,
        ],
    )?;
    Ok(false)
}
