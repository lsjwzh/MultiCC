//! Bookkeeping for the turn event replay layer (`deriveToolTiming`,
//! `diffToolTiming`, `deriveOpenTasks`): insertion-ordered SameValueZero maps
//! and the Number/BigInt comparisons behind `Math.abs(blob - derived) >
//! toleranceMs`. Property reads, getters and coercions stay with the host
//! engine in the addon module; this module owns what is pure.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::js::JsString;

/// A Map/Set key under SameValueZero: `-0` and `+0` share a key, as do all
/// NaNs and `0n`/`-0n`; symbols and objects are an identity index the host
/// reader assigns.
#[derive(Clone, Debug)]
pub enum ScalarKey {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    BigInt { negative: bool, words: Vec<u64> },
    Identity(usize),
}

impl ScalarKey {
    pub fn number(value: f64) -> Self {
        Self::Number(if value == 0.0 { 0.0 } else { value })
    }

    /// Little-endian magnitude words; zero is never negative.
    pub fn bigint(negative: bool, words: Vec<u64>) -> Self {
        let mut words = words;
        while words.last() == Some(&0) {
            words.pop();
        }
        Self::BigInt {
            negative: negative && !words.is_empty(),
            words,
        }
    }
}

impl PartialEq for ScalarKey {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Number(a), Self::Number(b)) => (a.is_nan() && b.is_nan()) || a == b,
            (
                Self::BigInt {
                    negative: a,
                    words: aw,
                },
                Self::BigInt {
                    negative: b,
                    words: bw,
                },
            ) => a == b && aw == bw,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Identity(a), Self::Identity(b)) => a == b,
            (Self::Undefined, Self::Undefined) | (Self::Null, Self::Null) => true,
            _ => false,
        }
    }
}

impl Eq for ScalarKey {}

impl Hash for ScalarKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self {
            Self::Undefined => state.write_u8(0),
            Self::Null => state.write_u8(1),
            Self::Bool(value) => {
                state.write_u8(2);
                value.hash(state);
            }
            Self::Number(value) => {
                state.write_u8(3);
                if value.is_nan() {
                    u64::MAX.hash(state);
                } else {
                    value.to_bits().hash(state);
                }
            }
            Self::String(value) => {
                state.write_u8(4);
                value.hash(state);
            }
            Self::BigInt { negative, words } => {
                state.write_u8(5);
                negative.hash(state);
                words.hash(state);
            }
            Self::Identity(index) => {
                state.write_u8(6);
                index.hash(state);
            }
        }
    }
}

/// A JavaScript `Map`: iteration follows first insertion, a later `set` on an
/// existing key replaces the value in place and keeps the original key, and a
/// key deleted then set again iterates at the end.
pub struct OrderedMap<V> {
    entries: Vec<(ScalarKey, Option<V>)>,
    index: HashMap<ScalarKey, usize>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has(&self, key: &ScalarKey) -> bool {
        self.index.contains_key(key)
    }

    pub fn get(&self, key: &ScalarKey) -> Option<&V> {
        self.index
            .get(key)
            .and_then(|position| self.entries[*position].1.as_ref())
    }

    pub fn get_mut(&mut self, key: &ScalarKey) -> Option<&mut V> {
        match self.index.get(key) {
            Some(&position) => self.entries[position].1.as_mut(),
            None => None,
        }
    }

    pub fn insert(&mut self, key: ScalarKey, value: V) {
        match self.index.get(&key) {
            Some(&position) => self.entries[position].1 = Some(value),
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, Some(value)));
            }
        }
    }

    pub fn remove(&mut self, key: &ScalarKey) -> bool {
        match self.index.remove(key) {
            Some(position) => {
                self.entries[position].1 = None;
                true
            }
            None => false,
        }
    }

    /// Live entries in iteration order.
    pub fn iter(&self) -> impl Iterator<Item = (&ScalarKey, &V)> {
        self.entries
            .iter()
            .filter_map(|(key, value)| value.as_ref().map(|value| (key, value)))
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }
}

/// A JavaScript `Set` over [`ScalarKey`], built on the same ordering rules.
#[derive(Default)]
pub struct OrderedSet {
    map: OrderedMap<()>,
}

impl OrderedSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, key: ScalarKey) {
        self.map.insert(key, ());
    }

    pub fn has(&self, key: &ScalarKey) -> bool {
        self.map.has(key)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// The result of ToNumeric: a Number or a BigInt (little-endian magnitude).
#[derive(Clone, Debug, PartialEq)]
pub enum Numeric {
    Number(f64),
    BigInt { negative: bool, words: Vec<u64> },
}

/// The value of `left - right` once both operands went through ToNumeric.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Difference {
    Number(f64),
    BigInt,
}

