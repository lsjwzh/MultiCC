//! ASCII word boundaries used to veto learned voice aliases in kept text.
//! The host supplies lowercase UTF-16 code units. Underscores and punctuation
//! delimit words under the learner's original [a-z0-9] rule.
pub fn word_character(units: &[u16]) -> bool {
    units
        .iter()
        .any(|&unit| u8::try_from(unit).is_ok_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_and_lowercase_ascii_join_adjacent_aliases() {
        for unit in [b'a', b'z', b'0', b'9'] {
            assert!(word_character(&[u16::from(unit)]));
        }
    }

    #[test]
    fn punctuation_cjk_and_surrogates_delimit_ascii_words() {
        for unit in [0xd800, 0x4e00, 95, 45, 32] {
            assert!(!word_character(&[unit]));
        }
    }
}
