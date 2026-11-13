//! Byte positions for JSONL transcripts, without retaining message bodies.
//!
//! The index is a physical snapshot, not a replacement for the history
//! service's normalization, visibility, projection, or mutation rules. It must
//! not be used as a truncated history cache. Reads verify the snapshot before
//! and after fetching the requested bytes; callers must still coordinate file
//! replacement and mutations through their owner before publishing a result.

use crate::js::{is_js_whitespace_char, json_parse, JsValue};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Read, Seek, SeekFrom};

/// A single unusually large record must not make the scanner allocate as much
/// as the whole transcript. Oversized records remain untouched on disk.
pub const MAX_INDEX_RECORD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum IndexError {
    Io(io::Error),
    Empty,
    LegacyArray,
    Corrupt(usize),
    Changed,
    InvalidRange,
    ByteBudget,
}

impl From<io::Error> for IndexError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordPosition {
    pub start: u64,
    pub end: u64,
}

/// Physical facts only; the service must separately prove that normalization
/// did not change any message before using these offsets for a mutation.
#[derive(Debug, PartialEq, Eq)]
pub struct TailLedger {
    pub len: usize,
    pub bytes: u64,
    pub ends: Vec<u64>,
}

#[derive(Debug)]
pub struct HistoryIndex {
    records: Vec<RecordPosition>,
    bytes: u64,
    digest: [u8; 32],
    canonical_lines: bool,
}

impl HistoryIndex {
    /// Parses exactly one record at a time. The final damaged, unterminated
    /// record is ignored only when at least one prior record was valid.
    pub fn build(reader: &mut impl BufRead) -> Result<Self, IndexError> {
        let mut positions = Vec::new();
        let mut digest = Sha256::new();
        let mut line = Vec::new();
        let mut offset = 0_u64;
        let mut line_number = 0;
        let mut started = false;
        let mut canonical_lines = true;
        loop {
            line.clear();
            let len = (&mut *reader)
                .take(MAX_INDEX_RECORD_BYTES + 1)
                .read_until(b'\n', &mut line)?;
            if len == 0 {
                break;
            }
            if len as u64 > MAX_INDEX_RECORD_BYTES {
                return Err(IndexError::ByteBudget);
            }
            line_number += 1;
            digest.update(&line);
            let start = offset;
            offset = offset
                .checked_add(len as u64)
                .ok_or(IndexError::InvalidRange)?;
            let complete = line.last() == Some(&b'\n');
            let body = if complete {
                &line[..line.len() - 1]
            } else {
                &line[..]
            };
            let body = String::from_utf8_lossy(body);
            let body = if line_number == 1 {
                if body.starts_with('\u{feff}') {
                    canonical_lines = false;
                }
                body.strip_prefix('\u{feff}').unwrap_or(&body)
            } else {
                &body
            };
            let first = body.chars().find(|ch| !is_js_whitespace_char(*ch));
            if !started {
                if let Some(ch) = first {
                    started = true;
                    if ch == '[' {
                        return Err(IndexError::LegacyArray);
                    }
                }
            }
            if first.is_none() {
                canonical_lines = false;
                continue;
            }
            let parsed = json_parse(body);
            if !matches!(parsed, Ok(JsValue::Object(_))) {
                if !complete && !positions.is_empty() {
                    canonical_lines = false;
                    break;
                }
                return Err(IndexError::Corrupt(line_number));
            }
            if !complete {
                canonical_lines = false;
            }
            positions.push(RecordPosition { start, end: offset });
        }
        if !started {
            return Err(IndexError::Empty);
        }
        Ok(Self {
            records: positions,
            bytes: offset,
            digest: digest.finalize().into(),
            canonical_lines,
        })
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn position(&self, index: usize) -> Option<RecordPosition> {
        self.records.get(index).copied()
    }

    pub fn tail_ledger(
        &self,
        file: &mut (impl Read + Seek),
        max_ends: usize,
    ) -> Result<Option<TailLedger>, IndexError> {
        if !self.canonical_lines {
            return Ok(None);
        }
        self.verify(file)?;
        let start = self.records.len().saturating_sub(max_ends);
        Ok(Some(TailLedger {
            len: self.records.len(),
            bytes: self.bytes,
            ends: self.records[start..]
                .iter()
                .map(|position| position.end)
                .collect(),
        }))
    }

    pub fn verify(&self, file: &mut (impl Read + Seek)) -> Result<(), IndexError> {
        file.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut buf = [0_u8; 64 * 1024];
        let mut bytes = 0_u64;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            bytes = bytes.checked_add(n as u64).ok_or(IndexError::Changed)?;
            digest.update(&buf[..n]);
        }
        let actual: [u8; 32] = digest.finalize().into();
        if bytes != self.bytes || actual != self.digest {
            return Err(IndexError::Changed);
        }
        Ok(())
    }

