//! `multicc-writer` — fail-closed writer-lease launcher for out-of-repo CLIs.
//!
//! Any CLI started outside the host's own spawn paths (documented entrypoints,
//! CI fixtures, the docker task-shell lab) must run under this launcher so the
//! SQLite-backed writer lease is acquired BEFORE the child can write the
//! workspace and released only after the child's whole process group is gone.
//!
//! Contract (all env vars required unless noted):
//!   MULTICC_TASK_STORE   path to the task-shell SQLite database
//!   MULTICC_WRITER_FENCE JSON of the ACTIVE workspace lease identity:
//!                        {"workspaceId","leaseId","epoch","generation","sessionId"}
//!   MULTICC_WRITER_KIND  "session" | "background" | "stream"
//!   MULTICC_WRITER_ID    optional stable writer id (default: random)
//!
//! Exit codes: 64 usage/env, 66 store unreadable, 75 lease refused,
//! 126 child failed to spawn, otherwise the child's own exit status
//! (128+signal when the child dies on a signal). A lease that cannot be
//! released here is reported on stderr and left to the host's dead-pid
//! reaper; the child's exit status still wins.

use multicc_core::task_store::TaskStore;
use serde_json::{json, Value};
use std::process::{Command, ExitCode};

const EX_USAGE: u8 = 64;
const EX_NOINPUT: u8 = 66;
const EX_TEMPFAIL: u8 = 75;
const EX_SPAWN: u8 = 126;

#[cfg(unix)]
static CHILD_PGID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(unix)]
extern "C" fn forward_signal(sig: libc::c_int) {
    let pgid = CHILD_PGID.load(std::sync::atomic::Ordering::SeqCst);
    if pgid > 0 {
        // Async-signal-safe: propagate to the child's whole group so detached
        // grandchildren get the same termination request as the direct child.
        unsafe { libc::kill(-pgid, sig) };
    }
}

#[cfg(unix)]
fn install_signal_forwarding() {
    let handler = forward_signal as *const () as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGHUP, handler);
    }
}

