use super::*;
use serde_json::json;

fn temp(tag: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-account-subscription-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn write(path: &Path, document: &serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, document.to_string()).unwrap();
}

#[test]
fn account_ids_are_parsed_like_the_express_query() {
    let cases = [
        ("/api/claude/subscription", ""),
        ("/api/claude/subscription?account=", ""),
        ("/api/claude/subscription?account=%20abc%20", "abc"),
        ("/api/claude/subscription?account=a+b", "a b"),
        ("/api/claude/subscription?account=a&account=b", "a,b"),
        ("/api/claude/subscription?account[]=a&account[]=b", "a,b"),
        ("/api/claude/subscription?account[0]=a", "a"),
        ("/api/claude/subscription?account[a]=b", "[object Object]"),
        ("/api/claude/subscription?account=%E2%80%AFx%E2%80%AF", "x"),
        ("/api/claude/subscription?other=1", ""),
        // A lone `+` decodes to a space and is trimmed away.
        ("/api/claude/subscription?account=+%20+", ""),
    ];
    for (url, expected) in cases {
        assert_eq!(account(url), expected, "{url}");
    }
}

#[test]
fn only_lowercase_sixteen_hex_ids_are_valid() {
    assert!(valid_account("0123456789abcdef"));
    assert!(valid_account("ffffffffffffffff"));
    assert!(!valid_account("0123456789ABCDEF"));
    assert!(!valid_account("0123456789abcde"));
    assert!(!valid_account("0123456789abcdef0"));
    assert!(!valid_account("g123456789abcdef"));
    assert!(!valid_account(""));
    assert!(!valid_account("0123456789abcde\u{00e9}"));
}

#[test]
fn account_paths_follow_home() {
    let home = Path::new("/tmp/example-home");
    assert_eq!(
        codex_auth_file(home, ""),
        Path::new("/tmp/example-home/.codex/auth.json")
    );
    assert_eq!(
        codex_auth_file(home, "0123456789abcdef"),
        Path::new("/tmp/example-home/.multicc/official-accounts/codex/0123456789abcdef/auth.json")
    );
    assert_eq!(
        claude_account_file(home, "0123456789abcdef"),
        Path::new("/tmp/example-home/.multicc/official-accounts/claude/0123456789abcdef.json")
    );
    assert_eq!(
        cli_credentials_file(home),
        Path::new("/tmp/example-home/.claude/.credentials.json")
    );
}