    /// Fetches original JSONL bytes for a bounded range, never editing the file.
    /// The full-file hashes are deliberately conservative until all writers
    /// participate in a common version protocol.
    pub fn read_range(
        &self,
        file: &mut (impl Read + Seek),
        start: usize,
        end: usize,
        byte_budget: u64,
    ) -> Result<Vec<Vec<u8>>, IndexError> {
        let records = self
            .records
            .get(start..end)
            .ok_or(IndexError::InvalidRange)?;
        let mut total = 0_u64;
        for record in records {
            total = total
                .checked_add(record.end - record.start)
                .ok_or(IndexError::ByteBudget)?;
            if total > byte_budget {
                return Err(IndexError::ByteBudget);
            }
        }
        self.verify(file)?;
        let mut out = Vec::with_capacity(records.len());
        for record in records {
            let len =
                usize::try_from(record.end - record.start).map_err(|_| IndexError::ByteBudget)?;
            file.seek(SeekFrom::Start(record.start))?;
            let mut bytes = vec![0; len];
            file.read_exact(&mut bytes)?;
            out.push(bytes);
        }
        self.verify(file)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    struct ChangedDuringRead {
        file: Cursor<Vec<u8>>,
        checks: usize,
    }

    impl Read for ChangedDuringRead {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.file.read(buf)
        }
    }

    impl Seek for ChangedDuringRead {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            if position == SeekFrom::Start(0) {
                self.checks += 1;
                if self.checks == 2 {
                    self.file.get_mut()[6] = b'9';
                }
            }
            self.file.seek(position)
        }
    }

    #[test]
    fn indexes_exact_utf8_offsets_and_ignores_only_torn_tail() {
        let body = "\u{feff} \n{\"id\":\"一\",\"text\":\"原文😀\"}\r\n\n{\"id\":\"二\"}\n{\"bad\":"
            .as_bytes();
        let index = HistoryIndex::build(&mut BufReader::new(Cursor::new(body))).unwrap();
        assert_eq!(index.len(), 2);
        assert!(index
            .tail_ledger(&mut Cursor::new(body), 64)
            .unwrap()
            .is_none());
        let mut file = Cursor::new(body);
        let page = index.read_range(&mut file, 0, 2, 1000).unwrap();
        assert_eq!(
            page[0],
            "{\"id\":\"一\",\"text\":\"原文😀\"}\r\n".as_bytes()
        );
        assert_eq!(page[1], "{\"id\":\"二\"}\n".as_bytes());
        assert_eq!(body, file.into_inner());
    }

    #[test]
    fn rejects_changed_files_and_oversized_pages() {
        let body = b"{\"id\":1}\n{\"id\":2}\n";
        let index = HistoryIndex::build(&mut BufReader::new(Cursor::new(body))).unwrap();
        assert_eq!(
            index.tail_ledger(&mut Cursor::new(body), 1).unwrap(),
            Some(TailLedger {
                len: 2,
                bytes: body.len() as u64,
                ends: vec![body.len() as u64]
            })
        );
        assert!(matches!(
            index.read_range(&mut Cursor::new(body), 0, 2, 2),
            Err(IndexError::ByteBudget)
        ));
        assert!(matches!(
            index.read_range(&mut Cursor::new(body), 2, 1, 100),
            Err(IndexError::InvalidRange)
        ));
        let changed = b"{\"id\":1}\n{\"id\":3}\n";
        assert!(matches!(
            index.read_range(&mut Cursor::new(changed), 0, 1, 100),
            Err(IndexError::Changed)
        ));
        assert!(matches!(
            index.tail_ledger(&mut Cursor::new(changed), 64),
            Err(IndexError::Changed)
        ));
    }

    #[test]
    fn preserves_strict_corruption_and_legacy_boundaries() {
        let build = |body: &[u8]| HistoryIndex::build(&mut BufReader::new(Cursor::new(body)));
        assert!(matches!(build(b" \n"), Err(IndexError::Empty)));
        assert!(matches!(build(b" []"), Err(IndexError::LegacyArray)));
        assert!(matches!(
            build(b"{}\ninvalid\n"),
            Err(IndexError::Corrupt(2))
        ));
        assert!(matches!(build(b"invalid"), Err(IndexError::Corrupt(1))));
        assert_eq!(build(b"{}\ninvalid").unwrap().len(), 1);
        assert_eq!(build(b"{}\n{\"id\":1}").unwrap().len(), 2);
        let partial = b"{}\n{\"id\":1}";
        assert!(build(partial)
            .unwrap()
            .tail_ledger(&mut Cursor::new(partial), 64)
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_changes_between_fetch_and_final_verification() {
        let body = b"{\"id\":1}\n{\"id\":2}\n";
        let index = HistoryIndex::build(&mut BufReader::new(Cursor::new(body))).unwrap();
        let mut file = ChangedDuringRead {
            file: Cursor::new(body.to_vec()),
            checks: 0,
        };
        assert!(matches!(
            index.read_range(&mut file, 1, 2, 100),
            Err(IndexError::Changed)
        ));
    }

    #[test]
    fn rejects_an_oversized_record_without_reading_the_remainder() {
        let source = std::io::repeat(b'x').take(MAX_INDEX_RECORD_BYTES * 2);
        let mut reader = BufReader::new(source);
        assert!(matches!(
            HistoryIndex::build(&mut reader),
            Err(IndexError::ByteBudget)
        ));
        assert_eq!(reader.fill_buf().unwrap().first(), Some(&b'x'));
    }
}