/// `left - right` on ToNumeric'd operands: both coercions already happened,
/// mixed Number/BigInt operands throw instead of producing a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MixedBigInt;

pub fn subtract(left: &Numeric, right: &Numeric) -> Result<Difference, MixedBigInt> {
    match (left, right) {
        (Numeric::Number(a), Numeric::Number(b)) => Ok(Difference::Number(a - b)),
        (Numeric::BigInt { .. }, Numeric::BigInt { .. }) => Ok(Difference::BigInt),
        _ => Err(MixedBigInt),
    }
}

/// `Math.abs` on a BigInt throws instead of converting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BigIntToNumber;

/// `Math.abs(difference)`: the subtraction result is only ever consumed here,
/// so a BigInt difference needs no arithmetic, only its type.
pub fn math_abs(difference: Difference) -> Result<f64, BigIntToNumber> {
    match difference {
        Difference::Number(value) => Ok(value.abs()),
        Difference::BigInt => Err(BigIntToNumber),
    }
}

/// `left < right` on the ToNumeric'd operands of a relational comparison
/// (`Math.abs(a - b) > toleranceMs` is `tolerance < abs`). NaN on either side
/// is false; a Number against a BigInt compares the exact mathematical values.
pub fn is_less_than(left: &Numeric, right: &Numeric) -> bool {
    match (left, right) {
        (Numeric::Number(a), Numeric::Number(b)) => a < b,
        (
            Numeric::BigInt {
                negative: left_negative,
                words: left_words,
            },
            Numeric::BigInt {
                negative: right_negative,
                words: right_words,
            },
        ) => {
            let ordering = if left_negative == right_negative {
                let magnitude = compare_words(left_words, right_words);
                if *left_negative {
                    magnitude.reverse()
                } else {
                    magnitude
                }
            } else if *left_negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
            ordering == Ordering::Less
        }
        (Numeric::BigInt { negative, words }, Numeric::Number(b)) => {
            !b.is_nan() && bigint_cmp_f64(words, *negative, *b) == Ordering::Less
        }
        (Numeric::Number(a), Numeric::BigInt { negative, words }) => {
            !a.is_nan() && bigint_cmp_f64(words, *negative, *a) == Ordering::Greater
        }
    }
}

