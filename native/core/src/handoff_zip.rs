//! Minimal ZIP writer/reader for the session handoff bundle v3 (.zip transport)
//! and plugin package unpacking.
//!
//! Container structure is written and parsed directly (local file header +
//! central directory + EOCD). Supports method 0 (store) and 8 (raw deflate)
//! only — matching our own writer and stock zip tools for regular files. Zip64,
//! spanning and encryption flags are rejected on read.
//!
//! Security posture: `read_zip` validates every entry name (no absolute paths,
//! no `..` segments, no backslashes/NUL/control chars, length cap), caps entry
//! count and total uncompressed bytes, bounds raw inflate output to prevent zip
//! bombs, and verifies the CRC32 of every inflated entry.

use chrono::{Datelike, Local, Timelike};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use std::{
    collections::HashSet,
    io::{Read, Write},
};

pub const SIG_LOCAL: u32 = 0x0403_4b50;
pub const SIG_CENTRAL: u32 = 0x0201_4b50;
pub const SIG_EOCD: u32 = 0x0605_4b50;
pub const FLAG_UTF8: u16 = 0x0800;
pub const MAX_NAME_BYTES: usize = 240;
pub const DEFAULT_MAX_ENTRIES: usize = 6000;
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_ENTRY_BYTES: usize = 256 * 1024 * 1024; // zip32 field headroom

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZipOptions {
    pub max_entries: usize,
    pub max_total_bytes: usize,
}

