//! 远端 VPS `agy` 网页授权登录管理器（复刻 Claude / Codex 多账号 Magpie 体验）。
//!
//! 流程：
//! 1. 通过 SSH 在 VPS 上该账号专属的独立 `$HOME` 下运行 `agy acp --login`
//!    （带 `SSH_CONNECTION` / 空 `DISPLAY`，走官方 `https://antigravity.google/oauth-callback`）；
//! 2. 捕获输出的 Google OAuth 链接并立即返回给前端面板展示（「复制链接」/「打开浏览器」）；
//! 3. 用户在本机任意浏览器完成授权后，粘贴授权码或完整回调 URL 到面板；
//! 4. 本模块通过 stdin 喂给远端等待中的 `agy acp --login`，等其换票写盘完成后回读
//!    `$HOME/.gemini/google_accounts.json` 里的邮箱，更新本地账号元数据并置为 `complete`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use multicc_core::agy_accounts as store;
use multicc_core::agy_remote::{
    build_remote_login_script, extract_google_oauth_url, sanitize_oauth_callback, RemoteAgyTarget,
    DEFAULT_REMOTE_AGY_BIN,
};

const LOGIN_TTL: Duration = Duration::from_secs(5 * 60);
const URL_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const CALLBACK_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const ACCOUNTS_JSON_MARKER: &str = "MULTICC_LOGIN_ACCOUNTS_JSON=";

#[derive(Debug, Clone)]
struct LoginState {
    state: &'static str, // "pending" | "complete" | "error"
    oauth_url: Option<String>,
    email: Option<String>,
    error: Option<String>,
    updated_at: Instant,
}

struct LoginSession {
    status_rx: watch::Receiver<LoginState>,
    code_tx: Mutex<Option<mpsc::Sender<String>>>,
    cancel_tx: Mutex<Option<oneshot::Sender<()>>>,
}

fn sessions_map() -> &'static Mutex<HashMap<String, Arc<LoginSession>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<LoginSession>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartLocalLoginError {
    AgyNotInstalled,
    Message(String),
}

fn ssh_bin() -> String {
    std::env::var("MULTICC_SSH_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "ssh".to_string())
}

fn build_ssh_args(target: &RemoteAgyTarget, script: &str) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        "ConnectTimeout=20".to_string(),
    ];
    if let Some(port) = target.ssh_port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key) = &target.ssh_identity_file {
        args.push("-i".to_string());
        args.push(key.clone());
    }
    args.push(target.ssh_target.clone());
    args.push("--".to_string());
    // 把无密钥登录脚本放进远端命令参数，保证 stdin 100% 独占给 `agy acp --login` 读取用户粘贴的授权码。
    args.push(script.to_string());
    args
}

