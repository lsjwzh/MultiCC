use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "multicc-agy-accounts-{}-{}-{}",
        std::process::id(),
        tag,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(file: &Path, value: &serde_json::Value) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, serde_json::to_vec(value).unwrap()).unwrap();
}

fn signed_in_home(home: &Path) {
    let gemini = home.join(".gemini");
    write(
        &gemini.join("oauth_creds.json"),
        &json!({"access_token":"secret-access","refresh_token":"secret-refresh","expiry_date":1893456000000i64}),
    );
    write(
        &gemini.join("google_accounts.json"),
        &json!({"active":"alice@example.com","old":["bob@example.com"]}),
    );
    write(&gemini.join("settings.json"), &json!({"theme":"dark"}));
    write(
        &gemini.join("antigravity-cli/settings.json"),
        &json!({"telemetry":false}),
    );
    // Runtime caches must not be copied.
    fs::create_dir_all(gemini.join("brain/conv-1")).unwrap();
    fs::write(gemini.join("brain/conv-1/message.json"), b"{}").unwrap();
    fs::write(gemini.join("antigravity-cli/cli.log"), b"noise").unwrap();
    fs::write(gemini.join("antigravity-cli/conversations.db"), b"db").unwrap();
}

#[test]
fn account_ids_are_validated_before_any_path_join() {
    assert!(valid_account("0123456789abcdef"));
    assert!(!valid_account("0123456789ABCDEF"));
    assert!(!valid_account("0123456789abcde"));
    assert!(!valid_account("../../etc/passwd"));
    assert!(account_home(Path::new("/tmp/h"), "../../etc").is_none());
    assert!(meta_file(Path::new("/tmp/h"), "zz").is_none());
    assert_eq!(
        account_home(Path::new("/tmp/h"), "0123456789abcdef").unwrap(),
        Path::new("/tmp/h/.multicc/official-accounts/agy/0123456789abcdef.home")
    );
}

