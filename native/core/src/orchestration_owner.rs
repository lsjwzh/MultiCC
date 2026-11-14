//! Framed protocol for an isolated orchestration SQLite owner.
//!
//! This is not yet connected to the production host. A dedicated process keeps
//! foreign SQLite libraries in the caller from invalidating its POSIX locks.
//! Every request runs on the same store and responses preserve request order.

use crate::orchestration_retention::{MaintenanceGuard, RetentionPolicy};
use crate::orchestration_store::Store;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Incremented whenever owner semantics change, even if framing is unchanged.
pub const OWNER_PROTOCOL_VERSION: u32 = 4;
// serde_json's reader parser consumes individual bytes. Small frames are read
// into a strictly bounded buffer to avoid amplifying synchronous RPC latency;
// larger frames remain streaming and never reserve their advertised length.
const BUFFERED_FRAME_LIMIT: u64 = 8 * 1024 * 1024;

// This lease is separate from the shared maintenance lock held by Store.
// Never unlink it: replacing a locked inode would allow two owners to coexist.
struct OwnerLease(File);

impl OwnerLease {
    fn acquire(path: &Path, purpose: &str) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path).map_err(|error| {
            format!("ORCHESTRATION_SQLITE_ERROR:owner lease open failed: {error}")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    format!("ORCHESTRATION_SQLITE_ERROR:owner lease permissions failed: {error}")
                })?;
        }
        FileExt::try_lock_exclusive(&file).map_err(|error| {
            format!("ORCHESTRATION_SQLITE_ERROR:{purpose} lease unavailable: {error}")
        })?;
        Ok(Self(file))
    }
}

impl Drop for OwnerLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    version: u32,
    file: String,
    legacy_file: Option<String>,
    now: i64,
    policy: RetentionPolicy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    input: Value,
    #[serde(default = "first_session")]
    session: u64,
}

fn first_session() -> u64 {
    1
}

#[derive(Serialize)]
struct BorrowedRequest<'a> {
    op: &'a str,
    input: &'a Value,
    session: u64,
}

fn read_value<R: Read>(reader: &mut R, max_bytes: u64) -> io::Result<Option<Value>> {
    let mut header = [0_u8; 8];
    let first = loop {
        match reader.read(&mut header[..1]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => break result?,
        }
    };
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u64::from_be_bytes(header);
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "owner frame exceeds limit",
        ));
    }
    if length <= BUFFERED_FRAME_LIMIT {
        let mut bytes = vec![0; length as usize];
        reader.read_exact(&mut bytes)?;
        let value = decode(serde_json::Deserializer::from_slice(&bytes))?;
        return Ok(Some(value));
    }
    // Parse directly from the bounded stream. A forged length must not cause
    // an allocation proportional to that length before the bytes arrive.
    let mut body = reader.take(length);
    let value = decode(serde_json::Deserializer::from_reader(&mut body))?;
    if body.limit() != 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "incomplete owner frame",
        ));
    }
    Ok(Some(value))
}

fn decode<'de, R: serde_json::de::Read<'de>>(
    mut deserializer: serde_json::Deserializer<R>,
) -> io::Result<Value> {
    deserializer.disable_recursion_limit();
    let value = Value::deserialize(serde_stacker::Deserializer::new(&mut deserializer))
        .map_err(io::Error::other)?;
    deserializer.end().map_err(io::Error::other)?;
    Ok(value)
}

#[derive(Default)]
struct Counter(u64);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "owner frame too large"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn write_value<W: Write, T: Serialize + ?Sized>(
    writer: &mut W,
    value: &T,
    max_bytes: u64,
) -> io::Result<()> {
    // Count first, then stream JSON through a small buffer rather than creating
    // a second complete serialized copy. No total message limit is imposed in
    // production; individual allocation failures retain their ordinary errors.
    let mut counter = Counter::default();
    serde_json::to_writer(&mut counter, value).map_err(io::Error::other)?;
    let length = counter.0;
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "owner frame exceeds limit",
        ));
    }
    writer.write_all(&length.to_be_bytes())?;
    let mut buffered = BufWriter::new(writer);
    serde_json::to_writer(&mut buffered, value).map_err(io::Error::other)?;
    buffered.flush()
}

