use super::*;
use std::{cell::Cell, time::Instant};
const PHASES: &[&CStr] = &[
    c"migrateMs",
    c"recordsMs",
    c"boardMs",
    c"admissionMs",
    c"admissionIndexMs",
    c"cardListMs",
    c"cardSignatureMs",
    c"cardLoopMs",
    c"tailMs",
    c"jsonMs",
    c"etagMs",
];
fn round1(v: f64) -> f64 {
    (v * 10.).round() / 10.
}
pub(super) fn settings(p: L<'_>) -> Result<()> {
    let h = ports(p)?;
    let mut defaults = h.get(c"phaseDefaults")?;
    if defaults.undefined()? {
        defaults = fields(p, &[])?;
        for (field, var, default) in [
            (c"logMs", c"AIR_PHASE_LOG_MS", 200.),
            (c"gapMs", c"AIR_PHASE_LOG_GAP_MS", 30000.),
            (c"bootWindowS", c"AIR_PHASE_BOOT_WINDOW_S", 120.),
            (c"bootGapMs", c"AIR_PHASE_BOOT_GAP_MS", 5000.),
        ] {
            defaults.set(field, num(p, env_number(p, var, default)?)?)?;
        }
        h.set(c"phaseDefaults", defaults)?;
    }
    let config = spread(defaults)?;
    let overrides = deps(p)?.get(c"phaseDiagnostics")?;
    if overrides.truthy()? {
        config.spread_from(overrides)?;
    }
    p.set(c"phase", config)
}
fn timer(p: L<'_>) -> Result<L<'_>> {
    let start = Instant::now();
    let last = Cell::new(start);
    let sample = fields(p, &[])?;
    fields(
        p,
        &[
            (
                "lap",
                function(sample, "lap", 1, 1, move |s, a| {
                    let now = Instant::now();
                    let elapsed = now.duration_since(last.replace(now));
                    s.define_key(a[0], num(s, round1(elapsed.as_secs_f64() * 1000.))?)?;
                    undef(s)
                })?,
            ),
            (
                "sum",
                function(sample, "sum", 2, 2, |s, a| {
                    let old = js_or(s.get_key(a[0])?, num(s, 0.)?)?.number()?;
                    s.define_key(a[0], num(s, round1(old + a[1].number()?))?)?;
                    undef(s)
                })?,
            ),
            (
                "set",
                function(sample, "set", 2, 2, |s, a| {
                    s.define_key(a[0], a[1])?;
                    undef(s)
                })?,
            ),
            (
                "sample",
                function(sample, "sample", 0, 0, move |s, _| {
                    let out = spread(s)?;
                    out.set(
                        c"totalMs",
                        num(s, round1(start.elapsed().as_secs_f64() * 1000.))?,
                    )?;
                    Ok(out)
                })?,
            ),
        ],
    )
}
fn report<'a>(p: L<'a>, t: L<'a>) -> Result<()> {
    let sample = call(t, c"sample", &[])?;
    let process = ports(p)?.get(c"process")?;
    let logger = deps(p)?.get(c"logger")?;
    let up = call(process, c"uptime", &[])?.number()?;
    let phase = p.get(c"phase")?;
    let boot = up < phase.get(c"bootWindowS")?.number()?;
    let total = sample.get(c"totalMs")?.number()?;
    if boot && !logger.truthy()? || !boot && total < phase.get(c"logMs")?.number()? {
        return Ok(());
    }
    let now = now_ms(p)?;
    if now.number()? - p.get(c"lastLogAt")?.number()?
        < phase
            .get(if boot { c"bootGapMs" } else { c"gapMs" })?
            .number()?
    {
        return Ok(());
    }
    p.set(c"lastLogAt", now)?;
    p.catch(|| -> Result<()> {
        let mut accounted = 0.;
        for &key in PHASES {
            let n = sample.get(key)?.explicit_number()?;
            if !n.is_nan() {
                accounted += n;
            }
        }
        let memory = call(process, c"memoryUsage", &[])?;
        let out = spread(sample)?;
        out.set(c"unaccountedMs", num(p, round1(total - accounted))?)?;
        let at = Instant::now();
        let mut sink = 0.;
        for i in 0..200000 {
            sink += ((i % 977) as f64).sqrt();
        }
        std::hint::black_box(sink);
        out.set(
            c"calibMs",
            num(p, round1(at.elapsed().as_secs_f64() * 1000.))?,
        )?;
        out.set(
            c"rssMB",
            num(p, (memory.get(c"rss")?.number()? / 1048576.).round())?,
        )?;
        out.set(
            c"heapUsedMB",
            num(p, (memory.get(c"heapUsed")?.number()? / 1048576.).round())?,
        )?;
        out.set(c"uptimeSec", num(p, up.round())?)?;
        let logger = js_or(logger, p.global()?.get(c"console")?)?;
        call(logger, c"warn", &[text(p, "air_snapshot_slow")?, out])?;
        Ok(())
    })?;
    Ok(())
}
fn etag<'a>(p: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let hash = call(
        ports(p)?.get(c"crypto")?,
        c"createHash",
        &[text(p, "sha1")?],
    )?;
    let updated = call(hash, c"update", &[body])?;
    let digest = call(updated, c"digest", &[text(p, "base64url")?])?;
    call(text(p, "W/\"")?, c"concat", &[digest, text(p, "\"")?])
}
pub(super) fn build<'a>(p: L<'a>, ids: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let t = timer(p)?;
        let ctx = fields(p, &[("p", p), ("timer", t)])?;
        then(
            snapshot::start(p, t, fields(p, &[("ids", ids)])?)?,
            ctx,
            |c, a| {
                report(c.get(c"p")?, c.get(c"timer")?)?;
                Ok(a[0])
            },
        )
    })
}
pub(super) fn snapshot_value<'a>(p: L<'a>, header: L<'a>) -> Result<L<'a>> {
    let t = timer(p)?;
    p.set(c"inFlight", num(p, p.get(c"inFlight")?.number()? + 1.)?)?;
    let ctx = fields(p, &[("p", p), ("timer", t), ("header", header)])?;
    let response = async_result(p, || {
        let live = p.get(c"live")?;
        let wait = if live.truthy()? {
            then(call(live, c"ensureReady", &[])?, live, |l, _| {
                call(l, c"serialized", &[])
            })?
        } else {
            then(snapshot::start(p, t, fields(p, &[])?)?, ctx, |c, a| {
                let p = c.get(c"p")?;
                let t = c.get(c"timer")?;
                let visible = function(p, "visible", 1, 1, |p, a| {
                    flag(p, !a[0].get(c"status")?.is_string("archived")?)
                })?;
                a[0].set(c"tasks", call(a[0].get(c"tasks")?, c"filter", &[visible])?)?;
                let body = json_call(p, c"stringify", a[0])?;
                call(t, c"lap", &[text(p, "jsonMs")?])?;
                let tag = etag(p, body)?;
                call(t, c"lap", &[text(p, "etagMs")?])?;
                fields(p, &[("body", body), ("etag", tag)])
            })?
        };
        then(wait, ctx, |c, a| {
            let v = a[0];
            let header = c.get(c"header")?;
            let tag = v.get(c"etag")?;
            let h = if header.truthy()? {
                Some(fold_string(header)?)
            } else {
                None
            };
            let matched =
                multicc_core::air_routes::conditional_matches(h.as_deref(), &fold_string(tag)?);
            let t = c.get(c"timer")?;
            let body = v.get(c"body")?;
            call(t, c"set", &[text(c, "bodyChars")?, body.get(c"length")?])?;
            call(
                t,
                c"set",
                &[
                    text(c, "status")?,
                    num(c, if matched { 304. } else { 200. })?,
                ],
            )?;
            fields(c, &[("body", body), ("etag", tag)])
        })
    })?;
    call(
        response,
        c"finally",
        &[function(ctx, "", 0, 0, |c, _| {
            let p = c.get(c"p")?;
            let t = c.get(c"timer")?;
            let n = num(p, p.get(c"inFlight")?.number()? - 1.)?;
            p.set(c"inFlight", n)?;
            call(t, c"set", &[text(c, "inFlight")?, n])?;
            report(p, t)?;
            undef(c)
        })?],
    )
}
