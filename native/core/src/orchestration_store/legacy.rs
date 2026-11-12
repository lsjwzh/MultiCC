//! Streaming legacy import/export. At most one domain record is decoded at a time.
use super::{
    corrupt, encode, err, header, meta, private, record, schema, set_meta, table,
    write_record_json, Result, COLLECTIONS,
};
use crate::js::{json_stringify, JsValue};
use rusqlite::Connection;
use serde::de::{DeserializeSeed, Error as _, MapAccess, Visitor};
use serde_json::{json, value::RawValue, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt,
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
fn temp_path(file: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.tmp.{}.{}",
        file.display(),
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ))
}
fn create_private(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(err)
}
fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent).and_then(|f| f.sync_all()).map_err(err)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

struct Import<'a> {
    connection: &'a Connection,
}
impl<'de> DeserializeSeed<'de> for Import<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Import<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("orchestration state object")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<(), M::Error> {
        let mut seen = HashSet::new();
        let mut version = None;
        while let Some(key) = map.next_key::<String>()? {
            seen.insert(key.clone());
            if COLLECTIONS.contains(&key.as_str()) {
                // JSON duplicate keys replace the previous collection, not merge it.
                let (table, _) = table(&key).map_err(M::Error::custom)?;
                self.connection
                    .execute(&format!("DELETE FROM {table}"), [])
                    .map_err(M::Error::custom)?;
                map.next_value_seed(Records {
                    connection: self.connection,
                    collection: &key,
                })?;
            } else {
                let raw: Box<RawValue> = map.next_value()?;
                let value: Value = if matches!(
                    key.as_str(),
                    "schemaVersion" | "revision" | "updatedAt" | "nextOutboxSequence"
                ) {
                    serde_json::from_str(raw.get()).map_err(M::Error::custom)?
                } else {
                    Value::Null
                };
                let name = match key.as_str() {
                    "schemaVersion" => {
                        version = value.as_u64();
                        Some("stateSchemaVersion")
                    }
                    "revision" => Some("revision"),
                    "updatedAt" => Some("updatedAt"),
                    "nextOutboxSequence" => Some("nextOutboxSequence"),
                    _ => None,
                };
                if let Some(name) = name {
                    set_meta(self.connection, name, &value).map_err(M::Error::custom)?;
                } else {
                    write_record_json(self.connection, "extras", &key, raw.get())
                        .map_err(M::Error::custom)?;
                }
            }
        }
        if !matches!(version, Some(1..=3)) {
            return Err(M::Error::custom("unsupported orchestration state schema"));
        }
        for collection in COLLECTIONS {
            let reset = version == Some(1)
                && matches!(collection, "operations" | "tasks" | "sessionSchedules")
                || version == Some(2) && collection == "sessionSchedules";
            if reset {
                let (table, _) = table(collection).map_err(M::Error::custom)?;
                self.connection
                    .execute(&format!("DELETE FROM {table}"), [])
                    .map_err(M::Error::custom)?;
            } else if !seen.contains(collection) {
                return Err(M::Error::custom(format!("missing collection {collection}")));
            }
        }
        if !seen.contains("revision") || !seen.contains("nextOutboxSequence") {
            return Err(M::Error::custom("missing orchestration metadata"));
        }
        set_meta(self.connection, "stateSchemaVersion", &json!(3)).map_err(M::Error::custom)?;
        header(self.connection).map_err(M::Error::custom)?;
        Ok(())
    }
}
struct Records<'a> {
    connection: &'a Connection,
    collection: &'a str,
}
impl<'de> DeserializeSeed<'de> for Records<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Records<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("orchestration collection object")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<(), M::Error> {
        while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
            write_record_json(self.connection, self.collection, &key, value.get())
                .map_err(M::Error::custom)?;
        }
        Ok(())
    }
}

