//! Audio conversion and bounded VAD history. No host handles or SDK dependency.
pub const RATE: usize = 16_000;
pub const MAX_SAMPLES: usize = RATE * 120;
pub const PAD: usize = RATE * 24 / 100;

#[derive(Default)]
pub struct Pcm16 {
    tail: Option<u8>,
}
impl Pcm16 {
    pub fn clear(&mut self) {
        self.tail = None;
    }
    pub fn push(&mut self, bytes: &[u8]) -> Vec<i16> {
        let mut all = Vec::with_capacity(bytes.len() + 1);
        if let Some(b) = self.tail.take() {
            all.push(b);
        }
        all.extend_from_slice(bytes);
        if all.len() % 2 != 0 {
            self.tail = all.pop();
        }
        all.chunks_exact(2)
            .map(|s| i16::from_le_bytes([s[0], s[1]]))
            .collect()
    }
}
pub fn pcm_float(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.)
        .collect()
}
pub fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|s| f32::from_le_bytes(s.try_into().unwrap()))
        .collect()
}
/// Non-PCM16 or malformed containers retain the ffmpeg fallback.
pub fn wav(bytes: &[u8]) -> Option<(Vec<f32>, u32)> {
    if bytes.len() < 44 || bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut off = 12usize;
    let mut fmt = None;
    let mut data = None;
    while off.checked_add(8)? <= bytes.len() {
        let id = bytes.get(off..off + 4)?;
        let size = u32::from_le_bytes(bytes.get(off + 4..off + 8)?.try_into().ok()?) as usize;
        let body = off + 8;
        if id == b"fmt " {
            let get16 = |i| Some(u16::from_le_bytes(bytes.get(i..i + 2)?.try_into().ok()?));
            let rate = u32::from_le_bytes(bytes.get(body + 4..body + 8)?.try_into().ok()?);
            fmt = Some((get16(body)?, get16(body + 2)?, rate, get16(body + 14)?));
        } else if id == b"data" {
            data = Some(bytes.get(body..body.saturating_add(size).min(bytes.len()))?);
        }
        off = body.checked_add(size)?.checked_add(size % 2)?;
    }
    let (format, channels, rate, bits) = fmt?;
    if format != 1 || bits != 16 || !(1..=2).contains(&channels) {
        return None;
    }
    let samples = pcm_float(data?);
    let mono = if channels == 1 {
        samples
    } else {
        samples
            .chunks_exact(2)
            .map(|s| (s[0] + s[1]) / 2.)
            .collect()
    };
    Some((mono, rate))
}
#[derive(Default)]
pub struct Stream {
    pub closed: bool,
    pub emitted: bool,
    pub pending: Vec<f32>,
    pub chunks: Vec<Vec<f32>>,
    pub len: usize,
}
impl Stream {
    pub fn retain(&mut self, samples: &[f32]) {
        // Preserve the historical whole-frame overshoot; this is not an audio duration cap.
        if self.len < MAX_SAMPLES {
            self.len += samples.len();
            self.chunks.push(samples.to_vec());
        }
    }
    pub fn windows(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let mut all = std::mem::take(&mut self.pending);
        all.extend_from_slice(samples);
        let end = all.len() / 512 * 512;
        self.pending = all[end..].to_vec();
        all[..end].chunks_exact(512).map(<[f32]>::to_vec).collect()
    }
    pub fn slice(&self, begin: usize, end: usize) -> Option<Vec<f32>> {
        let end = end.min(self.len);
        if begin >= end {
            return None;
        }
        let mut out = Vec::with_capacity(end - begin);
        let mut base = 0;
        for c in &self.chunks {
            if base >= end {
                break;
            }
            if base + c.len() > begin {
                out.extend_from_slice(&c[begin.saturating_sub(base)..(end - base).min(c.len())]);
            }
            base += c.len();
        }
        Some(out)
    }
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.len = 0;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn odd_frames_and_signed_samples() {
        let mut p = Pcm16::default();
        assert!(p.push(&[0]).is_empty());
        assert_eq!(p.push(&[128, 255, 127, 7]), vec![-32768, 32767]);
        p.clear();
        assert_eq!(p.push(&[0, 0]), vec![0]);
    }
    #[test]
    fn history_retains_whole_frame_and_windows_keep_tail() {
        let mut s = Stream::default();
        s.len = MAX_SAMPLES - 1;
        s.retain(&[1.; 1024]);
        assert_eq!(s.len, MAX_SAMPLES + 1023);
        s.retain(&[2.]);
        assert_eq!(s.len, MAX_SAMPLES + 1023);
        assert!(s.windows(&[0.; 511]).is_empty());
        assert_eq!(s.windows(&[1.; 2]).len(), 1);
        assert_eq!(s.pending, vec![1.]);
    }
}

