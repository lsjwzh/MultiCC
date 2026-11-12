use super::*;
pub(super) fn open_code(v: &V, now: f64) -> V {
    if !js::truthy(v) {
        return simple("quotaOpenCodeIdleText", GRAY, "quotaOpenCodeIdleTitle", "");
    }
    match strict_text(v, "status").as_str() {
        "needs_login" => {
            return simple(
                "quotaOpenCodeNeedsLoginText",
                RED,
                "quotaOpenCodeNeedsLoginTitle",
                "login",
            )
        }
        "chrome_unavailable" => {
            return simple(
                "quotaOpenCodeChromeUnavailableText",
                YELLOW,
                "quotaOpenCodeChromeUnavailableTitle",
                "login",
            )
        }
        "no_auth" => {
            return view(
                vec![p("quotaOpenCodeNoAuthText")],
                RED,
                vec![if js::truthy(get(v, "error")) {
                    piece(field(v, "error"))
                } else {
                    p("quotaOpenCodeNoAuthTitle")
                }],
                V::Null,
            )
        }
        _ => {}
    }
    if get(v, "status") != &V::from("ok") || !js::truthy(get(v, "usage")) {
        return unavailable(v, "OpenCode", "quotaOpenCodeUnavailableTitle");
    }
    let usage = get(v, "usage");
    let fetched = finite(get(v, "fetchedAt")).unwrap_or(0.0);
    let mut wins = Vec::new();
    for (key, token) in [("rolling", "5h"), ("weekly", "1wk"), ("monthly", "1m")] {
        let w = get(usage, key);
        if !js::truthy(w) || !exact_number(get(w, "usagePercent")) {
            continue;
        }
        let at = num(finite(get(w, "resetInSec"))
            .filter(|_| fetched != 0.0)
            .map(|s| fetched + s * 1000.0));
        let r = reading(get(w, "usagePercent"), &at, &V::Number(fetched), now);
        wins.push((key, token, w, at, r));
    }
    let segments = wins
        .iter()
        .map(|(_, token, _, at, r)| seg(&V::from(*token), r, at))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let max = worst(wins.iter().map(|(_, _, _, _, r)| js::js_to_number(&r.used)));
    let c = if max >= 90.0 {
        RED
    } else if max >= 70.0 {
        YELLOW
    } else {
        BLUE
    };
    let zen = matches!(get(v,"source"),V::String(s) if s.to_string_lossy().starts_with("zen-api"));
    let mut lines = vec![p(if zen {
        "quotaOpenCodeUsageTitleZen"
    } else {
        "quotaOpenCodeUsageTitleCdp"
    })];
    for (key, token, w, at, r) in &wins {
        let (line, name) = match *key {
            "rolling" => ("quotaOpenCodeWindow5h", V::from("5h")),
            "weekly" => ("quotaOpenCodeWindowWeekly", p("quotaPeriodWeekly")),
            _ => ("quotaOpenCodeWindowMonthly", p("quotaPeriodMonthly")),
        };
        let reset = if js::truthy(at) {
            part(
                "quotaResetAfterSuffix",
                Some(obj!("at"=>cd(at,&V::from(*token)))),
            )
        } else {
            V::Null
        };
        let limited = if get(w, "status") == &V::from("rate-limited") {
            p("quotaRateLimited")
        } else {
            V::Null
        };
        lines.push(part(line,Some(obj!("name"=>name,"pct"=>pct(&V::Number(round(js::js_to_number(&r.used))),r.estimated),"reset"=>reset,"limited"=>limited))));
    }
    if wins.iter().any(|(_, _, _, _, r)| r.estimated) {
        lines.push(estimated());
    }
    lines.extend([sync(get(v, "fetchedAt")), refresh()]);
    if js::truthy(get(usage, "useBalance")) {
        lines.push(p("quotaBalanceFallbackEnabled"));
    }
    view(
        tail(
            format!(
                "OpenCode Go · {}",
                if segments.is_empty() {
                    "—"
                } else {
                    &segments
                }
            ),
            get(v, "fetchedAt"),
        ),
        c,
        lines,
        V::Null,
    )
}
fn nullish(v: &V, fallback: V) -> V {
    if v.is_nullish() {
        fallback
    } else {
        v.clone()
    }
}
pub(super) fn qoder(v: &V, now: f64) -> V {
    if !js::truthy(v) {
        return simple("quotaQoderIdleText", GRAY, "quotaQoderIdleTitle", "");
    }
    match strict_text(v, "status").as_str() {
        "needs_login" => {
            return simple(
                "quotaQoderNeedsLoginText",
                RED,
                "quotaQoderNeedsLoginTitle",
                "login",
            )
        }
        "chrome_unavailable" => {
            return simple(
                "quotaQoderChromeUnavailableText",
                YELLOW,
                "quotaQoderChromeUnavailableTitle",
                "login",
            )
        }
        _ => {}
    }
    if get(v, "status") != &V::from("ok") || !js::truthy(get(v, "quota")) {
        return unavailable(v, "Qoder", "quotaQoderUnavailableTitle");
    }
    let q = get(v, "quota");
    let total = get(get(q, "total_quota"), "quota_summary");
    let plan = get(get(q, "plan_quota"), "quota_summary");
    let pkg = get(get(q, "resource_package_quota"), "quota_summary");
    let used = nullish(get(total, "used_value"), V::Number(0.0));
    let limit = nullish(get(total, "limit_value"), V::Number(0.0));
    let rem = nullish(get(total, "remaining_value"), V::Number(0.0));
    let pct_raw = nullish(
        get(total, "usage_percentage"),
        V::Number(if js::js_to_number(&limit) > 0.0 {
            round(js::js_to_number(&used) / js::js_to_number(&limit) * 100.0)
        } else {
            0.0
        }),
    );
    let at = [
        reset(get(q, "nextResetAt")),
        reset(get(get(v, "plan"), "end_date")),
        reset(get(get(v, "plan"), "next_refresh_date")),
    ]
    .into_iter()
    .find(|x| !x.is_nullish())
    .unwrap_or(V::Null);
    let r = reading(&pct_raw, &at, get(v, "fetchedAt"), now);
    let shown_used = if r.estimated { V::Number(0.0) } else { used };
    let shown_rem = if r.estimated { limit.clone() } else { rem };
    let segment = seg(&V::from("1m"), &r, &at);
    let tier = empty(get(get(v, "plan"), "plan_tier")).replacen("PLAN_TIER_", "", 1);
    let mut lines = vec![
        p("quotaQoderUsageTitle"),
        part("quotaPlanLine", Some(obj!("plan"=>tier))),
        part(
            "quotaTotalLine",
            Some(
                obj!("used"=>pct(&shown_used,r.estimated),"limit"=>limit,"remaining"=>pct(&shown_rem,r.estimated)),
            ),
        ),
    ];
    if js::truthy(get(plan, "limit_value")) {
        lines.push(part("quotaPlanQuotaLine",Some(obj!("used"=>pct(&if r.estimated{V::Number(0.0)}else{field(plan,"used_value")},r.estimated),"limit"=>field(plan,"limit_value")))));
    }
    if js::truthy(get(pkg, "limit_value")) {
        lines.push(part("quotaAddonQuotaLine",Some(obj!("used"=>pct(&if r.estimated{V::Number(0.0)}else{field(pkg,"used_value")},r.estimated),"limit"=>field(pkg,"limit_value"),"remaining"=>pct(&if r.estimated{field(pkg,"limit_value")}else{field(pkg,"remaining_value")},r.estimated)))));
    }
    lines.push(if at != V::Null {
        part(
            "quotaResetAfterLine",
            Some(obj!("at"=>cd(&at,&V::from("1m")))),
        )
    } else {
        p("quotaExpiryUnknown")
    });
    if r.estimated {
        lines.push(estimated());
    }
    lines.extend([sync(get(v, "fetchedAt")), refresh()]);
    view(
        tail(
            if segment.is_empty() {
                String::from("—")
            } else {
                segment
            },
            get(v, "fetchedAt"),
        ),
        color(remain(&r.used)),
        lines,
        V::Null,
    )
}
pub(super) fn codex(v: &V, now: f64) -> V {
    if !js::truthy(v) {
        return simple("quotaCodexIdleText", GRAY, "quotaCodexIdleTitle", "");
    }
    if get(v, "status") == &V::from("no_auth") {
        return simple("quotaCodexNoAuthText", RED, "quotaCodexNoAuthTitle", "");
    }
    let windows = if get(v, "status") == &V::from("ok") {
        if !array(get(v, "windows")).is_empty() {
            array(get(v, "windows"))
                .iter()
                .filter(|w| {
                    js::truthy(w)
                        && known_window(get(w, "window"))
                        && finite(get(w, "usedPercent")).is_some()
                })
                .cloned()
                .collect::<Vec<_>>()
        } else if js::truthy(get(v, "weekly")) {
            let mut w = obj!("window"=>"1wk");
            if let V::Object(a) = get(v, "weekly") {
                for (k, v) in a {
                    set(&mut w, &k.to_string_lossy(), v.clone());
                }
            }
            vec![w]
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    if windows.is_empty() {
        return unavailable(v, "Codex", "quotaCodexUnavailableTitle");
    }
    let mut rows: Vec<_> = windows
        .iter()
        .map(|w| {
            let at = num(finite(get(w, "resetsAt"))
                .filter(|n| *n != 0.0)
                .map(|n| n * 1000.0));
            let r = reading(get(w, "usedPercent"), &at, get(v, "fetchedAt"), now);
            (w, at, r)
        })
        .collect();
    rows.sort_by_key(|(w, _, _)| rank(get(w, "window")));
    let segment = join_values(
        rows.iter()
            .map(|(w, at, r)| seg_value(get(w, "window"), r, at)),
        " · ",
    );
    let max = if js::truthy(get(v, "limitReached")) {
        100.0
    } else {
        worst(rows.iter().map(|(_, _, r)| js::js_to_number(&r.used)))
    };
    let plan = concat(&[
        or(get(v, "planType"), &V::from("?")),
        if js::truthy(get(v, "email")) {
            concat(&[V::from(" · "), field(v, "email")])
        } else {
            V::from("")
        },
    ]);
    let mut lines = vec![
        p("quotaCodexTitle"),
        part("quotaPlanLine", Some(obj!("plan"=>plan))),
    ];
    lines.extend(
        rows.iter()
            .map(|(w, at, r)| detail(get(w, "window"), r, at)),
    );
    for a in array(get(v, "additional")) {
        lines.push(part(
            "quotaAdditionalWindowLine",
            Some(obj!("name"=>field(a,"name"),"used"=>field(a,"usedPercent"))),
        ));
    }
    let credits = get(v, "credits");
    if js::truthy(get(credits, "hasCredits")) {
        lines.push(part(
            "quotaCreditsBalanceLine",
            Some(obj!("balance"=>field(credits,"balance"))),
        ));
    }
    if rows.iter().any(|(_, _, r)| r.estimated) {
        lines.push(estimated());
    }
    lines.extend([sync(get(v, "fetchedAt")), refresh()]);
    view(
        tail(or(&segment, &V::from("—")), get(v, "fetchedAt")),
        color(remain(&V::Number(max))),
        lines,
        V::Null,
    )
}
pub(super) fn ark_window(label: &V) -> V {
    let lower = js::js_to_string(&or(label, &V::from(""))).to_lowercase();
    match lower.to_string_lossy().as_str() {
        "5h" | "session" => V::from("5h"),
        "weekly" => V::from("1wk"),
        "monthly" => V::from("1m"),
        "" => V::from("?"),
        _ => V::String(lower),
    }
}
pub(super) fn ark_plan(base: &V) -> V {
    let V::String(s) = base else { return V::Null };
    url::Url::parse(&s.to_string_lossy())
        .ok()
        .and_then(|u| {
            let p = u.path().to_lowercase();
            if p.contains("/coding") {
                Some("coding-plan")
            } else if p.contains("/plan") {
                Some("agent-plan")
            } else {
                None
            }
        })
        .map(V::from)
        .unwrap_or(V::Null)
}
fn product(value: &V) -> V {
    match (if matches!(value, V::String(_)) {
        string(value)
    } else {
        String::new()
    })
    .as_str()
    {
        "agent-plan" => piece("Agent"),
        "coding-plan" => piece("Coding"),
        "agent-plan-team" => p("quotaArkProductAgentTeam"),
        "coding-plan-team" => p("quotaArkProductCodingTeam"),
        _ => piece(or(value, &V::from("?"))),
    }
}
fn period(value: &V) -> V {
    match empty(value).to_lowercase().as_str() {
        "weekly" => p("quotaPeriodWeekly"),
        "monthly" => p("quotaPeriodMonthly"),
        "session" => piece("5h"),
        _ => piece(V::String(js::js_to_string(&or(value, &V::from("?"))))),
    }
}
pub(super) fn ark(v: &V, base: &V, now: f64) -> V {
    if !js::truthy(v) {
        return simple("quotaArkIdleText", GRAY, "quotaArkIdleTitle", "");
    }
    match strict_text(v, "status").as_str() {
        "needs_auth" => {
            return simple(
                "quotaArkNeedsAuthText",
                RED,
                "quotaArkNeedsAuthTitle",
                "ark_login",
            )
        }
        "needs_install" => {
            return simple(
                "quotaArkNeedsInstallText",
                YELLOW,
                "quotaArkNeedsInstallTitle",
                "ark_install",
            )
        }
        _ => {}
    }
    if get(v, "status") != &V::from("ok") || !is_array(get(v, "items")) {
        return unavailable(v, "Ark", "quotaArkUnavailableTitle");
    }
    let mut items: Vec<_> = array(get(v, "items"))
        .iter()
        .filter(|it| {
            js::truthy(get(it, "subscribed"))
                && !js::truthy(get(it, "error"))
                && !array(get(it, "periods")).is_empty()
        })
        .collect();
    if items.is_empty() {
        return simple("quotaArkNoPlanText", GRAY, "quotaArkNoPlanTitle", "");
    }
    let active = ark_plan(base);
    if js::truthy(&active) {
        items.sort_by_key(|it| u8::from(get(it, "product") != &active));
    }
    let plan = items[0];
    let read = |p: &V| {
        let at = num(finite(get(p, "resetAt")).filter(|n| *n != 0.0));
        let r = reading(
            &num(Some(finite(get(p, "percent")).unwrap_or(0.0))),
            &at,
            get(v, "fetchedAt"),
            now,
        );
        (at, r)
    };
    let mut segments = Vec::new();
    let mut max_used = 0.0f64;
    for p in array(get(plan, "periods")) {
        let (at, r) = read(p);
        max_used = max_used.max(js::js_to_number(&r.used));
        let w = ark_window(get(p, "label"));
        segments.push((rank(&w), seg_value(&w, &r, &at)));
    }
    segments.sort_by_key(|(rank, _)| *rank);
    let mut lines = Vec::new();
    let mut any_estimated = false;
    for (i, it) in items.iter().enumerate() {
        lines.push(part("quotaArkPlanHeader",Some(obj!("product"=>product(get(it,"product")),"tier"=>if js::truthy(get(it,"tier")){concat(&[V::from(" · "),field(it,"tier")])}else{V::from("")},"current"=>if i==0{p("quotaArkCurrentProvider")}else{V::Null}))));
        for pr in array(get(it, "periods")) {
            let (at, r) = read(pr);
            any_estimated |= r.estimated;
            let shown = if r.estimated {
                Some(0.0)
            } else {
                finite(get(pr, "percent"))
            };
            let rem = remain(&num(shown));
            let remaining = rem
                .map(|n| {
                    part(
                        "quotaRemainingPct",
                        Some(obj!("pct"=>pct(&fmt(&V::Number(n)),r.estimated))),
                    )
                })
                .unwrap_or_else(|| p("quotaRemainingUnknown"));
            let used = shown
                .map(|n| {
                    part(
                        "quotaUsedPct",
                        Some(obj!("pct"=>pct(&fmt(&V::Number(n)),r.estimated))),
                    )
                })
                .unwrap_or_else(|| p("quotaUsedUnknown"));
            let totals = if !get(pr, "used").is_nullish() && !get(pr, "total").is_nullish() {
                concat(&[
                    V::from(" ("),
                    pct(
                        &fmt(&if r.estimated {
                            V::Number(0.0)
                        } else {
                            field(pr, "used")
                        }),
                        r.estimated,
                    ),
                    V::from("/"),
                    fmt(get(pr, "total")),
                    V::from(")"),
                ])
            } else {
                V::from("")
            };
            let reset = if at != V::Null {
                part(
                    "quotaResetSuffix",
                    Some(obj!("at"=>cd(&at,&ark_window(get(pr,"label"))))),
                )
            } else {
                V::Null
            };
            lines.push(part("quotaArkPeriodLine",Some(obj!("period"=>period(get(pr,"label")),"remaining"=>remaining,"used"=>used,"total"=>totals,"reset"=>reset))));
        }
    }
    if any_estimated {
        lines.push(estimated());
    }
    let viewer = get(v, "viewer");
    let mut title = vec![p("quotaArkTitle")];
    if js::truthy(get(viewer, "user_name")) || js::truthy(get(viewer, "account_id")) {
        title.push(part("quotaArkIdentityLine",Some(obj!("identity"=>concat(&[or(get(viewer,"user_name"),get(viewer,"account_id")),if js::truthy(get(viewer,"auth_method")){concat(&[V::from(" · "),field(viewer,"auth_method")])}else{V::from("")}])))));
    }
    title.extend(lines);
    title.extend([sync(get(v, "fetchedAt")), refresh()]);
    let mut texts = vec![product(get(plan, "product"))];
    let segments: Vec<_> = segments
        .into_iter()
        .map(|(_, s)| s)
        .filter(js::truthy)
        .collect();
    if !segments.is_empty() {
        texts.push(piece_j(
            concat(&[V::from(" · "), join_values(segments, " · ")]),
            "",
        ));
    }
    let a = ago(get(v, "fetchedAt"));
    if !a.is_empty() {
        texts.push(piece_j(a, " · "));
    }
    texts.push(piece_j("⟳", " "));
    view(texts, color(remain(&V::Number(max_used))), title, V::Null)
}
pub(super) fn zhipu(v: &V, now: f64) -> V {
    if !js::truthy(v) {
        return simple("quotaZhipuIdleText", GRAY, "quotaZhipuIdleTitle", "");
    }
    if get(v, "status") == &V::from("not_configured") {
        return simple(
            "quotaZhipuNotConfiguredText",
            GRAY,
            "quotaZhipuNotConfiguredTitle",
            "",
        );
    }
    if get(v, "status") != &V::from("ok") || !is_array(get(v, "sites")) {
        return unavailable(v, "Zhipu", "quotaZhipuUnavailableTitle");
    }
    let sites: Vec<_> = array(get(v, "sites"))
        .iter()
        .filter(|s| {
            js::truthy(s) && js::truthy(get(s, "ok")) && exact_number(get(s, "usedPercent"))
        })
        .collect();
    if sites.is_empty() {
        return simple(
            "quotaZhipuUnavailableText",
            YELLOW,
            "quotaZhipuNoValidSiteTitle",
            "",
        );
    }
    let s = sites[0];
    let read = |s: &V, used: &str, at: &str| {
        reading(
            get(s, used),
            &or(get(s, at), &V::Null),
            get(v, "fetchedAt"),
            now,
        )
    };
    let r5 = read(s, "usedPercent", "resetsAt");
    let rw = read(s, "weeklyUsedPercent", "weeklyResetsAt");
    let mut max_used = js::js_to_number(&r5.used);
    let mut segments = vec![seg(&V::from("5h"), &r5, &or(get(s, "resetsAt"), &V::Null))];
    if exact_number(get(s, "weeklyUsedPercent")) {
        max_used = max_used.max(js::js_to_number(&rw.used));
        segments.push(seg(
            &V::from("1wk"),
            &rw,
            &or(get(s, "weeklyResetsAt"), &V::Null),
        ));
    }
    let mut title = vec![p("quotaZhipuUsageTitle")];
    let mut any = false;
    for site in sites {
        let r5 = read(site, "usedPercent", "resetsAt");
        let rw = read(site, "weeklyUsedPercent", "weeklyResetsAt");
        any |= r5.estimated || rw.estimated;
        let reset = if js::truthy(get(site, "resetsAt")) {
            part(
                "quotaResetSuffix",
                Some(obj!("at"=>cd(get(site,"resetsAt"),&V::from("5h")))),
            )
        } else {
            V::Null
        };
        let weekly = if exact_number(get(site, "weeklyUsedPercent")) {
            part(
                "quotaZhipuWeeklySegment",
                Some(
                    obj!("pct"=>pct(&fmt(&rw.used),rw.estimated),"reset"=>if js::truthy(get(site,"weeklyResetsAt")){part("quotaZhipuWeeklyReset",Some(obj!("at"=>cd(get(site,"weeklyResetsAt"),&V::from("1wk")))))}else{V::Null}),
                ),
            )
        } else {
            V::Null
        };
        title.push(part("quotaZhipuSiteLine",Some(obj!("site"=>field(site,"site"),"host"=>field(site,"host"),"pct"=>pct(&fmt(&r5.used),r5.estimated),"reset"=>reset,"weekly"=>weekly,"tier"=>if js::truthy(get(site,"tier")){concat(&[V::from(" · "),field(site,"tier")])}else{V::from("")}))));
    }
    if any {
        title.push(estimated());
    }
    title.extend([sync(get(v, "fetchedAt")), refresh()]);
    let segment = segments
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    view(
        tail(
            if segment.is_empty() {
                String::from("—")
            } else {
                segment
            },
            get(v, "fetchedAt"),
        ),
        color(remain(&V::Number(max_used))),
        title,
        V::Null,
    )
}
fn kimi_reason(sites: &V, short: bool) -> V {
    let Some(s) = array(sites).first() else {
        return V::Null;
    };
    let reason = strict_text(s, "reason");
    let key = match (reason.as_str(), short) {
        ("auth_rejected", false) => "quotaKimiReasonAuthRejected",
        ("auth_rejected", true) => "quotaKimiShortAuthRejected",
        ("endpoint_not_found", false) => "quotaKimiReasonEndpointNotFound",
        ("endpoint_not_found", true) => "quotaKimiShortEndpointNotFound",
        ("network_error", false) => "quotaKimiReasonNetworkError",
        ("network_error", true) => "quotaKimiShortNetworkError",
        ("bad_shape" | "no_balance_fields", false) => "quotaKimiReasonBadShape",
        ("bad_shape" | "no_balance_fields", true) => "quotaKimiShortBadShape",
        _ => {
            return if !short && js::truthy(get(s, "reason")) {
                piece(field(s, "reason"))
            } else {
                V::Null
            }
        }
    };
    p(key)
}
fn kimi_sites(v: &V) -> Vec<&V> {
    if get(v, "status") != &V::from("ok") {
        return vec![];
    }
    array(get(v, "sites"))
        .iter()
        .filter(|s| js::truthy(s) && js::truthy(get(s, "ok")) && exact_number(get(s, "available")))
        .collect()
}
fn kimi_cached(sites: &[&V], fetched: &V, reason: V, headline: V) -> V {
    let s = sites[0];
    let amount = balance_text(get(s, "available"), get(s, "currency"));
    let a = ago(fetched);
    let n = js::js_to_number(get(s, "available"));
    let c = if n <= 0.0 {
        RED
    } else if n <= 5.0 {
        YELLOW
    } else {
        GRAY
    };
    let mut title = vec![headline];
    if js::truthy(&reason) {
        title.push(part(
            "quotaKimiCachedReasonLine",
            Some(obj!("reason"=>reason)),
        ));
    }
    if !a.is_empty() {
        title.push(part("quotaKimiCachedAtLine", Some(obj!("ago"=>a.clone()))));
    }
    title.push(p("quotaKimiRetryHint"));
    let mut texts = vec![piece(if amount.is_empty() {
        String::from("—")
    } else {
        amount
    })];
    if !a.is_empty() {
        texts.push(piece(format!(" · 上次 {a}")));
    }
    texts.push(piece_j("⟳", " "));
    view(texts, c, title, V::Null)
}
pub(super) fn kimi(v: &V, cached: &V, now: f64) -> V {
    let cached_sites = kimi_sites(cached);
    if !js::truthy(v) {
        if !cached_sites.is_empty() {
            return kimi_cached(
                &cached_sites,
                get(cached, "fetchedAt"),
                V::Null,
                p("quotaKimiCachedTitle"),
            );
        }
        return simple("quotaKimiIdleText", GRAY, "quotaKimiIdleTitle", "");
    }
    let status = strict_text(v, "status");
    if status == "not_configured" {
        return simple(
            "quotaKimiNotConfiguredText",
            GRAY,
            "quotaKimiNotConfiguredTitle",
            "",
        );
    }
    if status == "needs_login" || status == "chrome_unavailable" {
        let login = status == "needs_login";
        let mut lines = vec![if js::truthy(get(v, "error")) {
            piece(field(v, "error"))
        } else {
            p(if login {
                "quotaKimiNeedsLoginTitle"
            } else {
                "quotaKimiNoBrowserTitle"
            })
        }];
        let reason = kimi_reason(get(v, "sites"), false);
        if js::truthy(&reason) {
            lines.push(part("quotaKimiApiReasonLine", Some(obj!("reason"=>reason))));
        }
        if let Some(s) = cached_sites.first() {
            let amount = balance_text(get(s, "available"), get(s, "currency"));
            lines.push(part(
                "quotaKimiLastBalanceLine",
                Some(obj!("amount"=>if amount.is_empty(){String::from("—")}else{amount})),
            ));
        }
        lines.push(p("quotaKimiLoginHint"));
        return view(
            vec![p(if login {
                "quotaKimiNeedsLoginText"
            } else {
                "quotaKimiNoBrowserText"
            })],
            if login { RED } else { YELLOW },
            lines,
            V::from("login"),
        );
    }
    if status == "ok" && get(v, "source") == &V::from("subscription-page") {
        let rows: Vec<_> = array(get(v, "summary"))
            .iter()
            .filter_map(|s| {
                let used = if exact_number(get(s, "usedPercent")) {
                    field(s, "usedPercent")
                } else {
                    field(s, "percent")
                };
                if !exact_number(&used) {
                    return None;
                }
                let label = or(get(s, "window"), &or(get(s, "label"), &V::from("Kimi")));
                let at = if exact_number(get(s, "resetMs")) {
                    field(s, "resetMs")
                } else {
                    V::Null
                };
                let r = reading(&used, &at, get(v, "fetchedAt"), now);
                Some((label, used, at, r))
            })
            .collect();
        if rows.is_empty() {
            let s = js::js_to_string(&or(get(v, "text"), &V::from(""))).truncate_units(300);
            return view(
                vec![p("quotaKimiSubscriptionNoParseText")],
                YELLOW,
                vec![part(
                    "quotaKimiSubscriptionNoParseTitle",
                    Some(obj!("text"=>V::String(s))),
                )],
                V::Null,
            );
        }
        let mut ordered = rows.clone();
        ordered.sort_by_key(|(label, _, _, _)| rank(label));
        let segment = join_values(
            ordered
                .iter()
                .map(|(label, _, at, r)| seg_value(label, r, at)),
            " · ",
        );
        let max = worst(rows.iter().map(|(_, _, _, r)| js::js_to_number(&r.used)));
        let mut title = vec![p("quotaKimiSubscriptionTitle")];
        for (label, _, _, r) in &rows {
            title.push(part(
                "quotaKimiSummaryLine",
                Some(obj!("label"=>label.clone(),"used"=>pct(&r.used,r.estimated))),
            ));
        }
        if rows.iter().any(|(_, _, _, r)| r.estimated) {
            title.push(estimated());
        }
        title.extend([sync(get(v, "fetchedAt")), refresh()]);
        return view(
            tail(segment, get(v, "fetchedAt")),
            color(remain(&V::Number(max))),
            title,
            V::Null,
        );
    }
    let sites = kimi_sites(v);
    if sites.is_empty() {
        let reason = kimi_reason(get(v, "sites"), false);
        if !cached_sites.is_empty() {
            return kimi_cached(
                &cached_sites,
                get(cached, "fetchedAt"),
                reason,
                p("quotaKimiCachedStaleTitle"),
            );
        }
        let short = kimi_reason(get(v, "sites"), true);
        let text = if js::truthy(&short) {
            part(
                "quotaKimiUnavailableTextReason",
                Some(obj!("reason"=>short)),
            )
        } else {
            p("quotaKimiUnavailableText")
        };
        return view(
            vec![text],
            YELLOW,
            vec![if js::truthy(&reason) {
                reason
            } else if js::truthy(get(v, "error")) {
                piece(field(v, "error"))
            } else {
                p("quotaKimiUnavailableTitle")
            }],
            V::Null,
        );
    }
    let mut title = vec![p("quotaKimiBalanceTitle")];
    for s in &sites {
        title.push(part("quotaKimiSiteBalanceLine",Some(obj!("site"=>field(s,"site"),"host"=>field(s,"host"),"available"=>fmt(get(s,"available")),"voucher"=>if exact_number(get(s,"voucher")){part("quotaKimiVoucherSegment",Some(obj!("amount"=>fmt(get(s,"voucher")))))}else{V::Null},"cash"=>if exact_number(get(s,"cash")){part("quotaKimiCashSegment",Some(obj!("amount"=>fmt(get(s,"cash")))))}else{V::Null}))));
    }
    title.extend([sync(get(v, "fetchedAt")), refresh()]);
    let s = sites[0];
    let amount = balance_text(get(s, "available"), get(s, "currency"));
    let n = js::js_to_number(get(s, "available"));
    view(
        tail(
            if amount.is_empty() {
                String::from("—")
            } else {
                amount
            },
            get(v, "fetchedAt"),
        ),
        if n <= 0.0 {
            RED
        } else if n <= 5.0 {
            YELLOW
        } else {
            BLUE
        },
        title,
        V::Null,
    )
}
