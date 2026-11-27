//! macOS power settings as reported by pmset. Battery guard accepts partial
//! observations (source or percent alone), independently of the telemetry API.
use regex::Regex;
use std::sync::LazyLock;

const SPACE: &str =
    r"[\t-\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
fn setting(key: &str) -> Regex {
    Regex::new(&format!(r"(?m)^{SPACE}*{key}{SPACE}+([0-9]+){SPACE}*$")).unwrap()
}
static SYSTEM: LazyLock<Regex> = LazyLock::new(|| setting("(?i-u:SleepDisabled)"));
static PROFILE: LazyLock<Regex> = LazyLock::new(|| setting("disablesleep"));
static SOURCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i-u:drawing from) '([^']+)'").unwrap());
static PERCENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]+)%;").unwrap());

pub fn sleep_disabled(output: &str) -> bool {
    let output = output.replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let enabled = |v: &str| v.trim_start_matches('0') == "1";
    if let Some(row) = SYSTEM.captures(&output) {
        return enabled(&row[1]);
    }
    let mut rows = PROFILE.captures_iter(&output).peekable();
    rows.peek().is_some() && rows.all(|row| enabled(&row[1]))
}

pub fn battery(output: &str) -> (Option<&'static str>, Option<f64>) {
    let source = SOURCE.captures(output).map(|row| {
        if row[1].to_ascii_lowercase().contains("battery") {
            "battery"
        } else {
            "ac"
        }
    });
    let percent = PERCENT.captures(output).and_then(|row| row[1].parse().ok());
    (source, percent)
}

pub fn install_command(enabled: bool, installer: &str, user: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let (word, value) = if enabled { ("on", 1) } else { ("off", 0) };
    format!("/bin/sh {} install {} && /usr/bin/printf '%s\\n' '{word}' > '/Library/Application Support/multicc/power-intent' && /usr/bin/pmset -a disablesleep {value}", quote(installer), quote(user))
}

pub fn authorization_script(command: &str) -> String {
    format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

pub struct CommandFailure {
    pub code: crate::js::JsValue,
    pub command: String,
    pub message: String,
    pub stderr: String,
}

/// Keep Node execFile's 1 MiB limit per stream; stop the child on overflow or timeout.
pub async fn run_command(file: &str, args: &[String], ms: u64) -> Result<String, CommandFailure> {
    use crate::js::JsValue as V;
    use std::{io, process::Stdio, time::Duration};
    use tokio::{
        io::{AsyncRead, AsyncReadExt},
        process::Command,
        time::timeout,
    };

    const LIMIT: u64 = 1024 * 1024;
    async fn read(pipe: impl AsyncRead + Unpin, buf: &mut Vec<u8>) -> io::Result<()> {
        pipe.take(LIMIT + 1).read_to_end(buf).await?;
        if buf.len() > LIMIT as usize {
            Err(io::Error::other("maxBuffer"))
        } else {
            Ok(())
        }
    }

    let command = format!("{file} {}", args.join(" "));
    let child = Command::new(file)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = child.map_err(|err| {
        let code = crate::node_fs_error::classify(&err).code;
        CommandFailure {
            code: V::from(code),
            command: command.clone(),
            message: format!("spawn {file} {code}"),
            stderr: String::new(),
        }
    })?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    let result = timeout(Duration::from_millis(ms), async {
        tokio::try_join!(child.wait(), read(out, &mut stdout), read(err, &mut stderr))
    })
    .await;
    let overflow = if stdout.len() > LIMIT as usize {
        Some("stdout")
    } else if stderr.len() > LIMIT as usize {
        Some("stderr")
    } else {
        None
    };
    stderr.truncate(LIMIT as usize);
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let mut failure = CommandFailure {
        code: V::Null,
        message: format!("Command failed: {command}\n{stderr}"),
        command,
        stderr,
    };
    match result {
        Ok(Ok((status, (), ()))) if status.success() => {
            Ok(String::from_utf8_lossy(&stdout).into_owned())
        }
        Ok(Ok((status, (), ()))) => {
            failure.code = status.code().map_or(V::Null, |n| V::Number(n.into()));
            Err(failure)
        }
        _ => {
            let _ = child.kill().await;
            if let Some(stream) = overflow {
                failure.code = V::from("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
                failure.message = format!("{stream} maxBuffer length exceeded");
            }
            Err(failure)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn command_status_timeout_and_stream_limit() {
        let run = |command: &str| vec!["-c".to_owned(), command.to_owned()];
        assert_eq!(
            run_command("/bin/sh", &run("printf test"), 2000)
                .await
                .ok()
                .as_deref(),
            Some("test")
        );
        let failed = run_command("/bin/sh", &run("printf denied >&2; exit 7"), 2000)
            .await
            .err()
            .unwrap();
        assert_eq!(failed.stderr, "denied");
        assert!(matches!(failed.code, crate::js::JsValue::Number(7.0)));
        assert!(run_command("/bin/sleep", &["3".into()], 10).await.is_err());
        let overflow = run_command("/usr/bin/yes", &[], 2000).await.err().unwrap();
        assert_eq!(overflow.message, "stdout maxBuffer length exceeded");
    }

    #[test]
    fn status_and_source_are_independent() {
        assert_eq!(battery("garbage\n100%;"), (None, Some(100.)));
        assert_eq!(battery("DRAWING FROM 'External'"), (Some("ac"), None));
        assert!(sleep_disabled(
            "disablesleep 0\u{2028}\u{feff}sLEEPDisabled 0001"
        ));
        assert!(!sleep_disabled("disablesleep 1\rdisablesleep 0"));
    }
}