fn parse_email_from_accounts_json(raw: &str) -> Option<String> {
    let val: Value = serde_json::from_str(raw.trim()).ok()?;
    val.get("active")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn state_to_json(st: &LoginState) -> Value {
    json!({
        "state": st.state,
        "oauthUrl": st.oauth_url,
        "email": st.email,
        "error": st.error,
    })
}

/// 查询某个远端账号当前的登录会话状态（供轮询与账号列表附加 `login` 字段）。
pub async fn login_status(id: &str) -> Value {
    let session = {
        let map = sessions_map().lock().await;
        map.get(id).cloned()
    };
    let Some(session) = session else {
        return json!({ "state": "idle", "oauthUrl": Value::Null, "email": Value::Null, "error": Value::Null });
    };
    let st = session.status_rx.borrow().clone();
    if st.state == "pending" && st.updated_at.elapsed() > LOGIN_TTL {
        return json!({ "state": "idle", "oauthUrl": Value::Null, "email": Value::Null, "error": Value::Null });
    }
    state_to_json(&st)
}

async fn drive_login_child(
    home: &Path,
    account_id: &str,
    mut child: tokio::process::Child,
    is_local: bool,
) -> Result<Value, String> {
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开登录进程标准输入通道".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开登录进程标准输出通道".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法打开登录进程错误输出通道".to_string())?;

    let initial = LoginState {
        state: "pending",
        oauth_url: None,
        email: None,
        error: None,
        updated_at: Instant::now(),
    };
    let (status_tx, status_rx) = watch::channel(initial);
    let (code_tx, mut code_rx) = mpsc::channel::<String>(2);
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let (url_tx, url_rx) = oneshot::channel::<Result<String, String>>();

    let session = Arc::new(LoginSession {
        status_rx: status_rx.clone(),
        code_tx: Mutex::new(Some(code_tx)),
        cancel_tx: Mutex::new(Some(cancel_tx)),
    });
    sessions_map()
        .lock()
        .await
        .insert(account_id.to_string(), session.clone());

    let home_owned: PathBuf = home.to_path_buf();
    let id_owned = account_id.to_string();

    tokio::spawn(async move {
        let mut url_sender = Some(url_tx);
        let mut out_lines = BufReader::new(stdout).lines();
        let mut err_lines = BufReader::new(stderr).lines();
        let mut out_eof = false;
        let mut err_eof = false;
        let mut last_lines: Vec<String> = Vec::new();
        let mut detected_email: Option<String> = None;
        let deadline = tokio::time::sleep(LOGIN_TTL);
        tokio::pin!(deadline);

        let mut push_line = |line: String, status_tx: &watch::Sender<LoginState>| {
            if let Some(raw_json) = line.strip_prefix(ACCOUNTS_JSON_MARKER) {
                if let Some(mail) = parse_email_from_accounts_json(raw_json) {
                    detected_email = Some(mail);
                }
                return;
            }
            if let Some(url) = extract_google_oauth_url(&line) {
                status_tx.send_modify(|st| {
                    st.oauth_url = Some(url.clone());
                    st.updated_at = Instant::now();
                });
                if let Some(tx) = url_sender.take() {
                    let _ = tx.send(Ok(url));
                }
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if last_lines.len() >= 12 {
                    last_lines.remove(0);
                }
                last_lines.push(trimmed.to_string());
            }
        };

        let mut cancelled = false;
        let mut timed_out = false;
        let mut stdin_opt = Some(stdin);

        loop {
            if out_eof && err_eof {
                break;
            }
            tokio::select! {
                _ = &mut cancel_rx => {
                    cancelled = true;
                    break;
                }
                _ = &mut deadline => {
                    timed_out = true;
                    break;
                }
                Some(code) = code_rx.recv() => {
                    if let Some(mut s) = stdin_opt.take() {
                        let _ = s.write_all(code.as_bytes()).await;
                        let _ = s.write_all(b"\n").await;
                        let _ = s.flush().await;
                        drop(s);
                    }
                }
                res = out_lines.next_line(), if !out_eof => {
                    match res {
                        Ok(Some(line)) => push_line(line, &status_tx),
                        _ => out_eof = true,
                    }
                }
                res = err_lines.next_line(), if !err_eof => {
                    match res {
                        Ok(Some(line)) => push_line(line, &status_tx),
                        _ => err_eof = true,
                    }
                }
            }
        }

        drop(stdin_opt);
        if cancelled || timed_out {
            let _ = child.kill().await;
        }
        let exit_ok = !cancelled && !timed_out && child.wait().await.is_ok_and(|s| s.success());

        if exit_ok {
            if is_local {
                if detected_email.is_none() {
                    let st = store::login_status(&home_owned, &id_owned);
                    detected_email = st
                        .get("email")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                }
            } else {
                let _ = store::set_remote_login_meta(
                    &home_owned,
                    &id_owned,
                    true,
                    detected_email.as_deref(),
                );
            }
            status_tx.send_modify(|st| {
                st.state = "complete";
                st.email = detected_email.clone();
                st.error = None;
                st.updated_at = Instant::now();
            });
            if let Some(tx) = url_sender.take() {
                let _ = tx.send(Err("账号已处于登录状态".to_string()));
            }
        } else {
            let msg = if cancelled {
                "登录已取消".to_string()
            } else if timed_out {
                "登录等待超时（5 分钟），请重试".to_string()
            } else {
                let tail = last_lines.join(" | ");
                if tail.is_empty() {
                    if is_local {
                        "本机 agy 网页授权登录失败，请确认已安装 agy".to_string()
                    } else {
                        "远端 agy 登录失败，请确认 VPS 已安装 agy 且 SSH 连通正常".to_string()
                    }
                } else {
                    tail
                }
            };
            status_tx.send_modify(|st| {
                st.state = "error";
                st.error = Some(msg.clone());
                st.updated_at = Instant::now();
            });
            if let Some(tx) = url_sender.take() {
                let _ = tx.send(Err(msg));
            }
        }
    });

    match tokio::time::timeout(URL_WAIT_TIMEOUT, url_rx).await {
        Ok(Ok(Ok(oauth_url))) => Ok(json!({
            "ok": true,
            "state": "pending",
            "oauthUrl": oauth_url,
            "accountId": account_id,
        })),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err("登录进程异常退出，未能获取授权链接".to_string()),
        Err(_) => {
            if let Some(old) = sessions_map().lock().await.remove(account_id) {
                if let Some(tx) = old.cancel_tx.lock().await.take() {
                    let _ = tx.send(());
                }
            }
            Err(if is_local {
                "等待 agy 生成 Google 授权链接超时，请确认本机 agy 版本支持 acp --login".to_string()
            } else {
                "等待远端 VPS 生成 Google 授权链接超时，请检查 SSH 连通性与远端 agy 版本"
                    .to_string()
            })
        }
    }
}

/// 为本机（Host）反重力账号启动无浏览器 `agy acp --login` 网页授权（适用于无桌面 Linux VPS
/// 或任何希望用本机浏览器授权的场景）。若该 Host 账号绑定了 `chrome-proxy-launcher` 专用出口，
/// 实时解析代理并注入换票进程（fail-closed）。
pub async fn start_local_login(
    home: &Path,
    account_id: &str,
    account_home: &Path,
    egress_binding: Option<&multicc_core::egress_plugin::EgressBinding>,
) -> Result<Value, StartLocalLoginError> {
    if let Some(old) = sessions_map().lock().await.remove(account_id) {
        if let Some(tx) = old.cancel_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }

    let Some(agy_bin) = crate::app::agy_catalog::detect_local_agy() else {
        return Err(StartLocalLoginError::AgyNotInstalled);
    };

    let proxy_url = if let Some(binding) = egress_binding {
        Some(
            crate::egress_runtime::resolve_egress_proxy_url(binding)
                .await
                .map_err(StartLocalLoginError::Message)?,
        )
    } else {
        None
    };

    let _ = std::fs::remove_file(account_home.join(".gemini").join("oauth_creds.json"));
    let mut cmd = Command::new(&agy_bin);
    cmd.args(["acp", "--login"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("HOME", account_home)
        .env("SSH_CONNECTION", "1 1 1 1")
        .env("DISPLAY", "")
        .env("BROWSER", "/bin/false");

    if let Some(url) = proxy_url.as_deref() {
        let no_proxy = multicc_core::egress_plugin::LOOPBACK_NO_PROXY;
        cmd.env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
            .env("http_proxy", url)
            .env("https_proxy", url)
            .env("all_proxy", url)
            .env("NO_PROXY", no_proxy)
            .env("no_proxy", no_proxy);
    }

    let child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            StartLocalLoginError::AgyNotInstalled
        } else {
            StartLocalLoginError::Message(format!(
                "无法启动本机 agy 网页授权登录（{}）: {err}",
                agy_bin.display()
            ))
        }
    })?;

    drive_login_child(home, account_id, child, true)
        .await
        .map_err(StartLocalLoginError::Message)
}