#[test]
fn create_makes_an_empty_home_and_metadata() {
    let home = temp_home("create");
    let record = create_account(&home, "  工作号  ", "created").unwrap();
    let id = record["id"].as_str().unwrap();
    assert!(valid_account(id));
    assert_eq!(record["label"], "工作号");
    assert_eq!(record["source"], "created");
    // An empty account has no credentials yet.
    let status = login_status(&home, id);
    assert_eq!(status["loggedIn"], false);
    assert_eq!(status["email"], serde_json::Value::Null);
    assert!(account_home(&home, id).unwrap().is_dir());
    assert!(meta_file(&home, id).unwrap().is_file());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn create_defaults_the_label_and_truncates_long_ones() {
    let home = temp_home("label");
    let blank = create_account(&home, "   ", "created").unwrap();
    assert_eq!(blank["label"], DEFAULT_LABEL);
    let long = "字".repeat(200);
    let record = create_account(&home, &long, "created").unwrap();
    assert_eq!(record["label"].as_str().unwrap().chars().count(), MAX_LABEL);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn import_copies_credentials_and_config_but_not_caches() {
    let home = temp_home("import");
    signed_in_home(&home);
    let record = import_account(&home, "").unwrap();
    let id = record["id"].as_str().unwrap();
    // The label falls back to the imported Google address.
    assert_eq!(record["label"], "alice@example.com");
    let target = account_home(&home, id).unwrap().join(".gemini");
    assert!(target.join("oauth_creds.json").is_file());
    assert!(target.join("google_accounts.json").is_file());
    assert!(target.join("settings.json").is_file());
    assert!(target.join("antigravity-cli/settings.json").is_file());
    assert!(!target.join("brain").exists());
    assert!(!target.join("antigravity-cli/cli.log").exists());
    assert!(!target.join("antigravity-cli/conversations.db").exists());
    let status = login_status(&home, id);
    assert_eq!(status["loggedIn"], true);
    assert_eq!(status["email"], "alice@example.com");
    assert_eq!(status["expiresAt"], 1893456000000i64);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn import_without_a_local_login_fails_and_leaves_nothing_behind() {
    let home = temp_home("import-empty");
    assert!(import_account(&home, "x").is_err());
    let root = account_root(&home);
    let leftovers: Vec<_> = match fs::read_dir(&root) {
        Ok(entries) => entries.flatten().collect(),
        Err(_) => vec![],
    };
    assert!(leftovers.is_empty());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn login_status_never_echoes_tokens() {
    let home = temp_home("secrets");
    signed_in_home(&home);
    let record = import_account(&home, "").unwrap();
    let status = login_status(&home, record["id"].as_str().unwrap());
    let text = serde_json::to_string(&status).unwrap();
    assert!(!text.contains("secret-access"));
    assert!(!text.contains("secret-refresh"));
    assert_eq!(status["email"], "alice@example.com");
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn active_round_trips_and_clears_on_delete() {
    let home = temp_home("active");
    let first = create_account(&home, "一号", "created").unwrap();
    let id = first["id"].as_str().unwrap();
    // Nothing is active until it is pinned.
    assert!(active_home(&home).is_none());
    set_active(&home, Some(id)).unwrap();
    assert_eq!(active_id(&home).as_deref(), Some(id));
    assert_eq!(
        active_home(&home).unwrap(),
        account_home(&home, id).unwrap()
    );
    // Clearing the pin sends agy back to the machine's own login.
    set_active(&home, None).unwrap();
    assert!(active_id(&home).is_none());
    set_active(&home, Some(id)).unwrap();
    delete_account(&home, id).unwrap();
    assert!(active_id(&home).is_none());
    assert!(!account_home(&home, id).unwrap().exists());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn setting_an_unknown_or_malformed_account_is_rejected() {
    let home = temp_home("unknown");
    assert_eq!(
        set_active(&home, Some("0123456789abcdef")).unwrap_err(),
        "unknown account"
    );
    assert_eq!(
        set_active(&home, Some("../../etc")).unwrap_err(),
        "invalid account id"
    );
    assert_eq!(
        delete_account(&home, "0123456789abcdef").unwrap_err(),
        "unknown account"
    );
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn list_accounts_is_oldest_first_and_marks_the_active_one() {
    let home = temp_home("list");
    let _older = create_account(&home, "旧号", "created").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let newer = create_account(&home, "新号", "created").unwrap();
    set_active(&home, Some(newer["id"].as_str().unwrap())).unwrap();
    let listed = list_accounts(&home);
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0]["label"], "旧号");
    assert_eq!(listed[1]["label"], "新号");
    assert_eq!(listed[0]["active"], false);
    assert_eq!(listed[1]["active"], true);
    assert_eq!(listed[0]["loggedIn"], false);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn an_empty_root_lists_nothing_and_no_active_account() {
    let home = temp_home("empty");
    assert!(list_accounts(&home).is_empty());
    assert!(active_id(&home).is_none());
    assert!(active_home(&home).is_none());
}

#[test]
fn resolve_home_prefers_explicit_binding_and_fails_closed_when_missing() {
    let home = temp_home("resolve");
    let first = create_account(&home, "一号", "created").unwrap();
    let second = create_account(&home, "二号", "created").unwrap();
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();

    assert!(has_account(&home, first_id));
    assert!(has_account(&home, second_id));
    assert!(!has_account(&home, "ffffffffffffffff"));
    assert!(!has_account(&home, "../../etc"));

    // Unpinned global + no explicit pick → real HOME (Ok(None)).
    assert_eq!(resolve_home(&home, None).unwrap(), None);
    assert_eq!(resolve_home(&home, Some("  ")).unwrap(), None);

    // Explicit binding pins its own account even without global active.
    assert_eq!(
        resolve_home(&home, Some(second_id)).unwrap(),
        account_home(&home, second_id)
    );

    // Global active applies when binding omits account_id, while explicit binding overrides it.
    set_active(&home, Some(first_id)).unwrap();
    assert_eq!(
        resolve_home(&home, None).unwrap(),
        account_home(&home, first_id)
    );
    assert_eq!(
        resolve_home(&home, Some(second_id)).unwrap(),
        account_home(&home, second_id)
    );

    // Deleted or malformed explicit binding must fail closed instead of falling back.
    delete_account(&home, second_id).unwrap();
    assert!(!has_account(&home, second_id));
    assert_eq!(
        resolve_home(&home, Some(second_id)).unwrap_err(),
        "unknown account"
    );
    assert_eq!(
        resolve_home(&home, Some("../../etc")).unwrap_err(),
        "invalid account id"
    );
    // Missing .home directory with lingering meta file also fails closed.
    fs::remove_dir_all(account_home(&home, first_id).unwrap()).unwrap();
    assert!(!has_account(&home, first_id));
    assert_eq!(
        resolve_home(&home, Some(first_id)).unwrap_err(),
        "unknown account"
    );
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn remote_vps_account_crud_resolution_and_activation_work() {
    let home = temp_home("remote-vps");
    let created = create_remote_account(
        &home,
        "新加坡 VPS",
        &json!({
            "sshTarget": "ubuntu@203.0.113.10",
            "sshPort": 2222,
            "fileMode": "mutagen",
            "remoteAgyBin": "/usr/local/bin/agy"
        }),
    )
    .unwrap();
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["kind"], KIND_REMOTE);
    assert_eq!(created["label"], "新加坡 VPS");
    assert!(has_account(&home, &id));
    // Remote accounts do not create a local `.home` directory.
    assert!(!account_home(&home, &id).unwrap().exists());

    // Explicit resolution returns ResolvedAgyAccount::Remote.
    match resolve_account(&home, Some(&id)).unwrap().unwrap() {
        ResolvedAgyAccount::Remote {
            id: resolved_id,
            label,
            remote,
        } => {
            assert_eq!(resolved_id, id);
            assert_eq!(label, "新加坡 VPS");
            assert_eq!(remote.ssh_target, "ubuntu@203.0.113.10");
            assert_eq!(remote.ssh_port, Some(2222));
            assert_eq!(remote.file_mode, "mutagen");
        }
        other => panic!("expected Remote, got {other:?}"),
    }

    // Can be activated globally and resolved via None.
    set_active(&home, Some(&id)).unwrap();
    assert!(matches!(
        resolve_account(&home, None).unwrap(),
        Some(ResolvedAgyAccount::Remote { .. })
    ));

    // Listing marks it as remote + active + loggedIn.
    let listed = list_accounts(&home);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["kind"], KIND_REMOTE);
    assert_eq!(listed[0]["active"], true);
    assert_eq!(listed[0]["loggedIn"], true);
    assert_eq!(listed[0]["remote"]["sshTarget"], "ubuntu@203.0.113.10");

    // Update switches fileMode to remote_mcp.
    let updated = update_remote_account(
        &home,
        &id,
        Some("东京零落盘 VPS"),
        &json!({
            "sshTarget": "dev@jp.example.com",
            "fileMode": "remote_mcp"
        }),
    )
    .unwrap();
    assert_eq!(updated["label"], "东京零落盘 VPS");
    assert_eq!(updated["remote"]["fileMode"], "remote_mcp");

    // Delete succeeds without `.home` directory and clears active.
    delete_account(&home, &id).unwrap();
    assert!(!has_account(&home, &id));
    assert!(active_id(&home).is_none());
    assert!(resolve_account(&home, Some(&id)).is_err());
    let _ = fs::remove_dir_all(&home);
}