/// Compare a BigInt with a finite, non-NaN Number by exact value.
pub fn bigint_cmp_f64(words: &[u64], negative: bool, y: f64) -> Ordering {
    let (y_negative, mantissa, exponent) = decompose(y);
    let x_zero = words.iter().all(|word| *word == 0);
    if mantissa == 0 || x_zero {
        return match (x_zero, mantissa == 0) {
            (true, true) => Ordering::Equal,
            (true, false) => {
                if y_negative {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            _ => {
                if negative {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
        };
    }
    if negative != y_negative {
        return if negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let magnitude = compare_magnitude(words, mantissa, exponent);
    if negative {
        magnitude.reverse()
    } else {
        magnitude
    }
}

/// `|y| = mantissa * 2^exponent` with an integer mantissa (subnormals
/// included: `5e-324` is `1 * 2^-1074`).
fn decompose(y: f64) -> (bool, u64, i32) {
    let bits = y.to_bits();
    let negative = bits >> 63 != 0;
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    if biased == 0 {
        (negative, fraction, -1074)
    } else {
        (negative, fraction | (1u64 << 52), biased - 1075)
    }
}

fn compare_magnitude(words: &[u64], mantissa: u64, exponent: i32) -> Ordering {
    // Same binary order of magnitude first: floor(log2|x|) vs floor(log2|y|).
    let x_order = bit_len(words) as i64 - 1;
    let y_order = bit_len_u64(mantissa) as i64 - 1 + exponent as i64;
    if x_order != y_order {
        return x_order.cmp(&y_order);
    }
    // Align to a common scale: x * 2^(-e) against m when e < 0, else x
    // against m * 2^e.
    let (left_shift, right_shift) = if exponent >= 0 {
        (0, exponent as u32)
    } else {
        ((-exponent) as u32, 0)
    };
    compare_words(
        &shift_left(words, left_shift),
        &shift_left(&[mantissa], right_shift),
    )
}

fn bit_len(words: &[u64]) -> usize {
    match words.iter().rposition(|word| *word != 0) {
        Some(position) => position * 64 + bit_len_u64(words[position]) as usize,
        None => 0,
    }
}

fn bit_len_u64(word: u64) -> u32 {
    64 - word.leading_zeros()
}

fn shift_left(words: &[u64], bits: u32) -> Vec<u64> {
    let whole = (bits / 64) as usize;
    let part = bits % 64;
    let mut out = vec![0u64; whole + words.len() + 1];
    for (index, word) in words.iter().enumerate() {
        let value = u128::from(*word) << part;
        out[whole + index] |= value as u64;
        out[whole + index + 1] |= (value >> 64) as u64;
    }
    while out.last() == Some(&0) {
        out.pop();
    }
    out
}

/// Little-endian magnitude comparison (leading zero words allowed).
fn compare_words(mut a: &[u64], mut b: &[u64]) -> Ordering {
    while a.last() == Some(&0) {
        a = &a[..a.len() - 1];
    }
    while b.last() == Some(&0) {
        b = &b[..b.len() - 1];
    }
    if a.len() != b.len() {
        return a.len().cmp(&b.len());
    }
    for index in (0..a.len()).rev() {
        if a[index] != b[index] {
            return a[index].cmp(&b[index]);
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(negative: bool, words: &[u64]) -> Numeric {
        Numeric::BigInt {
            negative,
            words: words.to_vec(),
        }
    }

    fn num(value: f64) -> Numeric {
        Numeric::Number(value)
    }

    fn pow2(exponent: u32) -> Vec<u64> {
        let mut words = vec![0u64; exponent as usize / 64 + 1];
        words[exponent as usize / 64] = 1u64 << (exponent % 64);
        words
    }

    #[test]
    fn map_keeps_first_insertion_order_and_replaces_values_in_place() {
        let mut map: OrderedMap<&str> = OrderedMap::new();
        map.insert(ScalarKey::number(1.0), "a");
        map.insert(ScalarKey::String(JsString::from_rust_str("k")), "b");
        map.insert(ScalarKey::number(2.0), "c");
        map.insert(ScalarKey::number(1.0), "A");
        assert_eq!(map.get(&ScalarKey::number(1.0)), Some(&"A"));
        let keys: Vec<_> = map.iter().map(|(key, _)| key.clone()).collect();
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[1], ScalarKey::String(JsString::from_rust_str("k")));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn deleted_key_set_again_iterates_at_the_end() {
        let mut map: OrderedMap<u8> = OrderedMap::new();
        map.insert(ScalarKey::number(1.0), 1);
        map.insert(ScalarKey::number(2.0), 2);
        assert!(map.remove(&ScalarKey::number(1.0)));
        assert!(!map.remove(&ScalarKey::number(1.0)));
        assert_eq!(map.get(&ScalarKey::number(1.0)), None);
        map.insert(ScalarKey::number(1.0), 9);
        let order: Vec<_> = map
            .iter()
            .map(|(key, value)| (key.clone(), *value))
            .collect();
        assert_eq!(order[0].0, ScalarKey::number(2.0));
        assert_eq!(order[1].0, ScalarKey::number(1.0));
        assert_eq!(order[1].1, 9);
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn keys_follow_samevalue_zero() {
        let mut set = OrderedSet::new();
        set.add(ScalarKey::number(-0.0));
        set.add(ScalarKey::number(f64::NAN));
        set.add(ScalarKey::bigint(true, vec![]));
        set.add(ScalarKey::bigint(true, vec![0]));
        set.add(ScalarKey::bigint(false, vec![5, 0]));
        assert!(set.has(&ScalarKey::number(0.0)));
        assert!(set.has(&ScalarKey::number(f64::from_bits(0x7ff8_0000_0000_0001))));
        assert!(set.has(&ScalarKey::bigint(false, vec![])));
        assert!(set.has(&ScalarKey::bigint(false, vec![5])));
        assert!(!set.has(&ScalarKey::bigint(false, vec![6])));
        assert!(!set.has(&ScalarKey::Bool(true)));
        assert_eq!(set.len(), 4);
    }

    #[test]
    fn bigint_against_number_compares_exact_values() {
        // 2500 > 2n**80n is false, Infinity > 2n**80n is true.
        assert_eq!(bigint_cmp_f64(&pow2(80), false, 2500.0), Ordering::Greater);
        assert_eq!(
            bigint_cmp_f64(&pow2(80), false, f64::INFINITY),
            Ordering::Less
        );
        assert_eq!(
            bigint_cmp_f64(&pow2(80), true, f64::NEG_INFINITY),
            Ordering::Greater
        );
        assert_eq!(
            bigint_cmp_f64(&pow2(1024), false, f64::MAX),
            Ordering::Greater
        );
        assert_eq!(
            bigint_cmp_f64(&pow2(53), false, 9_007_199_254_740_992.0),
            Ordering::Equal
        );
        assert_eq!(
            bigint_cmp_f64(&[9_007_199_254_740_993], false, 9_007_199_254_740_992.0),
            Ordering::Greater
        );
        // 4503599627370496.5 > 4503599627370497n is false: the fraction is exact.
        assert_eq!(
            bigint_cmp_f64(&[4_503_599_627_370_497], false, 4_503_599_627_370_496.5),
            Ordering::Greater
        );
        // 4503599627370496.5 is not representable: the literal rounds to 4503599627370496.
        assert_eq!(
            bigint_cmp_f64(&[4_503_599_627_370_496], false, 4_503_599_627_370_496.5),
            Ordering::Equal
        );
        assert_eq!(
            bigint_cmp_f64(&[4_503_599_627_370_495], false, 4_503_599_627_370_495.5),
            Ordering::Less
        );
        assert_eq!(
            bigint_cmp_f64(&[4_503_599_627_370_496], false, 4_503_599_627_370_495.5),
            Ordering::Greater
        );
        // The literal 123456788.99999999 is below 123456789.
        assert_eq!(
            bigint_cmp_f64(&[123_456_789], false, 123456788.99999999_f64),
            Ordering::Greater
        );
        assert_eq!(bigint_cmp_f64(&[0], false, 5e-324), Ordering::Less);
        assert_eq!(bigint_cmp_f64(&[1], false, 5e-324), Ordering::Greater);
        assert_eq!(bigint_cmp_f64(&[], false, -0.0), Ordering::Equal);
        assert_eq!(bigint_cmp_f64(&[1], true, -0.5), Ordering::Less);
        assert_eq!(bigint_cmp_f64(&[5], true, -5.0), Ordering::Equal);
        assert_eq!(bigint_cmp_f64(&[5], false, 5.0), Ordering::Equal);
        assert_eq!(bigint_cmp_f64(&[5], false, 5.5), Ordering::Less);
        assert_eq!(bigint_cmp_f64(&[5], false, 4.5), Ordering::Greater);
        assert_eq!(bigint_cmp_f64(&[5], true, 4.5), Ordering::Less);
    }

    #[test]
    fn relational_comparison_mirrors_the_measured_vectors() {
        // `abs > tolerance` is `tolerance < abs`.
        let less = |tolerance: &Numeric, abs: f64| is_less_than(tolerance, &num(abs));
        assert!(!less(&big(false, &[0, 0, 1 << 16]), 2500.0)); // 2500 > 2n**80n is false
        assert!(less(&big(false, &[0, 0, 1 << 16]), f64::INFINITY));
        assert!(!less(&big(false, &[5]), f64::NAN)); // NaN > 5n is false
        assert!(less(&big(true, &[1]), -0.5)); // -0.5 > -1n is true
        assert!(less(&big(false, &[]), 5e-324)); // 5e-324 > 0n is true
        assert!(!less(
            &big(false, &[9_007_199_254_740_993]),
            9_007_199_254_740_992.0
        )); // 2**53 > 2**53+1n false
        assert!(!less(&big(false, &pow2(1024)), f64::MAX)); // max > 2n**1024n is false
        assert!(!less(&big(false, &[123_456_789]), 123456788.99999999_f64));
        assert!(!less(
            &big(false, &[4_503_599_627_370_497]),
            4_503_599_627_370_496.5
        ));
        assert!(!less(&big(false, &[5]), 5.0)); // 5 > 5n is false (equal)
        assert!(!less(&num(5.0), 5.0));
        assert!(!less(&num(f64::NAN), 1.0));
        assert!(!less(&num(1.0), f64::NAN));
        assert!(less(&num(2000.0), 2000.5));
        assert!(!less(&num(2000.0), 2000.0));
        assert!(!less(&num(f64::INFINITY), f64::MAX));
        assert!(less(&big(true, &pow2(1024)), f64::MAX)); // max > -(2n**1024n) is true
    }

    #[test]
    fn subtraction_checks_types_after_both_coercions() {
        assert_eq!(
            subtract(&num(1010.0), &num(1000.0)),
            Ok(Difference::Number(10.0))
        );
        assert_eq!(subtract(&num(1000.0), &big(false, &[1])), Err(MixedBigInt));
        assert_eq!(subtract(&big(false, &[1]), &num(1000.0)), Err(MixedBigInt));
        assert_eq!(
            subtract(&big(false, &[1]), &big(false, &[1])),
            Ok(Difference::BigInt)
        );
        assert_eq!(math_abs(Difference::Number(-0.5)), Ok(0.5));
        assert!(math_abs(Difference::Number(f64::NAN)).unwrap().is_nan());
        assert_eq!(math_abs(Difference::BigInt), Err(BigIntToNumber));
    }
}
