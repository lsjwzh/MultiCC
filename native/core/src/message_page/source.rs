use super::*;
use crate::chat_history_file::{self as history, LegacyError, Row};
use rusqlite::{Connection, OpenFlags};
use std::io::{BufReader, Read, Seek, SeekFrom};

pub(super) enum Location {
    Transcript {
        file: usize,
        offset: u64,
        len: usize,
    },
    Snapshot {
        id: String,
        index: usize,
    },
}

#[derive(Default)]
pub(super) struct Sources {
    files: Vec<(File, std::fs::Metadata)>,
    snapshots: Option<Connection>,
}

impl Sources {
    /// Keep the same descriptor for indexing and body reads across atomic replacements.
    pub fn scan(
        &mut self,
        path: &Path,
        mut visit: impl FnMut(Location, &str) -> Result<()>,
    ) -> Result<()> {
        let file = match File::open(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            other => other.map_err(err)?,
        };
        let revision = file.metadata().map_err(err)?;
        let slot = self.files.len();
        let mut reader = BufReader::new(&file);
        let mut row = |offset, len, text: &str| {
            let large;
            let text = if len > crate::chat_history_index::MAX_INDEX_RECORD_BYTES as usize {
                large = super::large::project(&file, offset, len)?.to_string();
                &large
            } else {
                text
            };
            visit(
                Location::Transcript {
                    file: slot,
                    offset,
                    len,
                },
                text,
            )
        };
        if history::starts_with_array(&mut reader).map_err(err)? {
            history::scan_legacy_ranges(&mut reader, true, |offset, len, text| {
                if !text.trim_start().starts_with('{') {
                    serde_json::from_str::<serde::de::IgnoredAny>(text)
                        .map_err(|_| LegacyError::Invalid)?;
                    return Ok(());
                }
                row(offset, len, text).map_err(LegacyError::Callback)
            })
            .map_err(|e| format!("legacy transcript: {e:?}"))?;
        } else {
            history::scan_json_line_ranges(
                &mut reader,
                true,
                Some(crate::chat_history_index::MAX_INDEX_RECORD_BYTES),
                true,
                |offset, len, text| {
                    Ok::<_, String>(if row(offset, len, text).is_ok() {
                        Row::Accepted
                    } else {
                        Row::InvalidJson
                    })
                },
            )
            .map_err(|e| format!("transcript: {e:?}"))?;
        }
        self.files.push((file, revision));
        Ok(())
    }

    pub fn unchanged(&self) -> Result<bool> {
        for (file, before) in &self.files {
            let after = file.metadata().map_err(err)?;
            if before.len() != after.len()
                || before.modified().map_err(err)? != after.modified().map_err(err)?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn snapshots(
        &mut self,
        root: &Path,
        ids: &[String],
        mut visit: impl FnMut(Location, Value),
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let db = Connection::open_with_flags(
            root.join("task-shells.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(err)?;
        db.execute_batch("BEGIN DEFERRED").map_err(err)?;
        {
            let mut stmt = db.prepare("SELECT m.key, m.value FROM shell_records s, json_each(s.body, '$.messages') m WHERE s.kind='snapshot' AND s.id=?1").map_err(err)?;
            for id in ids {
                let mut rows = stmt.query([id]).map_err(err)?;
                while let Some(row) = rows.next().map_err(err)? {
                    let raw: String = row.get(1).map_err(err)?;
                    visit(
                        Location::Snapshot {
                            id: id.clone(),
                            index: row.get(0).map_err(err)?,
                        },
                        parse(&raw)?,
                    );
                }
            }
        }
        self.snapshots = Some(db);
        Ok(())
    }

    pub fn large_record(&self, loc: &Location) -> bool {
        matches!(loc, Location::Transcript {len, ..} if *len > crate::chat_history_index::MAX_INDEX_RECORD_BYTES as usize)
    }

    pub fn open_record(&self, loc: &Location, key: &str) -> Result<FullRecord> {
        let Location::Transcript { file, offset, len } = loc else {
            return Err("expected transcript record".into());
        };
        FullRecord::new(
            self.files[*file].0.try_clone().map_err(err)?,
            *offset,
            *len,
            key,
        )
    }

    pub fn read(&mut self, loc: &Location, full: bool) -> Result<Value> {
        match loc {
            Location::Transcript { file, offset, len } => {
                let file = &mut self.files[*file].0;
                if !full && *len > crate::chat_history_index::MAX_INDEX_RECORD_BYTES as usize {
                    return super::large::project(file, *offset, *len);
                }
                file.seek(SeekFrom::Start(*offset)).map_err(err)?;
                let mut bytes = vec![0; *len];
                file.read_exact(&mut bytes).map_err(err)?;
                parse(&String::from_utf8_lossy(&bytes))
            }
            Location::Snapshot { id, index } => {
                let db = self.snapshots.as_ref().ok_or("missing snapshot reader")?;
                let raw: String = db.query_row("SELECT json_extract(body, ?2) FROM shell_records WHERE kind='snapshot' AND id=?1",
                    (id, format!("$.messages[{index}]")), |row| row.get(0)).map_err(err)?;
                parse(&raw)
            }
        }
    }
}