/// The old ASCII regex uses ASCII boundaries (underscore is a boundary), one
/// optional literal space between letters, and never normalizes Unicode text.
pub fn vocabulary_term(term: &[u16]) -> bool {
    term.len() >= 3
        && term[0] < 128
        && (term[0] as u8).is_ascii_alphabetic()
        && term.iter().all(|&u| {
            u < 128 && ((u as u8).is_ascii_alphanumeric() || b"_./-".contains(&(u as u8)))
        })
}
pub fn correct_vocab(input: &[u16], terms: &[Vec<u16>]) -> Vec<u16> {
    let boundary = |u: u16| !(u < 128 && (u as u8).is_ascii_alphanumeric());
    let mut current = input.to_vec();
    for term in terms {
        let mut next = Vec::with_capacity(current.len());
        let mut i = 0;
        while i < current.len() {
            let mut end = i;
            let mut matched = i == 0 || boundary(current[i - 1]);
            for (n, &t) in term.iter().enumerate() {
                let Some(&c) = current.get(end) else {
                    matched = false;
                    break;
                };
                if c >= 128 || !(c as u8).eq_ignore_ascii_case(&(t as u8)) {
                    matched = false;
                    break;
                }
                end += 1;
                if n + 1 < term.len() && current.get(end) == Some(&32) {
                    end += 1;
                }
            }
            if matched && (end == current.len() || boundary(current[end])) {
                next.extend_from_slice(term);
                i = end;
            } else {
                next.push(current[i]);
                i += 1;
            }
        }
        current = next;
    }
    current
}

#[cfg(test)]
mod conversion_tests {
    use super::*;
    #[test]
    fn pcm_wav_keeps_rate_and_averages_stereo() {
        let mut h = vec![0u8; 44];
        h[0..4].copy_from_slice(b"RIFF");
        h[8..12].copy_from_slice(b"WAVE");
        h[12..16].copy_from_slice(b"fmt ");
        h[16..20].copy_from_slice(&16u32.to_le_bytes());
        h[20..22].copy_from_slice(&1u16.to_le_bytes());
        h[22..24].copy_from_slice(&2u16.to_le_bytes());
        h[24..28].copy_from_slice(&22050u32.to_le_bytes());
        h[34..36].copy_from_slice(&16u16.to_le_bytes());
        h[36..40].copy_from_slice(b"data");
        h[40..44].copy_from_slice(&4u32.to_le_bytes());
        h.extend_from_slice(&(-32768i16).to_le_bytes());
        h.extend_from_slice(&32767i16.to_le_bytes());
        let (samples, rate) = wav(&h).unwrap();
        assert_eq!(rate, 22050);
        assert_eq!(samples, vec![-1. / 65536.]);
        h[20] = 3;
        assert!(wav(&h).is_none());
        assert!(wav(b"not a wave").is_none());
    }
    #[test]
    fn vocabulary_uses_ascii_boundaries_and_single_internal_spaces() {
        let term: Vec<u16> = "multicc".encode_utf16().collect();
        assert!(vocabulary_term(&term));
        let input: Vec<u16> = "_MULTI CC_ xmulticc multicc2 multi  cc"
            .encode_utf16()
            .collect();
        assert_eq!(
            String::from_utf16(&correct_vocab(&input, &[term])).unwrap(),
            "_multicc_ xmulticc multicc2 multi  cc"
        );
    }
}