impl Default for ZipOptions {
    fn default() -> Self {
        Self {
            max_entries: DEFAULT_MAX_ENTRIES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipInputEntry {
    pub name: String,
    pub data: Vec<u8>,
    pub mode: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipOutputEntry {
    pub name: String,
    pub data: Vec<u8>,
    pub mode: Option<u32>,
}

pub fn crc32(bytes: &[u8]) -> u32 {
    crc32fast::hash(bytes)
}

pub fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && read_u32_le(bytes, 0) == SIG_LOCAL
}

fn read_u16_le(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

fn push_u16_le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32_le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn current_dos_date_time() -> (u16, u16) {
    let now = Local::now();
    dos_date_time_from_parts(
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
    )
}

fn dos_date_time_from_parts(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> (u16, u16) {
    let clamped_year = year.clamp(1980, 2107) as u32;
    let time = (((hour << 11) | (minute << 5) | (second >> 1)) & 0xffff) as u16;
    let date = ((((clamped_year - 1980) << 9) | (month << 5) | day) & 0xffff) as u16;
    (time, date)
}

/// Entry names must be relative, forward-slashed and free of control chars so a
/// restored archive can never escape its destination directory.
pub fn assert_safe_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("zip entry name must be a non-empty string".to_string());
    }
    let bytes = name.len();
    if bytes > MAX_NAME_BYTES {
        let preview: String = name.chars().take(40).collect();
        return Err(format!(
            "zip entry name too long ({bytes}B > {MAX_NAME_BYTES}B): {preview}"
        ));
    }
    if name.contains('\\') || name.contains('\0') {
        return Err(format!("unsafe zip entry name: {name}"));
    }
    if name.bytes().any(|b| b <= 0x1f || b == 0x7f) {
        let escaped = serde_json::to_string(name).unwrap_or_else(|_| format!("{name:?}"));
        return Err(format!("control character in zip entry name: {escaped}"));
    }
    let raw = name.as_bytes();
    if raw[0] == b'/' || (raw.len() >= 2 && raw[0].is_ascii_alphabetic() && raw[1] == b':') {
        return Err(format!("absolute zip entry name: {name}"));
    }
    for part in name.split('/') {
        if part == ".." {
            return Err(format!("path traversal in zip entry name: {name}"));
        }
    }
    Ok(())
}

fn compress_entry(data: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(data)
        .map_err(|e| format!("zip deflate failed: {e}"))?;
    let deflated = encoder
        .finish()
        .map_err(|e| format!("zip deflate failed: {e}"))?;
    // Store when deflate cannot shrink the payload (already-compressed images,
    // tiny buffers) — smaller output and faster inflate.
    if deflated.len() >= data.len() {
        Ok((0, data.to_vec()))
    } else {
        Ok((8, deflated))
    }
}

pub fn create_zip(entries: &[ZipInputEntry], options: ZipOptions) -> Result<Vec<u8>, String> {
    let (time, date) = current_dos_date_time();
    create_zip_with_datetime(entries, options, time, date)
}

fn create_zip_with_datetime(
    entries: &[ZipInputEntry],
    options: ZipOptions,
    time: u16,
    date: u16,
) -> Result<Vec<u8>, String> {
    if entries.is_empty() {
        return Err("createZip requires a non-empty entries array".to_string());
    }
    let max_entries = options.max_entries;
    if entries.len() > max_entries {
        return Err(format!(
            "too many zip entries ({} > {max_entries})",
            entries.len()
        ));
    }
    if entries.len() >= 0xffff {
        return Err("zip64 archives are not supported".to_string());
    }
    let max_total_bytes = options.max_total_bytes;

    let mut out = Vec::new();
    let mut central = Vec::new();
    let mut total_bytes: usize = 0;
    let mut seen: HashSet<&str> = HashSet::with_capacity(entries.len());

    for entry in entries {
        assert_safe_entry_name(&entry.name)?;
        if !seen.insert(entry.name.as_str()) {
            return Err(format!("duplicate zip entry name: {}", entry.name));
        }
        if entry.data.len() > MAX_ENTRY_BYTES {
            return Err(format!(
                "zip entry too large ({}B): {}",
                entry.data.len(),
                entry.name
            ));
        }
        total_bytes = total_bytes
            .checked_add(entry.data.len())
            .ok_or_else(|| "zip total uncompressed size exceeds cap".to_string())?;
        if total_bytes > max_total_bytes {
            return Err(format!(
                "zip total uncompressed size exceeds cap ({total_bytes}B)"
            ));
        }
        let (method, stored) = compress_entry(&entry.data)?;
        let name_bytes = entry.name.as_bytes();
        let name_len = u16::try_from(name_bytes.len())
            .map_err(|_| format!("zip entry name too long: {}", entry.name))?;
        let stored_len = u32::try_from(stored.len())
            .map_err(|_| format!("zip entry too large: {}", entry.name))?;
        let data_len = u32::try_from(entry.data.len())
            .map_err(|_| format!("zip entry too large: {}", entry.name))?;
        let offset =
            u32::try_from(out.len()).map_err(|_| "zip64 archives are not supported".to_string())?;
        if offset == u32::MAX {
            return Err("zip64 archives are not supported".to_string());
        }
        let crc = crc32(&entry.data);

        // Local file header (30 bytes) + filename + stored data
        push_u32_le(&mut out, SIG_LOCAL);
        push_u16_le(&mut out, 20); // version needed
        push_u16_le(&mut out, FLAG_UTF8); // UTF-8 names
        push_u16_le(&mut out, method);
        push_u16_le(&mut out, time);
        push_u16_le(&mut out, date);
        push_u32_le(&mut out, crc);
        push_u32_le(&mut out, stored_len);
        push_u32_le(&mut out, data_len);
        push_u16_le(&mut out, name_len);
        push_u16_le(&mut out, 0); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&stored);

        // Central directory header (46 bytes) + filename
        let (made_by, external_attrs) = match entry.mode {
            Some(unix_mode) => ((3u16 << 8) | 20, (unix_mode as u32) << 16),
            None => (20u16, 0u32),
        };
        push_u32_le(&mut central, SIG_CENTRAL);
        push_u16_le(&mut central, made_by);
        push_u16_le(&mut central, 20); // version needed
        push_u16_le(&mut central, FLAG_UTF8);
        push_u16_le(&mut central, method);
        push_u16_le(&mut central, time);
        push_u16_le(&mut central, date);
        push_u32_le(&mut central, crc);
        push_u32_le(&mut central, stored_len);
        push_u32_le(&mut central, data_len);
        push_u16_le(&mut central, name_len);
        push_u16_le(&mut central, 0); // extra len
        push_u16_le(&mut central, 0); // comment len
        push_u16_le(&mut central, 0); // disk start
        push_u16_le(&mut central, 0); // internal attrs
        push_u32_le(&mut central, external_attrs);
        push_u32_le(&mut central, offset);
        central.extend_from_slice(name_bytes);
    }

    let cd_offset =
        u32::try_from(out.len()).map_err(|_| "zip64 archives are not supported".to_string())?;
    let cd_size =
        u32::try_from(central.len()).map_err(|_| "zip64 archives are not supported".to_string())?;
    if cd_offset == u32::MAX || cd_size == u32::MAX {
        return Err("zip64 archives are not supported".to_string());
    }
    let entry_count = entries.len() as u16;

    out.extend_from_slice(&central);

    // End of central directory record (22 bytes)
    push_u32_le(&mut out, SIG_EOCD);
    push_u16_le(&mut out, 0);
    push_u16_le(&mut out, 0);
    push_u16_le(&mut out, entry_count);
    push_u16_le(&mut out, entry_count);
    push_u32_le(&mut out, cd_size);
    push_u32_le(&mut out, cd_offset);
    push_u16_le(&mut out, 0); // comment len

    Ok(out)
}

pub fn read_zip(buf: &[u8], options: ZipOptions) -> Result<Vec<ZipOutputEntry>, String> {
    if buf.len() < 22 {
        return Err("not a zip archive (too short)".to_string());
    }
    if read_u32_le(buf, 0) != SIG_LOCAL {
        return Err("not a zip archive (missing local header signature)".to_string());
    }
    let max_entries = options.max_entries;
    let max_total_bytes = options.max_total_bytes;

    // Locate EOCD from the tail (a zip comment may follow it, capped at 64KB−1).
    let scan_floor = buf.len().saturating_sub(22 + 0xffff);
    let mut eocd: Option<usize> = None;
    for i in (scan_floor..=buf.len() - 22).rev() {
        if read_u32_le(buf, i) == SIG_EOCD {
            eocd = Some(i);
            break;
        }
    }
    let eocd = eocd.ok_or_else(|| "zip end-of-central-directory not found".to_string())?;

    let entry_count = read_u16_le(buf, eocd + 10);
    if entry_count == 0xffff {
        return Err("zip64 archives are not supported".to_string());
    }
    let cd_size = read_u32_le(buf, eocd + 12);
    let cd_offset = read_u32_le(buf, eocd + 16);
    if cd_size == 0xffff_ffff || cd_offset == 0xffff_ffff {
        return Err("zip64 archives are not supported".to_string());
    }
    if (cd_offset as u64) + (cd_size as u64) > (eocd as u64) {
        return Err("zip central directory overlaps end record (corrupt archive)".to_string());
    }
    if (entry_count as usize) > max_entries {
        return Err(format!(
            "too many zip entries ({entry_count} > {max_entries})"
        ));
    }

    let mut out = Vec::with_capacity(entry_count as usize);
    let mut seen: HashSet<String> = HashSet::with_capacity(entry_count as usize);
    let mut pos = cd_offset as usize;
    let mut total_bytes: usize = 0;

    for _ in 0..entry_count {
        if pos.checked_add(46).is_none_or(|end| end > buf.len())
            || read_u32_le(buf, pos) != SIG_CENTRAL
        {
            return Err("zip central directory truncated or corrupt".to_string());
        }
        let made_by = read_u16_le(buf, pos + 4);
        let method = read_u16_le(buf, pos + 10);
        let crc = read_u32_le(buf, pos + 16);
        let comp_size = read_u32_le(buf, pos + 20);
        let uncomp_size = read_u32_le(buf, pos + 24);
        let name_len = read_u16_le(buf, pos + 28);
        let extra_len = read_u16_le(buf, pos + 30);
        let comment_len = read_u16_le(buf, pos + 32);
        let external_attrs = read_u32_le(buf, pos + 38);
        let local_offset = read_u32_le(buf, pos + 42);

        if comp_size == 0xffff_ffff
            || uncomp_size == 0xffff_ffff
            || local_offset == 0xffff_ffff
            || name_len == 0xffff
        {
            return Err("zip64 archives are not supported".to_string());
        }
        let uncomp_usize = uncomp_size as usize;
        if uncomp_usize > MAX_ENTRY_BYTES {
            return Err(format!("zip entry too large ({uncomp_size}B)"));
        }

        let name_start = pos + 46;
        let name_end = name_start
            .checked_add(name_len as usize)
            .ok_or_else(|| "zip central directory truncated or corrupt".to_string())?;
        if name_end > buf.len() {
            return Err("zip central directory truncated or corrupt".to_string());
        }
        let name = String::from_utf8_lossy(&buf[name_start..name_end]).into_owned();
        assert_safe_entry_name(&name)?;
        if !seen.insert(name.clone()) {
            return Err(format!("duplicate zip entry name: {name}"));
        }

        let next_pos = name_end
            .checked_add(extra_len as usize)
            .and_then(|v| v.checked_add(comment_len as usize))
            .ok_or_else(|| "zip central directory truncated or corrupt".to_string())?;

        // Skip directories (trailing slash entries carry no data).
        if name.ends_with('/') {
            if uncomp_size != 0 {
                return Err(format!("zip directory entry with data: {name}"));
            }
            pos = next_pos;
            continue;
        }

        if method != 0 && method != 8 {
            return Err(format!(
                "unsupported zip compression method {method} for {name}"
            ));
        }

        let local = local_offset as usize;
        if local.checked_add(30).is_none_or(|end| end > buf.len())
            || read_u32_le(buf, local) != SIG_LOCAL
        {
            return Err(format!(
                "zip local header missing for {name} (corrupt archive)"
            ));
        }
        let l_name_len = read_u16_le(buf, local + 26) as usize;
        let l_extra_len = read_u16_le(buf, local + 28) as usize;
        let data_start = local
            .checked_add(30)
            .and_then(|v| v.checked_add(l_name_len))
            .and_then(|v| v.checked_add(l_extra_len))
            .ok_or_else(|| format!("zip entry data truncated: {name}"))?;
        let data_end = data_start
            .checked_add(comp_size as usize)
            .ok_or_else(|| format!("zip entry data truncated: {name}"))?;
        if data_end > buf.len() {
            return Err(format!("zip entry data truncated: {name}"));
        }

        let raw = &buf[data_start..data_end];
        let data = if method == 8 {
            let mut decoder = DeflateDecoder::new(raw);
            let mut inflated = Vec::with_capacity(uncomp_usize.min(64 * 1024));
            // Bound reads to uncomp_size + 1 so a zip bomb cannot OOM the process
            // before the size-mismatch check triggers.
            let limit = (uncomp_size as u64).saturating_add(1);
            (&mut decoder)
                .take(limit)
                .read_to_end(&mut inflated)
                .map_err(|e| format!("zip inflate failed for {name}: {e}"))?;
            inflated
        } else {
            raw.to_vec()
        };

        if data.len() != uncomp_usize {
            return Err(format!(
                "zip size mismatch for {name} (declared {uncomp_size}, got {})",
                data.len()
            ));
        }
        if crc32(&data) != crc {
            return Err(format!(
                "zip CRC mismatch for {name} (corrupt or tampered archive)"
            ));
        }

        total_bytes = total_bytes
            .checked_add(data.len())
            .ok_or_else(|| "zip total uncompressed size exceeds cap".to_string())?;
        if total_bytes > max_total_bytes {
            return Err(format!(
                "zip total uncompressed size exceeds cap ({total_bytes}B)"
            ));
        }

        let mode = if (made_by >> 8) == 3 {
            let m = external_attrs >> 16;
            if m != 0 {
                Some(m)
            } else {
                None
            }
        } else {
            None
        };

        out.push(ZipOutputEntry { name, data, mode });
        pos = next_pos;
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, data: &[u8]) -> ZipInputEntry {
        ZipInputEntry {
            name: name.to_string(),
            data: data.to_vec(),
            mode: None,
        }
    }

    #[test]
    fn crc32_matches_ieee_test_vector() {
        assert_eq!(crc32(b""), 0x0000_0000);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32("世界".as_bytes()), 0xc01e_72eb);
    }

    #[test]
    fn round_trips_text_binary_unicode_empty_and_unix_mode() {
        let entries = vec![
            ZipInputEntry {
                name: "manifest.json".into(),
                data: r#"{"hello":"世界"}"#.as_bytes().to_vec(),
                mode: Some(0o100644),
            },
            ZipInputEntry {
                name: "skills/团队-skill/SKILL.md".into(),
                data: b"---\nname: team\n---\nbody".to_vec(),
                mode: None,
            },
            ZipInputEntry {
                name: "bin/demo".into(),
                data: b"#!/bin/sh\necho ok\n".to_vec(),
                mode: Some(0o100755),
            },
            entry(
                "assets/shot.png",
                &[0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0d],
            ),
            entry("empty.txt", b""),
        ];

        let zip = create_zip(&entries, ZipOptions::default()).expect("create_zip");
        assert!(looks_like_zip(&zip));
        assert!(!looks_like_zip(b"not a zip at all"));
        assert!(!looks_like_zip(b"PK\x03"));

        let back = read_zip(&zip, ZipOptions::default()).expect("read_zip");
        assert_eq!(back.len(), entries.len());
        assert_eq!(back[0].name, "manifest.json");
        assert_eq!(back[0].data, r#"{"hello":"世界"}"#.as_bytes());
        assert_eq!(back[0].mode, Some(0o100644));
        assert_eq!(back[1].name, "skills/团队-skill/SKILL.md");
        assert_eq!(back[1].mode, None);
        assert_eq!(back[2].name, "bin/demo");
        assert_eq!(back[2].mode, Some(0o100755));
        assert_eq!(back[3].data, &[0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0d]);
        assert_eq!(back[4].data.len(), 0);
    }

    #[test]
    fn compresses_repeated_text_and_stores_incompressible_data() {
        let repeated = "lorem ipsum dolor sit amet ".repeat(500);
        let zip = create_zip(
            &[entry("big.txt", repeated.as_bytes())],
            ZipOptions::default(),
        )
        .expect("create");
        assert!(zip.len() < repeated.len());
        assert_eq!(read_u16_le(&zip, 8), 8); // deflate

        // Pseudo-random incompressible bytes (LCG)
        let mut state: u64 = 0x1234_5678_9abc_def0;
        let noise: Vec<u8> = (0..4096)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                (state >> 33) as u8
            })
            .collect();
        let zip2 =
            create_zip(&[entry("noise.bin", &noise)], ZipOptions::default()).expect("create");
        assert_eq!(read_u16_le(&zip2, 8), 0); // stored
        assert!(zip2.len() >= noise.len());
        let back = read_zip(&zip2, ZipOptions::default()).expect("read");
        assert_eq!(back[0].data, noise);
    }

