//! The deployed Volcano v3 framing and provider-independent dictation state.
use crate::js::JsString;
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{read::GzDecoder, Compression, GzBuilder};
use std::io::{Read, Write};
#[derive(Default)]
pub struct Browser {
    pub aggregate: JsString,
    pub pcm: super::voice_audio::Pcm16,
}
#[derive(Default)]
pub struct Upstream {
    pub open: bool,
    pub finished: bool,
    pub seq: i32,
}
pub fn base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
pub fn frame(
    kind: u8,
    flags: u8,
    json: bool,
    seq: Option<i32>,
    bytes: &[u8],
) -> std::io::Result<Vec<u8>> {
    let mut gz = GzBuilder::new()
        .mtime(0)
        .operating_system(3)
        .write(Vec::new(), Compression::default());
    gz.write_all(bytes)?;
    let payload = gz.finish()?;
    let mut out = vec![
        0x11,
        kind << 4 | flags,
        (if json { 0x10 } else { 0 }) | 1,
        0,
    ];
    if let Some(seq) = seq {
        out.extend_from_slice(&seq.to_be_bytes());
    }
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}
pub fn response(bytes: &[u8]) -> Option<(u8, i32, Vec<u8>)> {
    let kind = *bytes.get(1)? >> 4;
    let seq = i32::from_be_bytes(bytes.get(4..8)?.try_into().ok()?);
    let size = u32::from_be_bytes(bytes.get(8..12)?.try_into().ok()?) as usize;
    let payload = bytes.get(12..12usize.saturating_add(size).min(bytes.len()))?;
    let mut decoded = Vec::new();
    if bytes.get(2)? & 15 == 1 {
        GzDecoder::new(payload).read_to_end(&mut decoded).ok()?;
    } else {
        decoded.extend_from_slice(payload);
    }
    Some((kind, seq, decoded))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_roundtrip_and_malformed() {
        let b = frame(9, 1, true, Some(-7), br#"{"result":{"text":"hello"}}"#).unwrap();
        let (k, s, v) = response(&b).unwrap();
        assert_eq!((k, s), (9, -7));
        let v: serde_json::Value = serde_json::from_slice(&v).unwrap();
        assert_eq!(v["result"]["text"], "hello");
        for i in 0..12 {
            assert!(response(&b[..i]).is_none());
        }
        assert_eq!(base64(&[0, 1, 2, 255]), "AAEC/w==");
    }
}
