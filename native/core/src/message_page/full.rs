//! Pin the selected byte range for expansion. Tail rewrites can reuse the same
//! inode, so verify each block against the indexed version before releasing it.
use super::*;
use std::io::{Read, Seek, SeekFrom};

pub const CHUNK: usize = 64 * 1024;

pub enum Body {
    Json(Vec<u8>),
    Record(FullRecord),
}

impl From<Vec<u8>> for Body {
    fn from(value: Vec<u8>) -> Self {
        Body::Json(value)
    }
}

pub struct FullRecord {
    pub prefix: Vec<u8>,
    pub file: File,
    pub digests: Vec<[u8; 32]>,
    pub length: usize,
    pub etag: String,
}

impl FullRecord {
    pub(super) fn new(mut file: File, offset: u64, length: usize, key: &str) -> Result<Self> {
        let prefix = format!(r#"{{"messageKey":{},"message":"#, json!(key)).into_bytes();
        let mut digest = Sha256::new();
        digest.update(&prefix);
        let mut digests = Vec::with_capacity(length.div_ceil(CHUNK));
        let mut buffer = vec![0; CHUNK];
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        for n in (0..length).step_by(CHUNK) {
            let chunk = &mut buffer[..CHUNK.min(length - n)];
            file.read_exact(chunk).map_err(err)?;
            let hash = Sha256::digest(&*chunk);
            digest.update(hash);
            digests.push(hash.into());
        }
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let etag = format!("W/\"{:x}\"", digest.finalize());
        Ok(Self {
            file,
            prefix,
            digests,
            length,
            etag,
        })
    }
    pub fn matches(chunk: &[u8], expected: &[u8; 32]) -> bool {
        Sha256::digest(chunk).as_slice() == expected
    }
}