fn reply<W: Write>(writer: &mut W, result: Result<Value, String>) -> io::Result<()> {
    let envelope = match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    write_value(writer, &envelope, u64::MAX)
}

enum OwnerReply {
    Success(Value),
    Failure(String),
}

fn parse_reply(mut envelope: Value) -> Option<OwnerReply> {
    let fields = envelope.as_object_mut()?;
    match fields.remove("ok")?.as_bool()? {
        true => Some(OwnerReply::Success(fields.remove("value")?)),
        false => Some(OwnerReply::Failure(
            fields.remove("error")?.as_str()?.to_owned(),
        )),
    }
}

/// Client for the experimental owner protocol. Transport errors poison the
/// client: replaying a command after losing its response could double-commit.
pub struct OwnerClient {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    max_bytes: u64,
    failed: bool,
}

impl OwnerClient {
    fn abandon(&mut self) {
        self.failed = true;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn spawn(binary: &Path, open: &Value, max_bytes: u64) -> Result<Self, String> {
        if !binary.is_absolute() {
            return Err("ORCHESTRATION_SQLITE_ERROR:owner executable path must be absolute".into());
        }
        let mut child = Command::new(binary)
            .arg("orchestration-owner")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("ORCHESTRATION_SQLITE_ERROR:owner spawn failed: {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or("ORCHESTRATION_SQLITE_ERROR:owner stdin missing")?;
        let output = child
            .stdout
            .take()
            .ok_or("ORCHESTRATION_SQLITE_ERROR:owner stdout missing")?;
        let mut client = Self {
            child,
            input,
            output: BufReader::new(output),
            max_bytes,
            failed: false,
        };
        client.exchange(open)?;
        Ok(client)
    }

    fn exchange<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<Value, String> {
        if self.failed {
            return Err("ORCHESTRATION_SQLITE_ERROR:owner connection lost".into());
        }
        let transport = (|| -> io::Result<Value> {
            write_value(&mut self.input, value, self.max_bytes)?;
            read_value(&mut self.output, self.max_bytes)?
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "owner exited"))
        })();
        let envelope = match transport {
            Ok(envelope) => envelope,
            Err(error) => {
                self.abandon();
                return Err(format!(
                    "ORCHESTRATION_SQLITE_ERROR:owner transport failed: {error}"
                ));
            }
        };
        match parse_reply(envelope) {
            Some(OwnerReply::Success(value)) => Ok(value),
            Some(OwnerReply::Failure(error)) => Err(error),
            None => {
                self.abandon();
                Err("ORCHESTRATION_SQLITE_ERROR:invalid owner response".into())
            }
        }
    }

    pub fn open_session(&mut self, input: &Value) -> Result<u64, String> {
        let result = self.exchange(&BorrowedRequest {
            op: "openSession",
            input,
            session: 1,
        })?;
        match result.as_u64().filter(|id| *id > 1) {
            Some(id) => Ok(id),
            None => {
                self.abandon();
                Err("ORCHESTRATION_SQLITE_ERROR:invalid owner session".into())
            }
        }
    }

