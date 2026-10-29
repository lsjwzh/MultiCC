//! Full CDP transport for the local Agent gateway. Chrome still has no TCP
//! debugging port; the supervisor alone owns its pipe. The gateway owns lanes
//! and target leases, while this bridge multiplexes its frames with page reads.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const PROTOCOL: &str = "multicc-browser-control-v1";
const MAX_FRAME: usize = 512 << 20;
const MAX_PENDING: usize = 4096;

struct Client {
    stream: UnixStream,
    generation: u64,
    input: Vec<u8>,
    output: VecDeque<Vec<u8>>,
    offset: usize,
    queued: usize,
    sessions: HashSet<String>,
}

pub struct Bridge {
    listener: UnixListener,
    path: PathBuf,
    inode: u64,
    device: u64,
    client: Option<Client>,
    generation: u64,
    // Chrome ids are allocated by Pipe, so internal reads cannot collide.
    pending: HashMap<u64, (u64, Value, bool)>,
    detach: Vec<String>,
    last_register: Instant,
}

impl Bridge {
    pub fn bind(root: &Path, id: &str) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        // A fresh path per browser lifetime prevents stale daemons reconnecting
        // to a new identity instance with old target/session ids.
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
        let digest = format!("{:x}", Sha256::digest([id.as_bytes(), &nonce].concat()));
        let path = crate::read_bridge::unix::socket_path(root, &digest);
        crate::read_bridge::unix::ensure_short_dir(
            path.parent().ok_or("missing control directory")?,
        )?;
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        Ok(Self {
            listener,
            path,
            inode: meta.ino(),
            device: meta.dev(),
            client: None,
            generation: 0,
            pending: HashMap::new(),
            detach: vec![],
            last_register: Instant::now() - Duration::from_secs(10),
        })
    }

    pub fn metadata(&self) -> Value {
        json!({"protocol":PROTOCOL,"wsUrl":format!("pipe://{}", self.path.display())})
    }

    fn disconnect(&mut self) {
        if let Some(client) = self.client.take() {
            self.detach.extend(client.sessions);
        }
        // Only late root-attach replies need cleanup. Ordinary responses from
        // a dead gateway have no recipient and must not exhaust the next one.
        self.pending.retain(|_, (_, _, attach)| *attach);
    }

    /// Nonblocking, bounded work: a stalled client cannot hold the Chrome pipe.
    pub fn requests(&mut self) -> Vec<Value> {
        if let Ok((stream, _)) = self.listener.accept() {
            if self.client.is_none()
                && crate::read_bridge::unix::same_user(&stream)
                && stream.set_nonblocking(true).is_ok()
            {
                self.generation += 1;
                self.client = Some(Client {
                    stream,
                    generation: self.generation,
                    input: vec![],
                    output: VecDeque::new(),
                    offset: 0,
                    queued: 0,
                    sessions: HashSet::new(),
                });
            }
        }
        let mut requests = Vec::new();
        let mut failed = false;
        if let Some(client) = &mut self.client {
            // Flush previously queued replies/events without blocking the actor.
            for _ in 0..64 {
                let Some(front) = client.output.front() else {
                    break;
                };
                match client.stream.write(&front[client.offset..]) {
                    Ok(0) => {
                        failed = true;
                        break;
                    }
                    Ok(n) => {
                        client.offset += n;
                        client.queued -= n;
                        if client.offset == front.len() {
                            client.output.pop_front();
                            client.offset = 0;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            let mut bytes = [0u8; 16384];
            for _ in 0..64 {
                match client.stream.read(&mut bytes) {
                    Ok(0) => {
                        failed = true;
                        break;
                    }
                    Ok(n) => {
                        client.input.extend_from_slice(&bytes[..n]);
                        if client.input.len() > MAX_FRAME {
                            failed = true;
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            let mut consumed = 0;
            for line in client.input.split_inclusive(|b| *b == b'\n').take(64) {
                if line.last() != Some(&b'\n') {
                    break;
                }
                match serde_json::from_slice::<Value>(line) {
                    Ok(v) if v["id"].is_number() && v["method"].is_string() => requests.push(v),
                    _ => {
                        failed = true;
                        break;
                    }
                }
                consumed += line.len();
            }
            client.input.drain(..consumed);
        }
        if failed {
            self.disconnect();
            requests.clear();
        }
        requests
    }

    pub fn track(&mut self, id: u64, request: &Value) -> bool {
        if self.pending.len() >= MAX_PENDING {
            self.disconnect();
            return false;
        }
        if request["method"] == "Target.detachFromTarget" {
            if let Some(session) = request["params"]["sessionId"].as_str() {
                if let Some(client) = &mut self.client {
                    client.sessions.remove(session);
                }
            }
        }
        let Some(client) = &self.client else {
            return false;
        };
        self.pending.insert(
            id,
            (
                client.generation,
                request["id"].clone(),
                request["method"] == "Target.attachToBrowserTarget",
            ),
        );
        true
    }

    /// Returns true for gateway replies; all events are also copied to its
    /// router, which filters browser/target sessions for each caller.
    pub fn route(&mut self, frame: &Value) -> bool {
        let mut outgoing = frame.clone();
        if let Some(id) = frame["id"].as_u64() {
            let Some((generation, original, attach)) = self.pending.remove(&id) else {
                return false;
            };
            let session = attach
                .then(|| frame["result"]["sessionId"].as_str())
                .flatten();
            if let Some(client) = self.client.as_mut().filter(|c| c.generation == generation) {
                if let Some(session) = session {
                    client.sessions.insert(session.to_owned());
                }
            } else {
                if let Some(session) = session {
                    self.detach.push(session.to_owned());
                }
                return true;
            }
            outgoing["id"] = original;
        } else if !frame["method"].is_string() {
            return false;
        }
        if let Some(client) = &mut self.client {
            let bytes = (outgoing.to_string() + "\n").into_bytes();
            if client.queued.saturating_add(bytes.len()) > MAX_FRAME {
                self.disconnect();
            } else {
                client.queued += bytes.len();
                client.output.push_back(bytes);
            }
        }
        frame.get("id").is_some()
    }

    pub fn take_detached(&mut self) -> Vec<String> {
        std::mem::take(&mut self.detach)
    }

    /// Register at startup and after a gateway restart. If MultiCC is not
    /// running, the private endpoint remains available for on-demand attach.
    pub fn register(&mut self) {
        if std::env::var("MULTICC_CDP_GATEWAY").as_deref() == Ok("0") {
            return;
        }
        if self.client.is_some() || self.last_register.elapsed() < Duration::from_secs(5) {
            return;
        }
        self.last_register = Instant::now();
        let path = gateway_socket();
        let Ok(mut stream) = UnixStream::connect(&path) else {
            start_gateway();
            return;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
        let body = json!({"op":"register","wsUrl":self.metadata()["wsUrl"]});
        let _ = writeln!(stream, "{body}");
        // No per-client lane is retained by registration; the gateway's shared
        // upstream actor persists until this browser or the gateway exits.
    }
}

fn start_gateway() {
    // The shipped gateway CLI already supplies single-instance locking,
    // detached lifetime, and a minimal environment for its daemon. Run its
    // short-lived endpoint command once off-thread, never on Chrome's actor.
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if std::env::var("MULTICC_CDP_GATEWAY").as_deref() == Ok("0")
        || STARTED.swap(true, std::sync::atomic::Ordering::Relaxed)
    {
        return;
    }
    let mut candidates = Vec::new();
    if let Some(file) = std::env::var_os("MULTICC_CDP_BIN") {
        candidates.push(PathBuf::from(file));
    }
    if let Some(file) = std::env::var_os("MULTICC_RUST_ADDON") {
        if let Some(dir) = Path::new(&file).parent() {
            candidates.push(dir.join("multicc-cdpd"));
        }
    }
    if let Some(search) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&search).map(|dir| dir.join("multicc-cdpd")));
    }
    if let Some(binary) = candidates.into_iter().find(|p| p.is_file()) {
        std::thread::spawn(move || {
            let _ = std::process::Command::new(binary)
                .args(["endpoint", "--ws", "ws://127.0.0.1:1/unused"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        });
    }
}

fn gateway_socket() -> PathBuf {
    std::env::var_os("MULTICC_CDP_SOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("MULTICC_CDP_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                        .join(".multicc/cdpd")
                })
                .join("cdp.sock")
        })
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path).is_ok_and(|m| {
            m.file_type().is_socket() && m.ino() == self.inode && m.dev() == self.device
        }) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    #[test]
    fn private_transport_rewrites_ids_handles_partial_frames_and_cleans_sessions() {
        let root = std::env::temp_dir().join(format!(
            "control-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let mut bridge = Bridge::bind(&root, "shop").unwrap();
        let path = bridge.path.clone();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut stream = UnixStream::connect(&path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream
            .write_all(b"{\"id\":7,\"method\":\"Target.attachToBrowserTarget\"")
            .unwrap();
        assert!(bridge.requests().is_empty());
        stream.write_all(b"}\n").unwrap();
        let requests = bridge.requests();
        assert_eq!(requests.len(), 1);
        assert!(bridge.track(101, &requests[0]));
        assert!(!bridge.route(&json!({"id":9,"result":{"internal":true}})));
        assert!(bridge.route(&json!({"id":101,"result":{"sessionId":"root"}})));
        bridge.route(
            &json!({"method":"Target.targetCreated","params":{"targetInfo":{"targetId":"t"}}}),
        );
        bridge.requests();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply, json!({"id":7,"result":{"sessionId":"root"}}));
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["method"],
            "Target.targetCreated"
        );
        // A root arriving after disconnect also has to be detached.
        assert!(bridge.track(102, &requests[0]));
        drop(reader);
        drop(stream);
        bridge.requests();
        assert_eq!(bridge.take_detached(), vec!["root"]);
        bridge.route(&json!({"id":102,"result":{"sessionId":"late-root"}}));
        assert_eq!(bridge.take_detached(), vec!["late-root"]);
        let second = Bridge::bind(&root, "shop").unwrap();
        assert_ne!(
            bridge.path, second.path,
            "a relaunch cannot inherit a stale endpoint"
        );
        drop(second);
        drop(bridge);
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
