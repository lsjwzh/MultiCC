use super::*;

pub(super) fn start(s: L<'_>) -> Result<L<'_>> {
    let ports = s.get(c"ports")?;
    let mut sdk = s.get(c"slackSdk")?;
    if !sdk.truthy()? {
        sdk = match s.catch(|| ports.get(c"loadSlack")?.call_plain(&[]))? {
            Some(sdk) => sdk,
            None => {
                return Err(
                    error_value(s, "@slack/bolt 未安装，请先 npm install @slack/bolt")?
                        .throw_error(),
                )
            }
        };
        s.set(c"slackSdk", sdk)?;
    }
    let config = s.get(c"config")?;
    let agent = ports.get(c"outboundAgent")?;
    let installer = fields(s, &[("clientOptions", fields(s, &[("agent", agent)])?)])?;
    let options = fields(
        s,
        &[
            ("token", config.get(c"botToken")?),
            ("appToken", config.get(c"appToken")?),
            ("socketMode", flag(s, true)?),
            ("agent", agent),
            ("installerOptions", installer),
        ],
    )?;
    let app = sdk.get(c"App")?.construct(&[options])?;
    s.set(c"client", app)?;
    let auth = (|| call(app.get(c"client")?.get(c"auth")?, c"test", &[]))();
    await_sdk(s, auth, authenticated, auth_failed)
}

// The SDK can throw synchronously or reject later. Run synchronous rollback
// in the same call and resume a fulfilled SDK promise in its first continuation.
fn await_sdk<'a>(
    s: L<'a>,
    result: Result<L<'a>>,
    success: Action,
    failure: Action,
) -> Result<L<'a>> {
    match result {
        Ok(v) => call(
            resolved(v)?,
            c"then",
            &[
                function(s, "fulfilled", 1, 1, success)?,
                function(s, "rejected", 1, 1, failure)?,
            ],
        ),
        Err(e) => failure(s, &mut [caught(s, e)?]),
    }
}

fn auth_failed<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    s.set(c"client", null(s)?)?;
    let msg = concat(s, "Slack auth.test failed: ", message(a[0])?)?;
    Err(s.global()?.get(c"Error")?.construct(&[msg])?.throw_error())
}

fn authenticated<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if let Err(e) = (|| s.set(c"botUserId", fallback(a[0].get(c"user_id")?, V::Null)?))() {
        return auth_failed(s, &mut [caught(s, e)?]);
    }
    let app = s.get(c"client")?;
    call(
        app,
        c"event",
        &[
            text(s, "message")?,
            function(s, "onMessage", 1, 1, |s, a| {
                async_result(s, || inbound::receive(s, &mut [a[0].get(c"event")?]))
            })?,
        ],
    )?;
    s.set(c"running", flag(s, true)?)?;
    s.set(c"startTime", call(s.global()?.get(c"Date")?, c"now", &[])?)?;
    call(s.get(c"chatWs")?, c"connect", &[])?;
    let started = (|| call(s.get(c"client")?, c"start", &[]))();
    await_sdk(
        s,
        started,
        |s, _| {
            log_text(s, "system", "Slack bridge started (Socket Mode)")?;
            undef(s)
        },
        |s, a| {
            s.set(c"running", flag(s, false)?)?;
            call(s.get(c"chatWs")?, c"disconnect", &[])?;
            s.set(c"client", null(s)?)?;
            s.set(c"botUserId", null(s)?)?;
            Err(a[0].throw_error())
        },
    )
}

pub(super) fn stop<'a>(s: L<'a>, app: L<'a>) -> Result<L<'a>> {
    if app.truthy()? {
        s.catch(|| {
            let stopped = call(app, c"stop", &[])?;
            if stopped.truthy()? && callable(stopped.get(c"catch")?)? {
                call(
                    stopped,
                    c"catch",
                    &[function(s, "onStopError", 1, 1, |s, a| {
                        log(
                            s,
                            "error",
                            concat(s, "Slack stop failed: ", message(a[0])?)?,
                        )
                    })?],
                )?;
            }
            undef(s)
        })?;
        s.set(c"client", null(s)?)?;
    }
    call(s.get(c"chatWs")?, c"disconnect", &[])?;
    s.set(c"botUserId", null(s)?)?;
    log_text(s, "system", "Slack bridge stopped")?;
    undef(s)
}
