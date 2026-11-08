//! Node Buffer string compatibility, including its base64url low-byte
//! interpretation of UTF-16 input. This is deliberately permissive, not a
//! validator: callers validate the decoded capability separately.
use super::JsString;

/// 共享的 UTF-8 增量解码：截断字节留待下一块，明确非法序列按替换字符处理。
#[derive(Default)]
pub struct Utf8Decoder {
    tail: Vec<u8>,
}

impl Utf8Decoder {
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        let mut joined = std::mem::take(&mut self.tail);
        joined.extend_from_slice(bytes);
        let mut remaining = joined.as_slice();
        let mut output = String::new();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    output.push_str(valid);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&remaining[..valid]).expect("有效前缀"));
                    remaining = &remaining[valid..];
                    match error.error_len() {
                        Some(count) => {
                            output.push('\u{fffd}');
                            remaining = &remaining[count..];
                        }
                        None => {
                            self.tail.extend_from_slice(remaining);
                            break;
                        }
                    }
                }
            }
        }
        output
    }
    pub fn finish(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.tail)).into_owned()
    }
}

pub fn node_base64_decode(text: &JsString) -> Vec<u8> {
    let mut output = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for unit in text.as_units() {
        let byte = *unit as u8;
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_chunk_boundaries_match_whole_stream() {
        for input in [
            "中文🙂尾部".as_bytes(),
            &[0xf0, 0x9f, 0xff, b'a', 0xe4, 0xb8],
            &[0xc0, 0xaf, 0x80],
        ] {
            for size in 1..=input.len() {
                let mut decoder = Utf8Decoder::default();
                let mut output = String::new();
                for chunk in input.chunks(size) {
                    output.push_str(&decoder.feed(chunk));
                }
                output.push_str(&decoder.finish());
                assert_eq!(output, String::from_utf8_lossy(input));
                assert_eq!(decoder.finish(), "");
            }
        }
    }
    #[test]
    fn node_alphabets_padding_and_utf16_low_bytes() {
        for (text, expected) in [
            ("YWJj", vec![97, 98, 99]),
            ("ŁA", vec![0]),
            ("Y😀WJj", vec![]),
            ("AAĀAA", vec![0, 0, 0]),
            ("ＹＷＪｊ", vec![0xf7, 0xb2]),
            ("a=====b", vec![]),
        ] {
            assert_eq!(node_base64_decode(&text.into()), expected);
        }
    }
}
