//! The owner of a script run bounds both output pipes and reaps the shell on timeout.
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
#[cfg(unix)]
struct ProcessGroup(Option<u32>);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            // The shell owns this group. Dropping the future must reap descendants too.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
const LIMIT: usize = 4 * 1024 * 1024;
async fn output(stream: impl AsyncRead + Unpin, data: &mut Vec<u8>) -> std::io::Result<()> {
    stream.take((LIMIT + 1) as u64).read_to_end(data).await?;
    if data.len() > LIMIT {
        data.truncate(LIMIT);
        return Err(std::io::Error::other("script output exceeds limit"));
    }
    Ok(())
}
pub(super) async fn execute(command: &str, cwd: &Path, timeout: u64) -> (i32, String, bool) {
    #[cfg(unix)]
    let mut shell = {
        let mut c = Command::new("/bin/sh");
        c.process_group(0).args(["-c", command]);
        c
    };
    #[cfg(windows)]
    let mut shell = {
        let mut c = Command::new("cmd.exe");
        c.args(["/D", "/S", "/C", command]);
        c
    };
    let child = shell
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else {
        return (1, String::new(), false);
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    #[cfg(unix)]
    let mut group = ProcessGroup(child.id());
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let result = tokio::time::timeout(Duration::from_millis(timeout), async {
        tokio::try_join!(
            child.wait(),
            output(stdout, &mut out),
            output(stderr, &mut err)
        )
    })
    .await;
    let (code, timed) = match result {
        Ok(Ok((status, (), ()))) => {
            #[cfg(unix)]
            {
                group.0 = None;
            }
            (status.code().unwrap_or(1), false)
        }
        failed => {
            #[cfg(unix)]
            drop(group);
            let _ = child.kill().await;
            (1, failed.is_err())
        }
    };
    let output = [out, err]
        .iter()
        .filter(|b| !b.is_empty())
        .map(|b| String::from_utf8_lossy(b))
        .collect::<Vec<_>>()
        .join("\n");
    (code, output.trim().into(), timed)
}
