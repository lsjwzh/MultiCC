//! Build number and ordered source digest used by macOS Agent provisioning.
use crate::js::raw_record::record;
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path};

const SOURCES: [&str; 6] = [
    "MultiCCAgent.swift",
    "LidBrightnessBridge.h",
    "LidBrightnessBridge.m",
    "MultiCCAgentH264.swift",
    "AgentPermissions.swift",
    "MultiCCAgentRemoteInput.swift",
];

pub fn build_number(metadata: &str) -> f64 {
    let number = record(metadata)
        .and_then(|data| data.get("build")?.get().parse::<f64>().ok())
        .unwrap_or_default();
    if number.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&number) {
        number
    } else {
        0.0
    }
}

pub fn shipped_build(directory: &Path) -> f64 {
    fs::read(directory.join("agent-build.json"))
        .map(|bytes| build_number(&String::from_utf8_lossy(&bytes)))
        .unwrap_or_default()
}

pub fn hash_sources<B: AsRef<[u8]>, E>(
    mut read: impl FnMut(&str) -> Result<B, E>,
) -> Result<String, E> {
    let mut hash = Sha256::new();
    for file in SOURCES {
        hash.update(read(file)?.as_ref());
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn shipped_hash(directory: &Path) -> io::Result<String> {
    hash_sources(|file| fs::read(directory.join(file)))
}
