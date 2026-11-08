//! Node Buffer string compatibility, including its base64url low-byte
//! interpretation of UTF-16 input. This is deliberately permissive, not a
//! validator: callers validate the decoded capability separately.
use super::JsString;

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