    pub fn is_failed(&self) -> bool {
        self.failed
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub fn abort(&mut self) {
        self.abandon();
    }

    pub fn request_for(&mut self, session: u64, op: &str, input: &Value) -> Result<Value, String> {
        if op == "close" {
            let response = self.exchange(&BorrowedRequest {
                op: "closeSession",
                input,
                session,
            })?;
            let remaining = match response.get("remaining").and_then(Value::as_u64) {
                Some(value) => value,
                None => {
                    self.abandon();
                    return Err("ORCHESTRATION_SQLITE_ERROR:invalid owner close response".into());
                }
            };
            if remaining == 0 {
                self.abandon();
            }
            return Ok(Value::Null);
        }
        self.exchange(&BorrowedRequest { op, input, session })
    }

    pub fn request(&mut self, op: &str, input: &Value) -> Result<Value, String> {
        self.request_for(1, op, input)
    }
}

impl Drop for OwnerClient {
    fn drop(&mut self) {
        // No implicit retry or blocking close. Killing an owner rolls back any
        // uncommitted SQLite transaction and releases its locks.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Serve one connection until explicit close or EOF. EOF drops the store and
/// SQLite rolls back any incomplete transaction. The caller chooses a maximum
/// frame size when this experimental protocol is integrated.
pub fn serve<R: Read, W: Write>(reader: R, mut writer: W, max_bytes: u64) -> io::Result<()> {
    let mut reader = BufReader::new(reader);
    let Some(open) = read_value(&mut reader, max_bytes)? else {
        return Ok(());
    };
    let open: Open = match serde_json::from_value(open) {
        Ok(open) => open,
        Err(_) => return reply(&mut writer, Err("invalid owner open request".into())),
    };
    if open.version != OWNER_PROTOCOL_VERSION {
        return reply(&mut writer, Err("unsupported owner protocol".into()));
    }
    let database = Path::new(&open.file);
    if let Some(parent) = database
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return reply(
                &mut writer,
                Err(format!("ORCHESTRATION_SQLITE_ERROR:{error}")),
            );
        }
    }
    // Serialize initial path resolution and creation within a directory. On a
    // case-insensitive filesystem two spellings of a not-yet-created file
    // can otherwise choose different owner leases before canonicalization.
    let parent = database
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = match std::fs::canonicalize(parent) {
        Ok(parent) => parent,
        Err(error) => {
            return reply(
                &mut writer,
                Err(format!("ORCHESTRATION_SQLITE_ERROR:{error}")),
            )
        }
    };
    let initialization = match OwnerLease::acquire(
        &parent.join(".multicc-orchestration-owner-init.lock"),
        "owner initialization",
    ) {
        Ok(lease) => lease,
        Err(error) => return reply(&mut writer, Err(error)),
    };
    let identity = match MaintenanceGuard::lock_path(database) {
        Ok(identity) => identity,
        Err(error) => {
            return reply(
                &mut writer,
                Err(format!("ORCHESTRATION_SQLITE_ERROR:{error}")),
            )
        }
    };
    let mut lease_path = identity.as_os_str().to_os_string();
    lease_path.push(".owner.lock");
    let _lease = match OwnerLease::acquire(Path::new(&lease_path), "owner") {
        Ok(lease) => lease,
        Err(error) => return reply(&mut writer, Err(error)),
    };
    let store = match Store::open(
        &open.file,
        open.legacy_file.as_deref(),
        open.now,
        open.policy,
    ) {
        Ok(store) => store,
        Err(error) => return reply(&mut writer, Err(error)),
    };
    let opened_identity = MaintenanceGuard::lock_path(database).map_err(io::Error::other)?;
    if opened_identity != identity {
        return reply(
            &mut writer,
            Err("ORCHESTRATION_SQLITE_ERROR:owner database identity changed".into()),
        );
    }
    drop(initialization);
    let mut stores = HashMap::from([(1_u64, store)]);
    let mut next_session = 2_u64;
    reply(&mut writer, Ok(Value::Null))?;
    while let Some(value) = read_value(&mut reader, max_bytes)? {
        let request: Request = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(_) => {
                // A malformed frame cannot be associated with a transaction.
                // Close the connection so an incomplete transaction rolls back.
                return reply(&mut writer, Err("invalid owner request".into()));
            }
        };
        if request.op == "openSession" {
            let result = (|| -> Result<Value, String> {
                let open: Open = serde_json::from_value(request.input).map_err(|_| {
                    "ORCHESTRATION_SQLITE_ERROR:invalid owner open request".to_owned()
                })?;
                if open.version != OWNER_PROTOCOL_VERSION {
                    return Err("ORCHESTRATION_SQLITE_ERROR:unsupported owner protocol".into());
                }
                let other = MaintenanceGuard::lock_path(Path::new(&open.file))
                    .map_err(|error| format!("ORCHESTRATION_SQLITE_ERROR:{error}"))?;
                if other != identity {
                    return Err("ORCHESTRATION_SQLITE_ERROR:owner database mismatch".into());
                }
                let id = next_session;
                next_session = id
                    .checked_add(1)
                    .ok_or("ORCHESTRATION_SQLITE_ERROR:owner sessions exhausted")?;
                let store = Store::open(
                    &open.file,
                    open.legacy_file.as_deref(),
                    open.now,
                    open.policy,
                )?;
                stores.insert(id, store);
                Ok(json!(id))
            })();
            reply(&mut writer, result)?;
            continue;
        }
        if request.op == "closeSession" || request.op == "close" {
            let result = match stores.remove(&request.session) {
                Some(mut store) => {
                    let close_op = if stores.is_empty() {
                        "close"
                    } else {
                        "closeShared"
                    };
                    store.request(close_op, &request.input).map(|_| {
                        if request.op == "closeSession" {
                            json!({"remaining": stores.len()})
                        } else {
                            Value::Null
                        }
                    })
                }
                None => Err("ORCHESTRATION_SQLITE_ERROR:owner session is closed".into()),
            };
            reply(&mut writer, result)?;
            continue;
        }
        let result = match stores.get_mut(&request.session) {
            Some(store) => store.request(&request.op, &request.input),
            None => Err("ORCHESTRATION_SQLITE_ERROR:owner session is closed".into()),
        };
        reply(&mut writer, result)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn encoded(value: Value) -> Vec<u8> {
        let mut result = Vec::new();
        write_value(&mut result, &value, u64::MAX).unwrap();
        result
    }