    #[test]
    fn rejects_unsafe_names_duplicates_and_empty_input() {
        assert!(create_zip(&[], ZipOptions::default())
            .unwrap_err()
            .contains("non-empty"));
        assert!(create_zip(&[entry("", b"x")], ZipOptions::default())
            .unwrap_err()
            .contains("non-empty"));
        assert!(
            create_zip(&[entry("../evil.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("traversal")
        );
        assert!(
            create_zip(&[entry("a/../b.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("traversal")
        );
        assert!(
            create_zip(&[entry("/abs.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            create_zip(&[entry("C:abs.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            create_zip(&[entry("a\\b.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("unsafe")
        );
        assert!(
            create_zip(&[entry("a\0b.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("unsafe")
        );
        assert!(
            create_zip(&[entry("a\nb.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("control character")
        );
        assert!(
            create_zip(&[entry("a\x7fb.txt", b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("control character")
        );
        let long_name = "x".repeat(241);
        assert!(
            create_zip(&[entry(&long_name, b"x")], ZipOptions::default())
                .unwrap_err()
                .contains("too long")
        );
        assert!(create_zip(
            &[entry("dup.txt", b"1"), entry("dup.txt", b"2")],
            ZipOptions::default()
        )
        .unwrap_err()
        .contains("duplicate"));
    }

    #[test]
    fn rejects_tampering_truncation_zip64_and_caps() {
        let zip = create_zip(&[entry("a.txt", b"abcdef")], ZipOptions::default()).expect("zip");
        let mut tampered = zip.clone();
        tampered[38] ^= 0xff;
        assert!(read_zip(&tampered, ZipOptions::default())
            .unwrap_err()
            .contains("CRC mismatch"));
        assert!(read_zip(&zip[..zip.len() - 10], ZipOptions::default())
            .unwrap_err()
            .contains("not found"));
        assert!(read_zip(b"short", ZipOptions::default())
            .unwrap_err()
            .contains("too short"));
        assert!(read_zip(&[b'!'; 64], ZipOptions::default())
            .unwrap_err()
            .contains("missing local header signature"));

        // Zip64 sentinel in EOCD entryCount
        let mut zip64 = zip.clone();
        let eocd = zip64.len() - 22;
        zip64[eocd + 10] = 0xff;
        zip64[eocd + 11] = 0xff;
        assert!(read_zip(&zip64, ZipOptions::default())
            .unwrap_err()
            .contains("zip64"));

        // Entry count and total size caps
        let many: Vec<_> = (0..8)
            .map(|i| entry(&format!("f{i}.txt"), &[b'x'; 100]))
            .collect();
        let many_zip = create_zip(&many, ZipOptions::default()).expect("many");
        assert!(read_zip(
            &many_zip,
            ZipOptions {
                max_entries: 4,
                ..ZipOptions::default()
            }
        )
        .unwrap_err()
        .contains("too many zip entries"));
        assert!(create_zip(
            &many,
            ZipOptions {
                max_entries: 4,
                ..ZipOptions::default()
            }
        )
        .unwrap_err()
        .contains("too many zip entries"));

        let big = vec![entry("big.bin", &vec![1u8; 64 * 1024])];
        let big_zip = create_zip(&big, ZipOptions::default()).expect("big");
        assert!(read_zip(
            &big_zip,
            ZipOptions {
                max_total_bytes: 16 * 1024,
                ..ZipOptions::default()
            }
        )
        .unwrap_err()
        .contains("total uncompressed"));
        assert!(create_zip(
            &big,
            ZipOptions {
                max_total_bytes: 16 * 1024,
                ..ZipOptions::default()
            }
        )
        .unwrap_err()
        .contains("total uncompressed"));
    }

    #[test]
    fn skips_empty_directory_entries_and_rejects_nonempty_directories() {
        let zip = create_zip(
            &[entry("dir/", b""), entry("dir/file.txt", b"hello")],
            ZipOptions::default(),
        )
        .expect("zip with dir");
        let back = read_zip(&zip, ZipOptions::default()).expect("read");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "dir/file.txt");
        assert_eq!(back[0].data, b"hello");

        let bad_dir = create_zip(&[entry("dir/", b"oops")], ZipOptions::default()).expect("zip");
        assert!(read_zip(&bad_dir, ZipOptions::default())
            .unwrap_err()
            .contains("zip directory entry with data"));
    }

    #[test]
    fn dos_datetime_clamps_year_bounds() {
        let (t1, d1) = dos_date_time_from_parts(1970, 1, 1, 0, 0, 0);
        assert_eq!(t1, 0);
        assert_eq!(d1, (1 << 5) | 1);
        let (_, d2) = dos_date_time_from_parts(2200, 12, 31, 23, 59, 58);
        assert_eq!(d2, ((2107 - 1980) << 9) | (12 << 5) | 31);
    }
}