fn sorted_keys(mut keys: Vec<String>) -> Vec<String> {
    // stableValue sorts UTF-16 keys, then JSON.stringify enumerates integer keys first.
    fn index(key: &str) -> Option<u32> {
        let n = key.parse::<u32>().ok()?;
        if n != u32::MAX && n.to_string() == key {
            Some(n)
        } else {
            None
        }
    }
    keys.sort_by(|a, b| match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a.encode_utf16().cmp(b.encode_utf16()),
    });
    keys
}
fn canonical(value: JsValue) -> JsValue {
    match value {
        JsValue::Object(mut entries) => {
            entries.sort_by(|a, b| {
                let index = |key: &crate::js::JsString| {
                    let text = key.to_string_lossy();
                    text.parse::<u32>()
                        .ok()
                        .filter(|n| *n != u32::MAX && n.to_string() == text)
                };
                match (index(&a.0), index(&b.0)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => a.0.as_units().cmp(b.0.as_units()),
                }
            });
            JsValue::Object(
                entries
                    .into_iter()
                    .map(|(key, v)| (key, canonical(v)))
                    .collect(),
            )
        }
        JsValue::Array(values) => JsValue::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}
fn write_record<W: Write>(writer: &mut W, raw: &str) -> Result<()> {
    let canonical = canonical(record::parse(raw)?);
    writer
        .write_all(
            json_stringify(&canonical)
                .ok_or_else(|| corrupt("invalid JSON record"))?
                .as_bytes(),
        )
        .map_err(err)
}
fn write_json<W: Write>(writer: &mut W, value: &Value) -> Result<()> {
    writer.write_all(encode(value)?.as_bytes()).map_err(err)
}
fn record_keys(connection: &Connection, collection: &str) -> Result<Vec<String>> {
    let (table, key) = table(collection)?;
    let mut statement = connection
        .prepare(&format!("SELECT {key} FROM {table}"))
        .map_err(err)?;
    let keys = statement
        .query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<String>, _>>()
        .map_err(err)?;
    Ok(sorted_keys(keys))
}
fn stream<W: Write>(connection: &Connection, writer: &mut W) -> Result<()> {
    let header = header(connection)?;
    let split = super::meta(connection, "databaseSchemaVersion")? == 2;
    let mut root: Vec<String> = header
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .chain(COLLECTIONS.iter().map(|s| (*s).into()))
        .collect();
    root.extend(record_keys(connection, "extras")?);
    root = sorted_keys(root);
    root.dedup();
    writer.write_all(b"{").map_err(err)?;
    for (i, name) in root.iter().enumerate() {
        if i > 0 {
            writer.write_all(b",").map_err(err)?;
        }
        write_json(writer, &json!(name))?;
        writer.write_all(b":").map_err(err)?;
        if COLLECTIONS.contains(&name.as_str()) {
            let (table, key) = table(name)?;
            let source = if split {
                super::receipts::json_source(name, None)?
            } else {
                "data_json".into()
            };
            let mut statement = connection
                .prepare_cached(&format!("SELECT {source} FROM {table} WHERE {key}=?1"))
                .map_err(err)?;
            writer.write_all(b"{").map_err(err)?;
            for (j, key) in record_keys(connection, name)?.iter().enumerate() {
                if j > 0 {
                    writer.write_all(b",").map_err(err)?;
                }
                write_json(writer, &json!(key))?;
                writer.write_all(b":").map_err(err)?;
                let raw: String = statement.query_row([key], |row| row.get(0)).map_err(err)?;
                write_record(writer, &raw)?;
            }
            writer.write_all(b"}").map_err(err)?;
        } else if let Some(value) = header.get(name) {
            write_json(writer, value)?;
        } else {
            let raw: String = connection
                .query_row(
                    "SELECT data_json FROM orchestration_extras WHERE key=?1",
                    [name],
                    |row| row.get(0),
                )
                .map_err(err)?;
            write_record(writer, &raw)?;
        }
    }
    writer.write_all(b"}").map_err(err)?;
    Ok(())
}
struct DigestWriter<W> {
    writer: W,
    digest: Sha256,
}
impl<W: Write> Write for DigestWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let count = self.writer.write(bytes)?;
        self.digest.update(&bytes[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
fn digest(connection: &Connection) -> Result<String> {
    let mut out = DigestWriter {
        writer: std::io::sink(),
        digest: Sha256::new(),
    };
    stream(connection, &mut out)?;
    Ok(format!("{:x}", out.digest.finalize()))
}

pub(super) fn create(file: &Path, legacy: Option<&Path>, now: i64) -> Result<Value> {
    let temp = temp_path(file);
    let result = (|| {
        drop(create_private(&temp)?);
        let connection = Connection::open(&temp).map_err(err)?;
        connection
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
            .map_err(err)?;
        connection.execute_batch(schema::SQL).map_err(err)?;
        connection.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        super::receipts::install(&connection)?;
        for (key, value) in [
            ("databaseSchemaVersion", json!(2)),
            ("stateSchemaVersion", json!(3)),
            ("revision", json!(0)),
            ("updatedAt", json!(0)),
            ("nextOutboxSequence", json!(1)),
        ] {
            set_meta(&connection, key, &value)?;
        }
        let migrated = legacy.is_some_and(Path::exists);
        if let Some(legacy) = legacy.filter(|p| p.exists()) {
            let reader = BufReader::new(File::open(legacy).map_err(err)?);
            let mut de = serde_json::Deserializer::from_reader(reader);
            Import {
                connection: &connection,
            }
            .deserialize(&mut de)
            .map_err(corrupt)?;
            de.end().map_err(corrupt)?;
        }
        super::receipts::finish_import(&connection)?;
        let source_digest = if migrated {
            Some(digest(&connection)?)
        } else {
            None
        };
        if let Some(value) = &source_digest {
            set_meta(&connection, "legacySourceDigest", &json!(value))?;
            set_meta(&connection, "legacyMigratedAt", &json!(now))?;
        }
        connection.execute_batch("COMMIT").map_err(err)?;
        super::validate(&connection)?;
        connection.close().map_err(|(_, e)| err(e))?;
        private(&temp)?;
        // Atomic publish without replacing a database another starter just created.
        match fs::hard_link(&temp, file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                fs::remove_file(&temp).map_err(err)?;
                return Ok(json!({"migrated":false,"legacyDigest":null}));
            }
            Err(error) => return Err(err(error)),
        }
        fs::remove_file(&temp).map_err(err)?;
        sync_parent(file)?;
        Ok(json!({"migrated":migrated,"legacyDigest":source_digest}))
    })();
    if result.is_err() {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", temp.display()));
        }
    }
    result
}
pub(super) fn export(connection: &Connection, target: &Path) -> Result<Value> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let temp = temp_path(target);
    connection.execute_batch("BEGIN").map_err(err)?;
    let result = (|| {
        let revision = meta(connection, "revision")?;
        let file = create_private(&temp)?;
        let mut out = DigestWriter {
            writer: BufWriter::new(file),
            digest: Sha256::new(),
        };
        stream(connection, &mut out)?;
        out.flush().map_err(err)?;
        let digest = format!("{:x}", out.digest.finalize());
        out.writer.write_all(b"\n").map_err(err)?;
        out.writer.flush().map_err(err)?;
        out.writer.get_ref().sync_all().map_err(err)?;
        drop(out.writer);
        connection.execute_batch("COMMIT").map_err(err)?;
        fs::rename(&temp, target).map_err(err)?;
        private(target)?;
        sync_parent(target)?;
        Ok(json!({"file":target.to_string_lossy(),"revision":revision,"digest":digest}))
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
        let _ = fs::remove_file(temp);
    }
    result
}
