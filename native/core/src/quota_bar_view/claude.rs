use super::*;
fn names_window(label: &V) -> bool {
    regex::Regex::new(r"(?i)session|hour|week|month|[0-9]+[\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*(h|day)")
        .unwrap()
        .is_match(&empty(label))
}
pub(super) fn row_name(window: &V, label: &V) -> V {
    let l = js::js_to_string(&or(label, &V::from(""))).trim();
    if l.is_empty() || names_window(&V::String(l.clone())) {
        return window.clone();
    }
    if regex::Regex::new(r"(?i)^all(?-u:\b)")
        .unwrap()
        .is_match(&l.to_string_lossy())
    {
        return concat(&[window.clone(), V::from("-ALL")]);
    }
    let units = l.as_units();
    let end = units
        .iter()
        .position(|n| js::is_js_whitespace(*n) || *n == 0x28 || *n == 0xff08)
        .unwrap_or(units.len())
        .min(10);
    concat(&[
        window.clone(),
        V::from("-"),
        V::String(l.slice_units(0, end)),
    ])
}
struct Row {
    window: V,
    name: V,
    label: V,
    at: V,
    r: Reading,
}
fn rows(usage: &V, live: &V, now: f64) -> Vec<Row> {
    let mut rows = Vec::new();
    if get(usage, "status") == &V::from("ok") {
        for s in array(get(usage, "summary")) {
            // The historical scrape path indexes CLAUDE_WINDOW_ZH[s.window],
            // which coerces property keys. Unlike event/Codex enums, an array
            // such as ["5h"] is accepted here; retain its original value below.
            if !js::truthy(s)
                || !["5h", "1wk", "1m"].contains(&string(get(s, "window")).as_str())
                || !exact_number(get(s, "usedPercent"))
            {
                continue;
            }
            let at = num(finite(get(s, "resetMs")));
            rows.push(Row {
                window: field(s, "window"),
                name: row_name(get(s, "window"), get(s, "label")),
                label: V::String(js::js_to_string(&or(get(s, "label"), &V::from("")))),
                at: at.clone(),
                r: reading(get(s, "usedPercent"), &at, get(usage, "fetchedAt"), now),
            });
        }
    }
    if js::truthy(live) {
        let used = if get(live, "status") == &V::from("rejected") {
            Some(100.0)
        } else {
            finite(get(live, "usedPercentage"))
        };
        if let Some(used) = used {
            let at = num(finite(get(live, "resetsAtMs")));
            let row = Row {
                window: V::from("5h"),
                name: V::from("5h"),
                label: V::from(""),
                at: at.clone(),
                r: reading(&V::Number(used), &at, get(live, "observedAtMs"), now),
            };
            if let Some(i) = rows.iter().position(|r| r.window == V::from("5h")) {
                rows[i] = row;
            } else {
                rows.push(row);
            }
        }
    }
    rows
}