/// 为传统纯 SSH 远端账号启动一次 SSH `agy acp --login` 授权流程并返回 Google 授权链接。
pub async fn start_login(
    home: &Path,
    account_id: &str,
    target: &RemoteAgyTarget,
) -> Result<Value, String> {
    if let Some(old) = sessions_map().lock().await.remove(account_id) {
        if let Some(tx) = old.cancel_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }

    let agy_bin = target
        .remote_agy_bin
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_AGY_BIN);
    let script = build_remote_login_script(agy_bin, target.remote_home.as_deref(), None);
    let ssh_args = build_ssh_args(target, &script);

    let child = Command::new(ssh_bin())
        .args(&ssh_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("无法启动 SSH 连接进行远端登录: {err}"))?;

    drive_login_child(home, account_id, child, false).await
}

/// 将用户在浏览器拿到的授权码或完整回调 URL 喂给远端等待中的 `agy acp --login`。
pub async fn submit_callback(account_id: &str, raw_callback: &str) -> Result<Value, String> {
    let cleaned = sanitize_oauth_callback(raw_callback)?;
    let session = {
        let map = sessions_map().lock().await;
        map.get(account_id).cloned()
    }
    .ok_or_else(|| "当前没有进行中的登录会话，请先点击「重新获取链接」".to_string())?;

    let mut rx = session.status_rx.clone();
    {
        let current = rx.borrow().clone();
        if current.state != "pending" {
            return Ok(state_to_json(&current));
        }
    }

    let sender = session
        .code_tx
        .lock()
        .await
        .take()
        .ok_or_else(|| "授权回调已提交，正在等待远端完成换票…".to_string())?;
    sender
        .send(cleaned)
        .await
        .map_err(|_| "远端登录会话已关闭，请重新发起登录".to_string())?;

    let _ = tokio::time::timeout(CALLBACK_WAIT_TIMEOUT, async {
        loop {
            if rx.borrow().state != "pending" {
                break;
            }
            if rx.changed().await.is_err() {
                break;
            }
        }
    })
    .await;

    let final_state = rx.borrow().clone();
    if final_state.state == "error" {
        return Err(final_state
            .error
            .unwrap_or_else(|| "远端授权换票失败".to_string()));
    }
    Ok(state_to_json(&final_state))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn remote_login_captures_oauth_url_accepts_callback_and_records_email() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-remote-login-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let local_home = root.join("local-home");
        let fake_remote_home = root.join("vps-home");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&local_home).unwrap();
        std::fs::create_dir_all(&fake_remote_home).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fake_agy = bin_dir.join("fake-agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
echo "Open this link in a browser to log in with Google:"
echo "  https://accounts.google.com/o/oauth2/auth?client_id=test-client&state=abc123&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"
echo "Then paste the authorization code:"
read -r CODE
if [ "$CODE" != "https://antigravity.google/oauth-callback?code=ok-code-999" ]; then
  echo "invalid code: $CODE" >&2
  exit 1
fi
mkdir -p "$HOME/.gemini"
printf '{"active":"vps-user@example.com"}' > "$HOME/.gemini/google_accounts.json"
printf '{"access_token":"tok"}' > "$HOME/.gemini/oauth_creds.json"
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        let fake_ssh = bin_dir.join("fake-ssh");
        // 模拟 sshd：取最后一个参数（远端命令串）交给 `/bin/sh -c` 执行，保持 stdin 原样穿透。
        std::fs::write(
            &fake_ssh,
            format!(
                "#!/bin/sh\nexport HOME='{}'\nfor last; do :; done\nexec /bin/sh -c \"$last\"\n",
                fake_remote_home.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_SSH_BIN", &fake_ssh);

        let created = store::create_remote_account(
            &local_home,
            "VPS测试号",
            &json!({
                "sshTarget": "ubuntu@10.0.0.2",
                "remoteAgyBin": fake_agy.to_string_lossy(),
                "isolateHome": true,
            }),
        )
        .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["remoteLoggedIn"], false);
        assert_eq!(
            created["remote"]["remoteHome"].as_str().unwrap(),
            format!(".multicc-remote/agy-accounts/{id}")
        );

        let (_, target) = store::get_remote_account(&local_home, &id).unwrap();
        let started = start_login(&local_home, &id, &target).await.unwrap();
        assert_eq!(started["state"], "pending");
        assert!(started["oauthUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://accounts.google.com/o/oauth2/auth?"));

        let done = submit_callback(
            &id,
            "https://antigravity.google/oauth-callback?code=ok-code-999",
        )
        .await
        .unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["email"], "vps-user@example.com");

        // Local account listing now reflects loggedIn=true + email + isolated dir on VPS.
        let listed = store::list_accounts(&local_home);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["loggedIn"], true);
        assert_eq!(listed[0]["email"], "vps-user@example.com");
        assert!(fake_remote_home
            .join(format!(
                ".multicc-remote/agy-accounts/{id}/.gemini/oauth_creds.json"
            ))
            .is_file());

        std::env::remove_var("MULTICC_SSH_BIN");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn local_host_login_injects_host_egress_proxy_and_records_email() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-local-login-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&host_home).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fake_agy = bin_dir.join("fake-agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
if [ "$HTTPS_PROXY" != "http://127.0.0.1:29111" ]; then
  echo "missing expected Host HTTPS_PROXY: $HTTPS_PROXY" >&2
  exit 2
fi
echo "Open this link:"
echo "  https://accounts.google.com/o/oauth2/auth?client_id=host-client&state=xyz789"
read -r CODE
if [ "$CODE" != "https://antigravity.google/oauth-callback?code=host-ok" ]; then
  echo "bad code" >&2
  exit 3
fi
mkdir -p "$HOME/.gemini"
printf '{"active":"host-user@example.com"}' > "$HOME/.gemini/google_accounts.json"
printf '{"access_token":"host-tok"}' > "$HOME/.gemini/oauth_creds.json"
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        let created = store::create_account_with_egress(
            &host_home,
            "Host主号",
            "created",
            Some(&json!({ "pluginId": "chrome-proxy-launcher", "profileId": "host-jp" })),
        )
        .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let acct_home = store::account_home(&host_home, &id).unwrap();
        let binding = store::get_account_egress(&host_home, &id);

        std::env::set_var("MULTICC_AGY_BIN", &fake_agy);
        std::env::set_var("MULTICC_EGRESS_PROXY_OVERRIDE", "http://127.0.0.1:29111");

        let started = start_local_login(&host_home, &id, &acct_home, binding.as_ref())
            .await
            .unwrap();
        assert_eq!(started["state"], "pending");
        assert!(started["oauthUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://accounts.google.com/o/oauth2/auth?"));

        let done = submit_callback(
            &id,
            "https://antigravity.google/oauth-callback?code=host-ok",
        )
        .await
        .unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["email"], "host-user@example.com");

        std::env::remove_var("MULTICC_AGY_BIN");
        std::env::remove_var("MULTICC_EGRESS_PROXY_OVERRIDE");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn local_host_login_returns_not_installed_error_when_agy_missing() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-local-login-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        std::fs::create_dir_all(&host_home).unwrap();
        let created =
            store::create_account_with_egress(&host_home, "缺失测试", "created", None).unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let acct_home = store::account_home(&host_home, &id).unwrap();

        let missing = root.join("bin").join("does-not-exist-agy");
        std::env::set_var("MULTICC_AGY_BIN", &missing);

        let err = start_local_login(&host_home, &id, &acct_home, None)
            .await
            .unwrap_err();
        assert_eq!(err, StartLocalLoginError::AgyNotInstalled);
        assert_eq!(
            crate::app::agy_catalog::local_cli_status()["installed"],
            json!(false)
        );

        std::env::remove_var("MULTICC_AGY_BIN");
        let _ = std::fs::remove_dir_all(&root);
    }

    struct EnvVarGuard {
        key: &'static str,
        prev: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, val: impl AsRef<std::ffi::OsStr>) -> Self {
            let prev = std::env::var_os(key);
            std::env::set_var(key, val);
            Self { key, prev }
        }

        fn remove(key: &'static str) -> Self {
            let prev = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, prev }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(val) => std::env::set_var(self.key, val),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[tokio::test]
    async fn local_host_login_finds_agy_in_home_local_bin_under_stripped_path() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-local-login-stripped-path-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let local_bin = host_home.join(".local/bin");
        std::fs::create_dir_all(&local_bin).unwrap();

        let fake_agy = local_bin.join("agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
echo "Open this link:"
echo "  https://accounts.google.com/o/oauth2/auth?client_id=finder-client&state=finder123"
read -r CODE
if [ "$CODE" != "https://antigravity.google/oauth-callback?code=finder-ok" ]; then
  echo "bad code" >&2
  exit 3
fi
mkdir -p "$HOME/.gemini"
printf '{"active":"finder-user@example.com"}' > "$HOME/.gemini/google_accounts.json"
printf '{"access_token":"finder-tok"}' > "$HOME/.gemini/oauth_creds.json"
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        let created = store::create_account(&host_home, "Finder本机号", "created").unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let acct_home = store::account_home(&host_home, &id).unwrap();

        // 模拟 Electron 从 macOS Finder 启动：PATH 不含 ~/.local/bin，且未设置 MULTICC_AGY_BIN/AGY_CMD。
        let _g_bin = EnvVarGuard::remove("MULTICC_AGY_BIN");
        let _g_cmd = EnvVarGuard::remove("AGY_CMD");
        let _g_home = EnvVarGuard::set("HOME", &host_home);
        let _g_path = EnvVarGuard::set("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");

        let started = start_local_login(&host_home, &id, &acct_home, None)
            .await
            .unwrap();
        assert_eq!(started["state"], "pending");
        assert!(started["oauthUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://accounts.google.com/o/oauth2/auth?"));

        let done = submit_callback(
            &id,
            "https://antigravity.google/oauth-callback?code=finder-ok",
        )
        .await
        .unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["email"], "finder-user@example.com");

        let _ = std::fs::remove_dir_all(&root);
    }
}
