//! One native issuer for the ids Node used to mint with `crypto.randomUUID()`.
//!
//! Capability tokens, route decisions and attempt ids are issued here, so the
//! owner that admits an attempt is also the owner that names it: no host
//! callback sits between admission and the token it hands out. The shape is
//! the JavaScript one on purpose — a lowercase RFC 4122 v4 id, prefixed with
//! `<prefix>_` — because persisted sessions, proxy capability segments and
//! audit rows already carry ids in that form.
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// `crypto.randomUUID()`: a lowercase RFC 4122 v4 id.
pub fn random_uuid_v4() -> Result<String, getrandom::Error> {
    random_uuid_v4_with(getrandom::fill)
}

fn random_uuid_v4_with(
    fill: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>,
) -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 16];
    // A partially filled buffer is never sufficient: these ids can be
    // capabilities and must remain unpredictable even when the OS fails.
    fill(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(HEX_DIGITS[(byte >> 4) as usize] as char);
        out.push(HEX_DIGITS[(byte & 0x0f) as usize] as char);
    }
    Ok(out)
}

/// `` `${prefix}_${crypto.randomUUID()}` ``: the host's id shape, including the
/// prefix an empty issuer prefix would produce (a bare leading separator).
pub fn prefixed_id(prefix: &str) -> Result<String, getrandom::Error> {
    prefixed_id_with(prefix, getrandom::fill)
}

fn prefixed_id_with(
    prefix: &str,
    fill: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>,
) -> Result<String, getrandom::Error> {
    let uuid = random_uuid_v4_with(fill)?;
    let mut out = String::with_capacity(prefix.len() + 1 + uuid.len());
    out.push_str(prefix);
    out.push('_');
    out.push_str(&uuid);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn is_v4_shape(value: &str) -> bool {
        let bytes = value.as_bytes();
        if bytes.len() != 36 {
            return false;
        }
        for (index, byte) in bytes.iter().enumerate() {
            let expected_dash = matches!(index, 8 | 13 | 18 | 23);
            if expected_dash {
                if *byte != b'-' {
                    return false;
                }
            } else if !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase() {
                return false;
            }
        }
        bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    }

    #[test]
    fn an_issued_uuid_has_the_lowercase_v4_shape_javascript_produces() {
        for _ in 0..256 {
            let value = random_uuid_v4().expect("OS entropy is available");
            assert!(is_v4_shape(&value), "{value}");
        }
    }

    #[test]
    fn issued_uuids_do_not_repeat() {
        let seen: HashSet<String> = (0..512)
            .map(|_| random_uuid_v4().expect("OS entropy is available"))
            .collect();
        assert_eq!(seen.len(), 512);
    }

    #[test]
    fn a_prefixed_id_is_the_host_shape_and_keeps_an_empty_prefix_separator() {
        let value = prefixed_id("proxy-route").expect("OS entropy is available");
        let rest = value
            .strip_prefix("proxy-route_")
            .expect("the prefix is kept verbatim");
        assert!(is_v4_shape(rest), "{value}");
        let empty = prefixed_id("").expect("OS entropy is available");
        assert!(empty.starts_with('_'));
        assert!(is_v4_shape(&empty[1..]), "{empty}");
    }

    #[test]
    fn a_partially_filled_entropy_failure_never_issues_a_capability() {
        let mut calls = 0;
        let result = prefixed_id_with("proxy-route", |bytes| {
            calls += 1;
            bytes[..8].fill(0x42);
            Err(getrandom::Error::UNSUPPORTED)
        });
        assert_eq!(calls, 1);
        assert_eq!(result, Err(getrandom::Error::UNSUPPORTED));
    }

    #[test]
    fn injected_entropy_sets_uuid_bits_without_changing_other_bytes() {
        let result = prefixed_id_with("proxy-route", |bytes| {
            for (index, byte) in bytes.iter_mut().enumerate() {
                *byte = index as u8;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(result, "proxy-route_00010203-0405-4607-8809-0a0b0c0d0e0f");
    }
}
