//! Probe decisions for a single provider. A generation plus state-object identity
//! ties a delayed result to the endpoint that was actually checked.
use super::*;
mod actions;
use actions::{automatic, manual};

const SAFE_ERRORS: &[&str] = &[
    "",
    "partial_edge_failure",
    "probe_failed",
    "tailscale_status_unavailable",
    "tailscale_status_malformed",
    "tailscale_offline",
    "local_origin_down",
    "funnel_status_unavailable",
    "funnel_status_malformed",
    "funnel_mapping_missing",
    "doh_unreachable",
    "non_public_resolution",
    "no_public_address",
    "dns_no_record",
    "too_many_public_addresses",
    "edge_identity_unverified",
    "public_data_plane_down",
    "probe_internal_error",
];

fn bounded(value: L<'_>, max: f64) -> Result<f64> {
    Ok(value
        .number_value()?
        .filter(|n| n.fract() == 0. && *n >= 0.)
        .unwrap_or(0.)
        .min(max))
}
struct Observation<'a> {
    verdict: String,
    error: String,
    mode: &'static str,
    public_url: L<'a>,
    http: f64,
    origin: f64,
    resolved: f64,
    successes: f64,
    eligible: bool,
}
impl<'a> Observation<'a> {
    fn from(value: L<'a>) -> Result<Self> {
        if value.kind()? == sys::ValueType::napi_number {
            let http = bounded(value, 999.)?;
            let healthy = (200.0..400.0).contains(&http);
            return Ok(Self {
                verdict: if healthy { "healthy" } else { "unhealthy" }.into(),
                error: if healthy { "" } else { "probe_failed" }.into(),
                mode: "url",
                public_url: text(value, "")?,
                http,
                origin: 0.,
                resolved: 0.,
                successes: 0.,
                eligible: true,
            });
        }
        let pick = |key: &CStr| -> Result<String> {
            Ok(value
                .optional(key)?
                .string()?
                .map(|v| v.to_string_lossy())
                .unwrap_or_default())
        };
        let verdict = pick(c"verdict")?;
        let verdict =
            if ["healthy", "degraded", "unhealthy", "indeterminate"].contains(&verdict.as_str()) {
                verdict
            } else {
                "indeterminate".into()
            };
        let raw = value.optional(c"error")?;
        let error = raw
            .string()?
            .map(|v| v.to_string_lossy())
            .filter(|v| SAFE_ERRORS.contains(&v.as_str()))
            .unwrap_or_else(|| "probe_failed".into());
        let url = value.optional(c"publicUrl")?;
        let public_url = if url
            .string()?
            .is_some_and(|v| v.len() <= 512 && v.to_string_lossy().starts_with("https://"))
        {
            url
        } else {
            text(value, "")?
        };
        Ok(Self {
            eligible: verdict == "unhealthy" && value.optional(c"repairEligible")?.is_true()?,
            verdict,
            error,
            mode: if value
                .optional(c"mode")?
                .is_string("tailscale_funnel_public")?
            {
                "tailscale_funnel_public"
            } else {
                "url"
            },
            public_url,
            http: bounded(value.optional(c"httpCode")?, 999.)?,
            origin: bounded(value.optional(c"originHttpCode")?, 999.)?,
            resolved: bounded(value.optional(c"resolvedAddressCount")?, 32.)?,
            successes: bounded(value.optional(c"edgeSuccessCount")?, 32.)?,
        })
    }
    fn apply(&self, st: L<'a>) -> Result<()> {
        config::prune(st, now(st)?)?;
        for (key, n) in [
            (c"lastCheckAt".as_ref(), now(st)?),
            (c"lastHttpCode", self.http),
            (c"originHttpCode", self.origin),
            (c"resolvedAddressCount", self.resolved),
            (c"edgeSuccessCount", self.successes),
        ] {
            st.set(key, num(st, n)?)?;
        }
        st.set(
            c"healthy",
            if matches!(self.verdict.as_str(), "indeterminate" | "degraded") {
                null(st)?
            } else {
                flag(st, self.verdict == "healthy")?
            },
        )?;
        st.set(c"probeMode", text(st, self.mode)?)?;
        st.set(c"probeVerdict", text(st, &self.verdict)?)?;
        st.set(c"probeError", text(st, &self.error)?)?;
        st.set(c"publicUrl", self.public_url)
    }
}
fn can_check(name: L<'_>, pc: L<'_>) -> Result<bool> {
    Ok(pc.truthy()?
        && ((name.is_string("tailscale")? && pc.get(c"funnel")?.is_true()?)
            || (pc.get(c"enabled")?.is_true()? && pc.get(c"url")?.truthy()?)))
}
fn current(f: L<'_>) -> Result<bool> {
    let s = f.get(c"s")?;
    let name = f.get(c"name")?;
    Ok(s.get(c"generation")?.equals(f.get(c"generation")?)?
        && s.get(c"states")?.get_key(name)?.equals(f.get(c"st")?)?
        && can_check(name, s.get(c"config")?.get_key(name)?)?)
}
fn note<'a>(st: L<'a>, message: &str) -> Result<L<'a>> {
    st.set(c"lastAction", text(st, message)?)?;
    undef(st)
}
fn inc(st: L<'_>, key: &CStr) -> Result<f64> {
    let n = st.get(key)?.number()? + 1.;
    st.set(key, num(st, n)?)?;
    Ok(n)
}
fn decide<'a>(f: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if !current(f)? {
        return undef(f);
    }
    let st = f.get(c"st")?;
    let s = f.get(c"s")?;
    let name = f.get(c"name")?;
    let result = Observation::from(value)?;
    result.apply(st)?;
    let healthy = result.verdict == "healthy";
    if name.is_string("sakurafrp")? {
        let diagnosis = if healthy {
            null(s)?
        } else {
            let func = f.get(c"opts")?.get(c"diagnoseFn")?;
            let func = if func.truthy()? {
                func
            } else {
                s.get(c"diagnoseSakurafrp")?
            };
            let diagnosis = func.call_plain(&[])?;
            if diagnosis.truthy()? {
                diagnosis
            } else {
                fallback(st.get(c"diagnosis")?, V::Null)?
            }
        };
        st.set(c"diagnosis", diagnosis)?;
    }
    if result.verdict == "indeterminate" || result.verdict == "degraded" {
        config::reset_evidence(st)?;
        return note(
            st,
            &if result.verdict == "degraded" {
                "公网边缘部分可用，已告警但不执行自动修复".into()
            } else {
                format!("探针不确定（{}），未执行自动修复", result.error)
            },
        );
    }
    if healthy {
        config::reset_evidence(st)?;
        let last = st.get(c"lastAction")?;
        let prefix = [
            "重启失败",
            "修复失败",
            "探针不确定",
            "Funnel 探活异常",
            "公网边缘部分可用",
        ];
        let last_text = printable(last)?;
        if prefix.iter().any(|p| last_text.starts_with(p)) || last_text.contains("等待公网复检")
        {
            return note(st, "");
        }
        return undef(st);
    }
    let fails = inc(st, c"consecutiveFails")?;
    let cfg = s.get(c"config")?;
    let target = cfg.get_key(name)?;
    let threshold = config::failure_threshold(cfg.get(c"failThreshold")?)?;
    if f.get(c"funnel")?.is_true()? {
        if !(result.verdict == "unhealthy"
            && result.eligible
            && result.error == "public_data_plane_down"
            && config::valid_port(f.get(c"port")?)?)
        {
            st.set(c"repairableFailStreak", num(st, 0.)?)?;
            return note(
                st,
                &format!(
                    "Funnel 探活异常（{}），故障层不满足自动修复条件",
                    result.error
                ),
            );
        }
        if inc(st, c"repairableFailStreak")? < threshold.max(3.) {
            return undef(st);
        }
        if !target.get(c"enabled")?.is_true()? || !target.get(c"monitorOnly")?.is_false()? {
            st.set(c"repairableFailStreak", num(st, 0.)?)?;
            return note(
                st,
                if !target.get(c"enabled")?.is_true()? {
                    "仅观察：Funnel 自动修复监控未启用"
                } else {
                    "仅监控：探活异常，按设置不自动修复"
                },
            );
        }
        return with_mutation(
            s,
            callback(f, "", 0, 0, |f, _| async_result(f, || actions::funnel(f)))?,
        );
    }
    if fails < threshold {
        return undef(st);
    }
    if !result.eligible {
        return note(st, &format!("探活异常（{}），未执行自动修复", result.error));
    }
    if !target.get(c"monitorOnly")?.is_false()? {
        return note(st, "仅监控：探活异常，按设置不自动重启");
    }
    if name.is_string("sakurafrp")?
        && st
            .get(c"diagnosis")?
            .optional(c"code")?
            .is_string("traffic_exhausted")?
    {
        return note(
            st,
            "SakuraFrp 流量耗尽：重启无效；签到/购买流量后点「立即重启」",
        );
    }
    if !current(f)? {
        return undef(st);
    }
    automatic(f, &result)
}
pub(super) fn check<'a>(s: L<'a>, name: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let pc = s.get(c"config")?.get_key(name)?;
    let st = s.get(c"states")?.get_key(name)?;
    if !can_check(name, pc)? || st.get(c"checking")?.truthy()? {
        return undef(s);
    }
    let funnel = name.is_string("tailscale")? && pc.get(c"funnel")?.is_true()?;
    let port = if funnel {
        pc.get(c"funnelPort")?
    } else {
        null(s)?
    };
    let probe = opts.get(c"probeFn")?;
    let f = fields(
        s,
        &[
            ("s", s),
            ("st", st),
            ("generation", s.get(c"generation")?),
            ("name", name),
            ("opts", opts),
            ("funnel", flag(s, funnel)?),
            ("port", port),
            (
                "restarter",
                fallback(opts.get(c"restarter")?, V::Undefined)?,
            ),
        ],
    )?;
    st.set(c"checking", flag(s, true)?)?;
    let work = async_result(s, || {
        let v = if funnel && !probe.truthy()? {
            let p = opts.get(c"funnelProbe")?;
            let p = if p.truthy()? {
                p
            } else {
                providers::funnel_probe(s)?
            };
            call(
                p,
                c"probe",
                &[fields(s, &[("originPort", num(s, config::port(port)?)?)])?],
            )?
        } else if probe.truthy()? {
            probe.call_plain(&[pc.get(c"url")?])?
        } else {
            providers::probe(s, pc.get(c"url")?)?
        };
        then(f, v, decide)
    })?;
    call(
        work,
        c"finally",
        &[callback(st, "", 0, 0, |st, _| {
            st.set(c"checking", flag(st, false)?)?;
            undef(st)
        })?],
    )
}
pub(super) fn tick(s: L<'_>, index: usize) -> Result<L<'_>> {
    if index == NAMES.len() {
        return undef(s);
    }
    let name = NAMES[index];
    let res = async_result(s, || check(s, text(s, name)?, fields(s, &[])?))?;
    let handle = callback(s, "", 0, 0, move |s, _| {
        let st = s.get(c"states")?.get_key(text(s, name)?)?;
        config::reset_evidence(st)?;
        st.set(c"lastCheckAt", num(s, now(s)?)?)?;
        st.set(c"healthy", null(s)?)?;
        st.set(c"probeVerdict", text(s, "indeterminate")?)?;
        st.set(c"probeError", text(s, "probe_internal_error")?)?;
        note(st, "探针内部异常，未执行自动修复")?;
        print(
            s,
            c"error",
            &format!("[multicc/tunnel] {name} probe failed internally"),
        )?;
        undef(s)
    })?;
    then(s, call(res, c"catch", &[handle])?, move |s, _| {
        tick(s, index + 1)
    })
}
pub(super) fn restart_now<'a>(s: L<'a>, name: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let label = printable(name)?;
    if !NAMES.contains(&label.as_str()) {
        return fields(
            s,
            &[
                ("ok", flag(s, false)?),
                ("error", text(s, "unknown provider")?),
            ],
        );
    }
    let f = fields(
        s,
        &[
            ("s", s),
            ("name", name),
            ("st", s.get(c"states")?.get_key(name)?),
            ("funnel", flag(s, false)?),
            ("restarter", opts.get(c"restarter")?),
        ],
    )?;
    if label != "tailscale" {
        return manual(f);
    }
    invalidate(s)?;
    clear_probe(s)?;
    let work = with_mutation(
        s,
        callback(f, "", 0, 0, |f, _| async_result(f, || manual(f)))?,
    )?;
    call(
        work,
        c"finally",
        &[callback(s, "", 0, 0, |s, _| {
            invalidate_funnel(s)?;
            undef(s)
        })?],
    )
}