fn state(usage: &V, special: &str) -> V {
    let (note, title, action) = if special == "fetching" {
        (
            "quotaClaudeScrapeFetchingNote",
            "quotaClaudeScrapeFetchingTitle",
            "fetching",
        )
    } else if special == "login_pending" {
        (
            "quotaClaudeScrapeLoginPendingNote",
            "quotaClaudeScrapeLoginPendingTitle",
            "login_pending",
        )
    } else if !js::truthy(usage) {
        (
            "quotaClaudeScrapeIdleNote",
            "quotaClaudeScrapeIdleTitle",
            "",
        )
    } else {
        match strict_text(usage, "status").as_str() {
            "needs_login" => (
                "quotaClaudeScrapeNeedsLoginNote",
                "quotaClaudeScrapeNeedsLoginTitle",
                "login",
            ),
            "chrome_unavailable" => (
                "quotaClaudeScrapeChromeNote",
                "quotaClaudeScrapeChromeTitle",
                "login",
            ),
            "ok" => ("quotaClaudeScrapeOkNote", "quotaClaudeScrapeOkTitle", ""),
            _ => (
                "quotaClaudeScrapeFailedNote",
                "quotaClaudeScrapeFailedTitle",
                "",
            ),
        }
    };
    let mut s = obj!("note"=>p(note),"title"=>p(title));
    if !action.is_empty() {
        set(&mut s, "action", V::from(action));
    }
    s
}
fn for_state(usage: &V, live: &V, state: &V, now: f64) -> V {
    let rows = rows(usage, live, now);
    let missing: Vec<_> = ["5h", "1wk"]
        .into_iter()
        .filter(|w| !rows.iter().any(|r| r.window == V::from(*w)))
        .collect();
    let mut entries: Vec<(V, V, V)> = missing
        .iter()
        .map(|w| {
            let window = V::from(*w);
            let line = part(
                "quotaClaudeMissingDetail",
                Some(obj!("window"=>window_name(&window),"note"=>field(state,"note"))),
            );
            (window, piece(format!("{w} -")), line)
        })
        .collect();
    for r in &rows {
        let from = if js::truthy(&r.label) && !names_window(&r.label) {
            part("quotaClaudeRowFrom", Some(obj!("label"=>r.label.clone())))
        } else {
            V::Null
        };
        let line = part(
            "quotaClaudeWindowDetail",
            Some(
                obj!("window"=>window_name(&r.window),"from"=>from,"pct"=>pct(&V::Number(round(js::js_to_number(&r.r.used))),r.r.estimated),"reset"=>reset_suffix(&r.at,&r.window)),
            ),
        );
        entries.push((
            r.window.clone(),
            piece(seg_value(&r.name, &r.r, &r.at)),
            line,
        ));
    }
    entries.sort_by_key(|(w, _, _)| rank(w));
    let action = text(state, "action");
    let mut texts: Vec<_> = entries.iter().map(|(_, s, _)| s.clone()).collect();
    let a = ago(if get(usage, "status") == &V::from("ok") {
        get(usage, "fetchedAt")
    } else {
        &V::Null
    });
    if !a.is_empty() {
        texts.push(piece(a.clone()));
    }
    texts.push(p(match action.as_str() {
        "fetching" => "quotaClaudeActionFetching",
        "login_pending" => "quotaClaudeActionLoginPending",
        "login" => "quotaClaudeActionLogin",
        _ => "quotaClaudeActionRefresh",
    }));
    let mut title = vec![p("quotaClaudeTitle")];
    title.extend(entries.into_iter().map(|(_, _, line)| line));
    if rows.iter().any(|r| r.r.estimated) {
        title.push(estimated());
    }
    if !a.is_empty() {
        title.push(part("quotaSyncAt", Some(obj!("ago"=>a))));
    }
    if !missing.is_empty() || action == "fetching" || action == "login_pending" {
        title.push(field(state, "title"));
    }
    let c = if rows.is_empty() {
        GRAY
    } else {
        color(remain(&V::Number(worst(
            rows.iter().map(|r| js::js_to_number(&r.r.used)),
        ))))
    };
    view(texts, c, title, field(state, "action"))
}
pub(super) fn bar(usage: &V, live: &V, now: f64) -> V {
    let merged = if is_array(get(live, "windows")) {
        js::from_serde(&crate::claude_quota::run(
            &serde_json::json!({"op":"compose","usage":js::to_serde(usage),"live":js::to_serde(live),"nowMs":now}),
        ))
    } else {
        V::Null
    };
    let (usage, live) = if js::truthy(&merged) {
        (get(&merged, "usage"), get(&merged, "live"))
    } else {
        (usage, live)
    };
    with_states(
        for_state(usage, live, &state(usage, ""), now),
        obj!("fetching"=>for_state(usage,live,&state(usage,"fetching"),now),"login_pending"=>for_state(usage,live,&state(usage,"login_pending"),now),"unreachable"=>unreachable("claude")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrape_window_keys_preserve_property_lookup_coercion() {
        for window in [
            V::Array(vec![V::from("5h")]),
            V::Array(vec![V::from("1wk")]),
            V::Array(vec![V::from("1m")]),
            V::Array(vec![V::Array(vec![V::from("5h")])]),
        ] {
            assert!(!known_window(&window));
            let usage = obj!("status"=>"ok","summary"=>V::Array(vec![obj!("window"=>window.clone(),"usedPercent"=>40.0)]));
            let result = rows(&usage, &V::Null, 1_700_000_000_000.0);
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].window, window);
            assert_eq!(result[0].r.used, V::Number(40.0));
        }
        let usage = obj!("status"=>"ok","summary"=>V::Array(vec![obj!("window"=>V::Array(vec![V::from("5h")]),"usedPercent"=>"40")]));
        assert!(rows(&usage, &V::Null, 1_700_000_000_000.0).is_empty());
    }
}