    #[test]
    fn rejects_oversize_or_torn_frame_without_allocating_it() {
        let mut oversized = Cursor::new(1000_u64.to_be_bytes().to_vec());
        assert_eq!(
            read_value(&mut oversized, 10).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let mut torn = Cursor::new(vec![0, 0, 0]);
        assert_eq!(
            read_value(&mut torn, 10).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn invalid_open_is_reported_and_does_not_read_more() {
        let input = encoded(json!({"version": 99, "file": "ignored", "now": 1, "policy": {}}));
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output, 4096).unwrap();
        let response = read_value(&mut Cursor::new(output), 4096).unwrap().unwrap();
        assert_eq!(
            response,
            json!({"ok": false, "error": "unsupported owner protocol"})
        );
    }

    #[test]
    fn serves_transaction_on_one_connection_and_closes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("multicc-owner-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("orchestration.sqlite");
        let mut input = encoded(
            json!({"version": OWNER_PROTOCOL_VERSION, "file": database, "now": 1, "policy": {}}),
        );
        input.extend(encoded(json!({"op": "begin", "input": {}})));
        input.extend(encoded(json!({"op": "end", "input": {}})));
        input.extend(encoded(json!({"op": "close", "input": {}})));
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output, 1024 * 1024).unwrap();
        let mut output = Cursor::new(output);
        let responses: Vec<Value> = (0..4)
            .map(|_| read_value(&mut output, 1024 * 1024).unwrap().unwrap())
            .collect();
        assert!(responses.iter().all(|response| response["ok"] == true));
        assert_eq!(responses[1]["value"]["revision"], 0);
        assert!(read_value(&mut output, 1024 * 1024).unwrap().is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn streams_large_unicode_payload_without_a_fixed_message_cap() {
        let original = json!({"text": "历史🙂".repeat(1024 * 1024)});
        let mut bytes = Vec::new();
        write_value(&mut bytes, &original, u64::MAX).unwrap();
        let value = read_value(&mut BufReader::new(Cursor::new(bytes)), u64::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(value, original);
    }

    #[test]
    fn accepts_nested_values_supported_by_the_native_bridge() {
        let mut original = Value::Null;
        for _ in 0..200 {
            original = json!([original]);
        }
        let mut bytes = Vec::new();
        write_value(&mut bytes, &original, u64::MAX).unwrap();
        let value = read_value(&mut BufReader::new(Cursor::new(bytes)), u64::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(value, original);
    }

    #[test]
    fn does_not_search_path_for_the_owner_executable() {
        let error = match OwnerClient::spawn(Path::new("multicc-gateway"), &Value::Null, u64::MAX) {
            Ok(_) => panic!("relative executable path must fail"),
            Err(error) => error,
        };
        assert!(error.contains("must be absolute"));
    }

    #[test]
    fn malformed_replies_never_acknowledge_a_command() {
        assert!(parse_reply(json!({"ok": true})).is_none());
        assert!(parse_reply(json!({"ok": false})).is_none());
        assert!(parse_reply(json!({"ok": false, "error": 3})).is_none());
        assert!(matches!(
            parse_reply(json!({"ok": true, "value": null})),
            Some(OwnerReply::Success(Value::Null))
        ));
    }
}