#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    // Conservative: anything but ESRCH means "cannot prove empty" — an EPERM
    // group still exists and may be writing.
    let rc = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn wait_group_empty(pgid: u32) {
    while group_alive(pgid) {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

struct Config {
    store_path: String,
    workspace: String,
    lease_id: String,
    epoch: String,
    generation: u64,
    session: String,
    kind: String,
    writer: String,
    command: Vec<String>,
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("multicc-writer: {message}");
    eprintln!("usage: multicc-writer exec -- <command> [args...]");
    ExitCode::from(EX_USAGE)
}

fn random_writer_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Last-resort uniqueness: time + our own pid. Still valid_fact_id.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        return format!("w{nanos:x}{:x}", std::process::id());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_config() -> Result<Config, ExitCode> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("exec") {
        return Err(usage_error("first argument must be `exec`"));
    }
    let mut command: Vec<String> = args.collect();
    if command.first().is_some_and(|arg| arg == "--") {
        command.remove(0);
    }
    if command.is_empty() {
        return Err(usage_error("no command to run"));
    }
    let store_path = std::env::var("MULTICC_TASK_STORE").unwrap_or_default();
    if store_path.is_empty() {
        return Err(usage_error("MULTICC_TASK_STORE is not set"));
    }
    let fence_raw = std::env::var("MULTICC_WRITER_FENCE").unwrap_or_default();
    let fence: Value = serde_json::from_str(&fence_raw)
        .map_err(|_| usage_error("MULTICC_WRITER_FENCE is not valid JSON"))?;
    let text = |key: &str| -> Result<String, ExitCode> {
        let value = fence[key].as_str().unwrap_or_default().to_owned();
        if value.is_empty() {
            return Err(usage_error(&format!(
                "MULTICC_WRITER_FENCE.{key} is missing"
            )));
        }
        Ok(value)
    };
    let generation = fence["generation"]
        .as_u64()
        .filter(|v| *v > 0)
        .ok_or_else(|| usage_error("MULTICC_WRITER_FENCE.generation is missing"))?;
    let kind = std::env::var("MULTICC_WRITER_KIND").unwrap_or_default();
    if !["session", "background", "stream"].contains(&kind.as_str()) {
        return Err(usage_error(
            "MULTICC_WRITER_KIND must be session|background|stream",
        ));
    }
    let writer = std::env::var("MULTICC_WRITER_ID")
        .ok()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(random_writer_id);
    Ok(Config {
        store_path,
        workspace: text("workspaceId")?,
        lease_id: text("leaseId")?,
        epoch: text("epoch")?,
        generation,
        session: text("sessionId")?,
        kind,
        writer,
        command,
    })
}

impl Config {
    fn lease_input(&self, op: &str) -> Value {
        json!({
            "op": op,
            "workspaceId": self.workspace,
            "writerId": self.writer,
            "writerKind": self.kind,
            "leaseId": self.lease_id,
            "epoch": self.epoch,
            "generation": self.generation,
            "sessionId": self.session,
        })
    }
}

fn run_op(store: &mut TaskStore, input: &Value) -> Result<(), String> {
    store.run(&serde_json::to_string(input).map_err(|e| e.to_string())?)?;
    Ok(())
}

fn main() -> ExitCode {
    let config = match parse_config() {
        Ok(config) => config,
        Err(code) => return code,
    };
    let mut store = match TaskStore::open(&config.store_path) {
        Ok(store) => store,
        Err(error) => {
            eprintln!(
                "multicc-writer: cannot open task store {}: {error}",
                config.store_path
            );
            return ExitCode::from(EX_NOINPUT);
        }
    };
    // Fail closed: the child is never launched unless its writer lease is
    // durably registered first. A stale fence identity refuses here.
    let mut acquire = config.lease_input("writerLeaseAcquire");
    acquire["pid"] = Value::Null;
    if let Err(code) = run_op(&mut store, &acquire) {
        eprintln!(
            "multicc-writer: writer lease refused for workspace {}: {code}",
            config.workspace
        );
        return ExitCode::from(EX_TEMPFAIL);
    }

    let mut command = Command::new(&config.command[0]);
    command.args(&config.command[1..]);
    command.stdin(std::process::Stdio::inherit());
    command.stdout(std::process::Stdio::inherit());
    command.stderr(std::process::Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Group leader: release waits for the whole group, covering background
        // descendants the CLI spawns without telling anyone.
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "multicc-writer: cannot spawn {}: {error}",
                config.command[0]
            );
            let _ = run_op(&mut store, &config.lease_input("writerLeaseRelease"));
            return ExitCode::from(EX_SPAWN);
        }
    };
    let pid = child.id();
    #[cfg(unix)]
    {
        CHILD_PGID.store(pid as i32, std::sync::atomic::Ordering::SeqCst);
        install_signal_forwarding();
    }
    // Crash recovery can only reap a lease whose process is recorded; the pid
    // is annotated once, right after spawn. A lost race with our own release
    // is benign and only reported.
    let mut annotate = config.lease_input("writerLeaseAnnotatePid");
    annotate["pid"] = json!(pid);
    if let Err(code) = run_op(&mut store, &annotate) {
        eprintln!("multicc-writer: writer pid annotation failed: {code}");
    }

    let status = child.wait();
    #[cfg(unix)]
    wait_group_empty(pid);

    let release = config.lease_input("writerLeaseRelease");
    let mut released = false;
    for attempt in 0..3 {
        match run_op(&mut store, &release) {
            Ok(()) => {
                released = true;
                break;
            }
            Err(code) if code == "writer_lease_stale" => {
                // Already released (or superseded) — nothing left to do.
                released = true;
                break;
            }
            Err(code) => {
                eprintln!(
                    "multicc-writer: writer lease release failed (attempt {}): {code}",
                    attempt + 1
                );
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    if !released {
        // The host reaper frees leases whose recorded pid is dead, so this
        // lease expires with us; the child result must not be masked by it.
        eprintln!("multicc-writer: writer lease left for host reaper");
    }

    match status {
        Ok(status) => match status.code() {
            Some(code) => ExitCode::from(code as u8),
            None => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = status.signal() {
                        return ExitCode::from((128 + sig) as u8);
                    }
                }
                ExitCode::from(1)
            }
        },
        Err(error) => {
            eprintln!("multicc-writer: cannot wait for child: {error}");
            ExitCode::from(EX_SPAWN)
        }
    }
}
