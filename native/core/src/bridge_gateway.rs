//! Shared IM gateway text rules. All offsets are ECMAScript UTF-16 units.
use crate::js::{contains_units, is_js_whitespace, js_to_number, JsString, JsValue};

pub const DISPATCH_PATTERN: &str = r#"<<dispatch\s+target="[^"]+"\s*>[\s\S]*?</dispatch>>"#;

fn at(haystack: &[u16], start: usize, needle: &str) -> bool {
    haystack
        .get(start..start + needle.len())
        .is_some_and(|s| s.iter().copied().eq(needle.bytes().map(u16::from)))
}

pub fn strip(text: &JsString) -> JsString {
    let s = text.as_units();
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if at(s, i, "<<dispatch") {
            let mut j = i + 10;
            let space = j;
            while j < s.len() && is_js_whitespace(s[j]) {
                j += 1;
            }
            if j > space && at(s, j, "target=\"") {
                j += 8;
                let target = j;
                while j < s.len() && s[j] != 34 {
                    j += 1;
                }
                if j > target && j < s.len() {
                    j += 1;
                    while j < s.len() && is_js_whitespace(s[j]) {
                        j += 1;
                    }
                    if s.get(j) == Some(&62) {
                        j += 1;
                        while j < s.len() && !at(s, j, "</dispatch>>") {
                            j += 1;
                        }
                        if j < s.len() {
                            i = j + 12;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    let mut collapsed = Vec::with_capacity(out.len());
    let mut newlines = 0;
    for unit in out {
        if unit == 10 {
            newlines += 1;
        } else {
            newlines = 0;
        }
        if newlines <= 2 {
            collapsed.push(unit);
        }
    }
    JsString::from_units(collapsed).trim()
}

pub fn hash(text: &JsString) -> JsString {
    let mut out = Vec::with_capacity(text.len().min(201));
    let mut space = false;
    for &unit in text.as_units() {
        if is_js_whitespace(unit) {
            space = !out.is_empty();
        } else {
            if space {
                out.push(32);
                space = false;
            }
            out.push(unit);
            if out.len() >= 200 {
                break;
            }
        }
    }
    JsString::from_units(out).truncate_units(200)
}

pub fn chunks(text: &JsString, max: f64) -> Vec<JsString> {
    let s = text.as_units();
    let mut start = 0;
    let mut out = Vec::new();
    while (s.len() - start) as f64 > max {
        let limit = (max as usize).min(s.len() - start);
        let cut = s[start..=start + limit]
            .iter()
            .rposition(|&c| c == 10)
            .filter(|&cut| cut > 0)
            .unwrap_or(limit);
        out.push(JsString::from_units(s[start..start + cut].to_vec()));
        start += cut;
    }
    let last = JsString::from_units(s[start..].to_vec());
    if !last.trim().is_empty() {
        out.push(last);
    }
    out
}

#[derive(Default)]
pub struct EchoStore {
    seen: Vec<(JsString, JsValue)>,
}
impl EchoStore {
    pub fn add(&mut self, key: JsString, expiry: JsValue) {
        if key.is_empty() {
            return;
        }
        if let Some(entry) = self.seen.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = expiry;
        } else {
            self.seen.push((key, expiry));
        }
    }
    pub fn sweep(&mut self, now: &JsValue) -> usize {
        self.seen.retain(|(_, expiry)| {
            let expired = match (expiry, now) {
                (JsValue::String(a), JsValue::String(b)) => a < b,
                _ => js_to_number(expiry) < js_to_number(now),
            };
            !expired
        });
        self.seen.len()
    }
    pub fn is_echo(&self, key: &JsString) -> bool {
        key.is_empty()
            || self.seen.iter().any(|(k, _)| {
                k == key
                    || (k.len().min(key.len()) >= 12
                        && (contains_units(k.as_units(), key.as_units())
                            || contains_units(key.as_units(), k.as_units())))
            })
    }
    pub fn len(&self) -> usize {
        self.seen.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_and_utf16_boundaries() {
        let s = JsString::from_rust_str(
            " a<<dispatch\u{feff}target=\"x\">\nsecret</dispatch>>\n\n\nb ",
        );
        assert_eq!(strip(&s), JsString::from_rust_str("a\n\nb"));
        assert_eq!(
            strip(&JsString::from_rust_str(
                "<<dispatch target=\"\">x</dispatch>>"
            )),
            JsString::from_rust_str("<<dispatch target=\"\">x</dispatch>>")
        );
        let s = JsString::from_units(vec![0xd83d, 0xde00, 65]);
        assert_eq!(
            chunks(&s, 1.)
                .iter()
                .map(|s| s.as_units()[0])
                .collect::<Vec<_>>(),
            vec![0xd83d, 0xde00, 65]
        );
        let mut units = vec![65; 199];
        units.extend([0xd83d, 0xde00]);
        assert_eq!(hash(&JsString::from_units(units)).as_units()[199], 0xd83d);
    }
    #[test]
    fn echo_expiry_and_utf16_overlap() {
        let mut e = EchoStore::default();
        let key = JsString::from_rust_str("😀😀😀😀😀😀");
        e.add(key.clone(), JsValue::Number(10.));
        e.sweep(&JsValue::Number(10.));
        let mut longer = key.clone();
        longer.push_str("!");
        assert!(e.is_echo(&longer));
        e.sweep(&JsValue::Number(11.));
        assert!(!e.is_echo(&key));
    }
}