#[test]
fn claude_accounts_are_regular_json_files_with_hex_names() {
    let home = temp("known");
    let dir = official_root(&home).join("claude");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("0123456789abcdef.json"), "{}").unwrap();
    std::fs::write(dir.join("fedcba9876543210.json"), "{}").unwrap();
    std::fs::write(dir.join("0123456789ABCDEF.json"), "{}").unwrap();
    std::fs::write(dir.join("0123456789abcde.txt"), "{}").unwrap();
    std::fs::create_dir_all(dir.join("aaaaaaaaaaaaaaaa.json")).unwrap();

    assert!(claude_account_known(&home, "0123456789abcdef"));
    assert!(claude_account_known(&home, "fedcba9876543210"));
    assert!(!claude_account_known(&home, "0123456789ABCDEF"));
    assert!(!claude_account_known(&home, "aaaaaaaaaaaaaaaa"));
    assert!(!claude_account_known(&home, "1111111111111111"));
    assert!(!claude_account_known(&temp("missing"), "0123456789abcdef"));

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            dir.join("0123456789abcdef.json"),
            dir.join("bbbbbbbbbbbbbbbb.json"),
        )
        .unwrap();
        // Dirent.isFile() is false for a symlink, and so is Rust's file_type.
        assert!(!claude_account_known(&home, "bbbbbbbbbbbbbbbb"));
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn peeked_tokens_respect_the_sixty_second_margin() {
    let home = temp("peek");
    let id = "0123456789abcdef";
    let file = claude_account_file(&home, id);
    let now = 1_700_000_000_000i64;
    write(
        &file,
        &json!({"access_token":"stored-token","expired":"2099-01-01T00:00:00Z"}),
    );
    assert_eq!(
        peek_claude_token(&home, id, now).as_deref(),
        Some("stored-token")
    );
    // The account file's expiry field is `expired` (ISO string or epoch ms);
    // the peek margin is strict, so only a value past now+60s is usable.
    write(
        &file,
        &json!({"access_token":"soon","expired":now + 61_000}),
    );
    assert_eq!(
        peek_claude_token(&home, id, now).as_deref(),
        Some("soon"),
        "61s left clears the 60s peek margin"
    );
    write(
        &file,
        &json!({"access_token":"lapsed","expired":now + 59_000}),
    );
    assert_eq!(
        peek_claude_token(&home, id, now),
        None,
        "59s left is inside the margin"
    );
    write(
        &file,
        &json!({"access_token":"stale","expired":now + 60_000}),
    );
    assert_eq!(
        peek_claude_token(&home, id, now),
        None,
        "exactly the margin is expired (strict >)"
    );
    write(&file, &json!({"access_token":"fresh"}));
    assert_eq!(peek_claude_token(&home, id, now).as_deref(), Some("fresh"));
    write(&file, &json!({"refresh_token":"only"}));
    assert_eq!(peek_claude_token(&home, id, now), None);
    write(&file, &json!([1, 2, 3]));
    assert_eq!(peek_claude_token(&home, id, now), None);
    std::fs::remove_file(&file).unwrap();
    assert_eq!(peek_claude_token(&home, id, now), None);
    assert_eq!(
        peek_claude_token(&home, "../outside", now),
        None,
        "an invalid id never becomes a path"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn global_cli_credentials_need_ok_and_a_live_expiry() {
    let now = 1_700_000_000_000i64;
    assert_eq!(
        global_claude_token(
            &json!({"ok":true,"accessToken":"cli","expiresAt":null}),
            now
        )
        .as_deref(),
        Some("cli")
    );
    assert_eq!(
        global_claude_token(&json!({"ok":true,"accessToken":"cli"}), now).as_deref(),
        Some("cli"),
        "a missing expiry is accepted like a null one"
    );
    assert_eq!(
        global_claude_token(
            &json!({"ok":true,"accessToken":"cli","expiresAt":now + 1}),
            now
        )
        .as_deref(),
        Some("cli")
    );
    assert_eq!(
        global_claude_token(&json!({"ok":true,"accessToken":"cli","expiresAt":now}), now),
        None
    );
    assert_eq!(
        global_claude_token(
            &json!({"ok":false,"accessToken":"cli","expiresAt":null}),
            now
        ),
        None
    );
    assert_eq!(
        global_claude_token(&json!({"ok":true,"expiresAt":null}), now),
        None
    );
}

#[test]
fn plans_match_the_native_host_contract() {
    let no_auth = json!({"result":{"status":"no_auth"}});
    assert_eq!(plan("claude", Path::new("/unused"), "").unwrap(), no_auth);
    let claude = plan("claude", Path::new("/unused"), "tok").unwrap();
    assert_eq!(claude["vendor"], "claude");
    assert_eq!(claude["url"], "https://api.anthropic.com/api/oauth/profile");
    assert_eq!(claude["headers"]["Authorization"], "Bearer tok");
    assert_eq!(claude["headers"]["User-Agent"], "axios/1.15.2");
    assert_eq!(claude["headers"]["Cache-Control"], "no-cache");
    assert_eq!(claude["fallback"], Value::Null);

    let home = temp("plan");
    let missing = codex_auth_file(&home, "0123456789abcdef");
    assert_eq!(plan("codex", &missing, "").unwrap(), no_auth);
    write(
        &missing,
        &json!({"tokens":{"access_token":"codex-token","account_id":"acct-1"}}),
    );
    let codex = plan("codex", &missing, "").unwrap();
    assert_eq!(codex["vendor"], "codex");
    assert_eq!(codex["url"], "https://chatgpt.com/backend-api/wham/usage");
    assert_eq!(codex["headers"]["Authorization"], "Bearer codex-token");
    assert_eq!(codex["headers"]["ChatGPT-Account-Id"], "acct-1");
    assert_eq!(codex["headers"]["originator"], "codex_cli_rs");
    write(&missing, &json!({"tokens":{"account_id":"acct-1"}}));
    assert_eq!(plan("codex", &missing, "").unwrap(), no_auth);
    write(&missing, &json!({"tokens":{}}));
    assert_eq!(plan("codex", &missing, "").unwrap(), no_auth);
    std::fs::write(&missing, "{not json").unwrap();
    assert_eq!(plan("codex", &missing, "").unwrap(), no_auth);
    assert!(plan("other", &missing, "tok").is_err());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn results_map_statuses_and_fallbacks() {
    let codex_plan = json!({"vendor":"codex","fallback":{"nextBillingAt":1.0}});
    assert_eq!(
        result(&json!({"plan":codex_plan,"status":401,"body":null,"now":1})),
        json!({"status":"no_auth"})
    );
    assert_eq!(
        result(&json!({"plan":codex_plan,"status":500,"body":null,"now":1})),
        json!({"status":"unavailable","subscription":{"nextBillingAt":1.0},"stale":true})
    );
    assert_eq!(
        result(&json!({"plan":codex_plan,"status":429,"body":{"error":"rate"},"now":1})),
        json!({"status":"unavailable","subscription":{"nextBillingAt":1.0},"stale":true})
    );
    assert_eq!(
        result(&json!({"plan":codex_plan,"status":200,"body":null,"now":1})),
        json!({"status":"unavailable","subscription":{"nextBillingAt":1.0},"stale":true}),
        "invalid JSON arrives as a null body and is not cached as a success"
    );
    assert_eq!(
        result(&json!({"plan":{"vendor":"claude"},"status":503,"body":null,"now":1})),
        json!({"status":"unavailable"})
    );

    let parsed = result(&json!({
        "plan": codex_plan,
        "status": 200,
        "body": {"subscription": {"next_billing_at": "2026-01-01T00:00:00Z"}},
        "now": 1_700_000_000_000i64
    }));
    assert_eq!(parsed["status"], "ok");
    assert_eq!(parsed["subscription"]["nextBillingAt"], 1_767_225_600_000.0);

    let profile = result(&json!({
        "plan": {"vendor":"claude"},
        "status": 200,
        "body": {"organization": {"subscription": {"current_period_end": "2026-02-01T00:00:00Z"}}},
        "now": 1_700_000_000_000i64
    }));
    assert_eq!(profile["status"], "ok");
    assert_eq!(
        profile["subscription"]["currentPeriodEnd"],
        1_769_904_000_000.0
    );

    // An object with no billing evidence parses to null; codex keeps its
    // login-time fallback, claude has none.
    let empty = result(&json!({
        "plan": codex_plan, "status": 200, "body": {"ok": true}, "now": 1
    }));
    assert_eq!(
        empty,
        json!({"status":"ok","subscription":{"nextBillingAt":1.0}})
    );
    let no_evidence = result(&json!({
        "plan": {"vendor":"claude"}, "status": 200, "body": {"ok": true}, "now": 1
    }));
    assert_eq!(no_evidence, json!({"status":"ok","subscription":null}));
}
