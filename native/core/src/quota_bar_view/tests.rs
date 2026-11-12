use super::*;

#[test]
fn compact_refresh_requires_absolute_end_before_trimming() {
    for keep_countdown in [false, true] {
        assert_eq!(compact(&V::from("x ⟳ 刷新"), keep_countdown), V::from("x"));
        assert_eq!(
            compact(&V::from("x\n ⟳ 刷新"), keep_countdown),
            V::from("x")
        );
        for ending in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}", "\n\n"] {
            assert_eq!(
                compact(&V::from(format!("x ⟳ 刷新{ending}")), keep_countdown),
                V::from("x ⟳ 刷新"),
                "line ending {ending:?}, keep_countdown={keep_countdown}",
            );
        }
    }
}

#[test]
fn compact_preserves_utf16_and_javascript_whitespace_and_token_rules() {
    for (input, expected) in [
        (r#""x\ud800 · {ago:1} ⟳ 刷新""#, r#""x\ud800""#),
        (r#""x\udfff\ufeff⟳ 刷新""#, r#""x\udfff""#),
        (r#""x\u0085⟳ 刷新""#, r#""x\u0085""#),
        (r#""x {cd:١|5h}""#, r#""x {cd:١|5h}""#),
    ] {
        assert_eq!(
            compact(&js::json_parse(input).unwrap(), false),
            js::json_parse(expected).unwrap(),
            "{input}",
        );
    }
    let value = V::from("x {cd:1|5h} · {ago:1}");
    assert_eq!(compact(&value, false), V::from("x"));
    assert_eq!(compact(&value, true), V::from("x {cd:1|5h}"));
}

#[test]
fn event_windows_accept_only_string_enum_values() {
    let invalid = [
        V::Array(vec![V::from("5h")]),
        V::Array(vec![V::from("1wk")]),
        V::Array(vec![V::from("1m")]),
        V::Array(vec![V::Array(vec![V::from("5h")])]),
        V::Object(vec![]),
        V::Null,
        V::Bool(true),
        V::Number(5.0),
        V::from("5h-ALL"),
    ];
    for value in &invalid {
        assert!(!known_window(value), "{value:?}");
    }
    let mut windows = invalid
        .into_iter()
        .map(|window| obj!("window"=>window,"usedPercent"=>40.0))
        .collect::<Vec<_>>();
    for window in ["5h", "1wk", "1m"] {
        windows.push(obj!("window"=>window,"usedPercent"=>60.0));
    }
    let input = obj!("provider"=>"codex","rateLimitType"=>"weekly","status"=>"allowed","utilization"=>0.5,"windows"=>V::Array(windows));
    let normalized = normalize_window(&input, 1_700_000_000_000.0);
    let actual = array(get(&normalized, "windows"));
    assert_eq!(actual.len(), 3);
    for (row, expected) in actual.iter().zip(["5h", "1wk", "1m"]) {
        assert_eq!(get(row, "window"), &V::from(expected));
        assert_eq!(get(row, "usedPercent"), &V::Number(60.0));
    }
}
