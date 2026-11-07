//! Byte-for-byte port of the response decision + headers produced by Express
//! 4.22.2 `res.sendFile(absPath)` / `res.download(absPath)`, i.e. of the
//! `send` 0.19.2 pipeline with `etag` 1.8.1, `fresh` 0.5.2, `range-parser`
//! 1.2.1, `mime` 1.6.0 and `content-disposition` 0.5.4.
//!
//! The module is std-only and self-contained so it can be copied verbatim into
//! `native/core/src/http_send.rs` of the `multicc_core` crate.
//!
//! # Contract
//!
//! [`plan`] assumes the caller already did what the Express route did before
//! handing the path to `send`:
//!
//! * the path is `path.resolve`d, absolute, and refers to an existing regular
//!   file (the route stat'ed it);
//! * no headers have been set on the response yet (Express may have set its own
//!   before the route ran; those are the caller's business).
//!
//! It then returns exactly what `send` would leave on `res`: the final status,
//! the ordered header list, and the byte range to stream.
//!
//! # Known deviations from V8
//!
//! [`parse_http_date`] reproduces `Date.parse` for: IMF-fixdate / RFC 1123
//! (`Sun, 06 Nov 1994 08:49:37 GMT`), RFC 850 (`Sunday, 06-Nov-94 08:49:37 GMT`),
//! asctime (`Sun Nov  6 08:49:37 1994`), and the ISO 8601 subset V8's ES5 date
//! parser accepts (whole-string match only, as V8 requires). It does **not**
//! reproduce the following V8 legacy behaviours:
//!
//! * timezone-less legacy forms are interpreted as **UTC**. V8 interprets them
//!   in the process local time zone, so `Date.parse("Sun Nov  6 08:49:37 1994")`
//!   differs by the local UTC offset (for a UTC process the two agree);
//! * non-`GMT`/`UT`/`UTC`/`Z` zone abbreviations (`EST`, `PDT`, ...), which V8
//!   maps through a fixed table;
//! * the random-access legacy grammar (e.g. `Jan 1, 2024`, `2024/01/01`,
//!   `01/01/2024`, weekday names other than a leading token).
//!
//! Within the supported grammar the legacy quirks are modelled exactly: the
//! 2-digit year rule is applied to the parsed *numeric value*, so V8's `094`
//! -> 1994 and `999` -> 999 both come out right; a leading weekday token is
//! skipped even when V8 does not recognise it; and day overflow rolls into the
//! next month (`2024-02-30` -> `2024-03-01`) just like `MakeDay`.
//!
//! [`mime_type`] lowercases with Unicode default case conversion, the same
//! algorithm as JS `toLowerCase` (spot-checked on U+0130, U+017F, U+1E9E and
//! U+212A); the extension table itself is ASCII-only.
//!
//! Everything else (mtime rounding, ETag, `toUTCString`, range parsing, fresh
//! checks, content-disposition quoting) is bit-exact against the real packages;
//! see the golden vectors under `tests/golden.rs`.

// ---------------------------------------------------------------------------
// Node's view of a file
// ---------------------------------------------------------------------------

/// Node's view of a file: `stat.size` and `stat.mtimeMs`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: f64,
}

/// Largest timestamp a JS `Date` can hold (`8.64e15` ms).
const MAX_TIME_MS: f64 = 8.64e15;

/// `Math.round` (ties toward `+Infinity`, preserves `-0` and non-finite values).
fn js_math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `TimeClip`: ToIntegerOrInfinity (truncate toward zero) plus range check.
fn time_clip(ms: f64) -> f64 {
    if !ms.is_finite() {
        return f64::NAN;
    }
    let t = ms.trunc();
    if t.abs() > MAX_TIME_MS {
        f64::NAN
    } else {
        t
    }
}

/// `stat.mtime.getTime()`.
///
/// Node 26 builds `Stats#mtime` as `new Date(Math.round(mtimeMs))`
/// (`dateFromMs` in `internal/fs/utils`, which deliberately rounds to dodge the
/// double rounding TimeClip would otherwise apply). So the rule is
/// `TimeClip(Math.round(mtime_ms))` — round half toward `+Infinity`, then
/// truncate toward zero and clip to the `Date` range.
pub fn node_mtime(stat: &FileStat) -> f64 {
    time_clip(js_math_round(stat.mtime_ms))
}

/// `etag(stat)` from etag 1.8.1 with a `Stats` argument: `W/"<size hex>-<mtime hex>"`.
pub fn etag(stat: &FileStat) -> String {
    format!(
        "W/\"{:x}-{}\"",
        stat.size,
        js_number_to_hex(node_mtime(stat))
    )
}

/// `Number.prototype.toString(16)` for the integral values `node_mtime` can return.
fn js_number_to_hex(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    // |v| <= 8.64e15 fits comfortably in i64.
    let n = v as i64;
    if n < 0 {
        format!("-{:x}", n.unsigned_abs())
    } else {
        format!("{n:x}")
    }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MS_PER_DAY: f64 = 86_400_000.0;
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`].
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.prototype.toUTCString`.
///
/// The argument is treated the way `new Date(ms)` would treat it (truncate,
/// then clip), so `utc_string(f64::NAN)` is `"Invalid Date"`.
pub fn utc_string(ms: f64) -> String {
    let t = time_clip(ms);
    if t.is_nan() {
        return "Invalid Date".to_string();
    }
    let days = (t / MS_PER_DAY).floor();
    let day_index = days as i64;
    let ms_of_day = t - days * MS_PER_DAY;
    let (year, month, day) = civil_from_days(day_index);
    let secs_of_day = (ms_of_day / 1000.0).floor() as i64;
    let weekday = (day_index + 4).rem_euclid(7) as usize;
    let year_text = if year < 0 {
        format!("-{:04}", -year)
    } else if year < 10_000 {
        format!("{year:04}")
    } else {
        year.to_string()
    };
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WEEKDAYS[weekday],
        day,
        MONTHS[month as usize - 1],
        year_text,
        secs_of_day / 3600,
        (secs_of_day / 60) % 60,
        secs_of_day % 60,
    )
}

/// Whitespace as the ECMAScript `\s` class sees it.
fn js_whitespace(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000d}'
        | ' '
        | '\u{00a0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200a}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202f}'
        | '\u{205f}'
        | '\u{3000}'
        | '\u{feff}')
}

/// `Date.parse(text)` for the forms documented on the module.
pub fn parse_http_date(text: &str) -> Option<f64> {
    if let Some(ms) = parse_iso_8601(text) {
        return Some(ms);
    }
    parse_legacy_date(text)
}

/// Reads exactly `n` ASCII digits at `*i`.
fn read_exact_digits(chars: &[char], i: &mut usize, n: usize) -> Option<i64> {
    if *i + n > chars.len() {
        return None;
    }
    let mut value: i64 = 0;
    for _ in 0..n {
        let c = chars[*i];
        if !c.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(c as u8 - b'0');
        *i += 1;
    }
    Some(value)
}

/// Reads one or more ASCII digits at `*i`.
fn read_digits(chars: &[char], i: &mut usize) -> Option<i64> {
    let start = *i;
    let mut value: i64 = 0;
    while *i < chars.len() && chars[*i].is_ascii_digit() {
        value = value
            .saturating_mul(10)
            .saturating_add(i64::from(chars[*i] as u8 - b'0'));
        *i += 1;
    }
    if *i == start {
        None
    } else {
        Some(value)
    }
}

/// Builds the epoch milliseconds for a wall-clock time plus a zone offset.
#[allow(clippy::too_many_arguments)]
fn build_time(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    milli: u32,
    offset_minutes: i64,
) -> Option<f64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, 1) + i64::from(day) - 1;
    let ms = days * 86_400_000
        + i64::from(hour) * 3_600_000
        + i64::from(minute) * 60_000
        + i64::from(second) * 1000
        + i64::from(milli)
        - offset_minutes * 60_000;
    let ms = ms as f64;
    if ms.abs() > MAX_TIME_MS {
        None
    } else {
        Some(ms)
    }
}

/// V8's `ParseES5Date`: strict, whole-string, ISO-8601-ish.
fn parse_iso_8601(text: &str) -> Option<f64> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0usize;

    let year: i64 = if i < n && (chars[i] == '+' || chars[i] == '-') {
        let negative = chars[i] == '-';
        i += 1;
        let y = read_exact_digits(&chars, &mut i, 6)?;
        if negative {
            -y
        } else {
            y
        }
    } else {
        read_exact_digits(&chars, &mut i, 4)?
    };
    if i == n {
        return build_time(year, 1, 1, 0, 0, 0, 0, 0);
    }
    if chars[i] != '-' {
        return None;
    }
    i += 1;
    let month = read_exact_digits(&chars, &mut i, 2)? as u32;
    if i == n {
        return build_time(year, month, 1, 0, 0, 0, 0, 0);
    }
    if chars[i] != '-' {
        return None;
    }
    i += 1;
    let day = read_exact_digits(&chars, &mut i, 2)? as u32;
    if i == n {
        return build_time(year, month, day, 0, 0, 0, 0, 0);
    }
    if !matches!(chars[i], 'T' | 't' | ' ') {
        return None;
    }
    i += 1;
    let hour = read_exact_digits(&chars, &mut i, 2)? as u32;
    if i >= n || chars[i] != ':' {
        return None;
    }
    i += 1;
    let minute = read_exact_digits(&chars, &mut i, 2)? as u32;
    let mut second = 0u32;
    let mut milli = 0u32;
    if i < n && chars[i] == ':' {
        i += 1;
        second = read_exact_digits(&chars, &mut i, 2)? as u32;
        if i < n && chars[i] == '.' {
            i += 1;
            let start = i;
            while i < n && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return None;
            }
            let end = (start + 3).min(i);
            let mut value = 0u32;
            for c in &chars[start..end] {
                value = value * 10 + u32::from(*c as u8 - b'0');
            }
            for _ in end..start + 3 {
                value *= 10;
            }
            milli = value;
        }
    }
    let mut offset_minutes = 0i64;
    if i < n {
        if matches!(chars[i], 'Z' | 'z') {
            i += 1;
        } else if matches!(chars[i], '+' | '-') {
            let negative = chars[i] == '-';
            i += 1;
            let hh = read_exact_digits(&chars, &mut i, 2)?;
            let mut mm = 0i64;
            if i < n && chars[i] == ':' {
                i += 1;
                mm = read_exact_digits(&chars, &mut i, 2)?;
            } else if i < n && chars[i].is_ascii_digit() {
                mm = read_exact_digits(&chars, &mut i, 2)?;
            }
            let total = hh * 60 + mm;
            offset_minutes = if negative { -total } else { total };
        } else {
            return None;
        }
    }
    if i != n {
        return None;
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || milli != 0) {
        return None;
    }
    build_time(
        year,
        month,
        day,
        hour,
        minute,
        second,
        milli,
        offset_minutes,
    )
}

fn month_from_name(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|m| m.to_ascii_lowercase() == lower)
        .map(|p| p as u32 + 1)
}

/// Reads `HH:MM[:SS[.fff]]` at `*i` (legacy parser allows 1-2 digit fields).
fn read_legacy_time(chars: &[char], i: &mut usize) -> Option<(u32, u32, u32, u32)> {
    let hour = read_digits(chars, i)?;
    if *i >= chars.len() || chars[*i] != ':' {
        return None;
    }
    *i += 1;
    let minute = read_digits(chars, i)?;
    let mut second = 0i64;
    let mut milli = 0i64;
    if *i < chars.len() && chars[*i] == ':' {
        *i += 1;
        let s = read_digits(chars, i)?;
        second = s;
        if *i < chars.len() && chars[*i] == '.' {
            *i += 1;
            let start = *i;
            while *i < chars.len() && chars[*i].is_ascii_digit() {
                *i += 1;
            }
            if *i == start {
                return None;
            }
            let end = (start + 3).min(*i);
            let mut value = 0i64;
            for c in &chars[start..end] {
                value = value * 10 + i64::from(*c as u8 - b'0');
            }
            for _ in end..start + 3 {
                value *= 10;
            }
            milli = value;
        }
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || milli != 0) {
        return None;
    }
    Some((hour as u32, minute as u32, second as u32, milli as u32))
}

/// Reads an optional trailing zone (`GMT`, `UT`, `UTC`, `Z`, `[+-]HH[:]MM`).
fn read_legacy_zone(chars: &[char], i: &mut usize) -> Option<i64> {
    if *i >= chars.len() {
        return Some(0);
    }
    let mut offset = 0i64;
    if chars[*i].is_ascii_alphabetic() {
        let start = *i;
        while *i < chars.len() && chars[*i].is_ascii_alphabetic() {
            *i += 1;
        }
        let word: String = chars[start..*i]
            .iter()
            .collect::<String>()
            .to_ascii_uppercase();
        match word.as_str() {
            "GMT" | "UT" | "UTC" | "Z" => {}
            _ => return None,
        }
    }
    if *i < chars.len() && (chars[*i] == '+' || chars[*i] == '-') {
        let negative = chars[*i] == '-';
        *i += 1;
        let hh = read_digits(chars, i)?;
        let mut mm = 0i64;
        if *i < chars.len() && chars[*i] == ':' {
            *i += 1;
            mm = read_digits(chars, i)?;
        } else if *i < chars.len() && chars[*i].is_ascii_digit() {
            mm = read_digits(chars, i)?;
        }
        let total = hh * 60 + mm;
        offset = if negative { -total } else { total };
    }
    Some(offset)
}

/// The legacy (non-ISO) `Date.parse` grammar, restricted to the HTTP date
/// shapes and the documented deviations.
fn parse_legacy_date(text: &str) -> Option<f64> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    while i < n && js_whitespace(chars[i]) {
        i += 1;
    }
    if i >= n {
        return None;
    }

    // Optional leading weekday token (`Sun`, `Sunday`, or any word V8 skips).
    if chars[i].is_ascii_alphabetic() {
        while i < n && chars[i].is_ascii_alphabetic() {
            i += 1;
        }
        if i < n && chars[i] == ',' {
            i += 1;
        }
        while i < n && js_whitespace(chars[i]) {
            i += 1;
        }
        if i >= n {
            return None;
        }
        if chars[i].is_ascii_alphabetic() {
            // asctime shape: `Mon D HH:MM:SS YYYY`.
            let start = i;
            while i < n && chars[i].is_ascii_alphabetic() {
                i += 1;
            }
            let month_name: String = chars[start..i].iter().collect();
            let month = month_from_name(&month_name)?;
            skip_spaces(&chars, &mut i);
            let day = read_digits(&chars, &mut i)? as u32;
            skip_spaces(&chars, &mut i);
            let (hour, minute, second, milli) = read_legacy_time(&chars, &mut i)?;
            if i >= n {
                return None;
            }
            skip_spaces(&chars, &mut i);
            let year = adjust_legacy_year(read_digits(&chars, &mut i)?);
            skip_spaces(&chars, &mut i);
            if i < n {
                let offset = read_legacy_zone(&chars, &mut i)?;
                skip_spaces(&chars, &mut i);
                if i != n {
                    return None;
                }
                return build_time(year, month, day, hour, minute, second, milli, offset);
            }
            return build_time(year, month, day, hour, minute, second, milli, 0);
        }
    }

    // Day-first shapes: `06-Nov-94 ...`, `06-Nov-1994 ...`, `6 Nov 1994 ...`.
    let day = read_digits(&chars, &mut i)? as u32;
    if i < n && chars[i] == '-' {
        i += 1;
    } else if i < n && js_whitespace(chars[i]) {
        skip_spaces(&chars, &mut i);
    } else {
        return None;
    }
    let start = i;
    while i < n && chars[i].is_ascii_alphabetic() {
        i += 1;
    }
    let month_name: String = chars[start..i].iter().collect();
    let month = month_from_name(&month_name)?;
    let hyphenated = chars.get(i) == Some(&'-');
    if hyphenated {
        i += 1;
    } else {
        skip_spaces(&chars, &mut i);
    }
    let year = adjust_legacy_year(read_digits(&chars, &mut i)?);

    let mut hour = 0u32;
    let mut minute = 0u32;
    let mut second = 0u32;
    let mut milli = 0u32;
    let had_space = chars.get(i).copied().is_some_and(js_whitespace);
    skip_spaces(&chars, &mut i);
    if i < n && chars[i].is_ascii_digit() {
        let saved = i;
        match read_legacy_time(&chars, &mut i) {
            Some(t) => (hour, minute, second, milli) = t,
            None => i = saved,
        }
    } else if hyphenated || !had_space {
        // `06-Nov-94` without a time is fine; anything else needs a time.
        if i != n {
            return None;
        }
    }
    skip_spaces(&chars, &mut i);
    if i >= n {
        return build_time(year, month, day, hour, minute, second, milli, 0);
    }
    let offset = read_legacy_zone(&chars, &mut i)?;
    skip_spaces(&chars, &mut i);
    if i != n {
        return None;
    }
    build_time(year, month, day, hour, minute, second, milli, offset)
}

fn skip_spaces(chars: &[char], i: &mut usize) {
    while *i < chars.len() && js_whitespace(chars[*i]) {
        *i += 1;
    }
}

/// V8's legacy year rule is applied to the numeric value: `value < 100` gets the
/// 2000/1900 shift, so `94` -> 1994 and `094` -> 1994 as well.
fn adjust_legacy_year(value: i64) -> i64 {
    if value < 100 {
        if value < 50 {
            value + 2000
        } else {
            value + 1900
        }
    } else {
        value
    }
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

/// `mime.lookup` default type (`mime.lookup('bin')` in mime 1.6.0).
const DEFAULT_MIME: &str = "application/octet-stream";

/// mime 1.6.0 `Mime.prototype.lookup`'s extension extraction:
/// `path.replace(/^.*[\.\/\\]/, '').toLowerCase()`.
///
/// JS `.` does not cross line terminators and `^` is not multiline, so only the
/// last `.`, `/` or `\` before the first line terminator can start the match.
fn mime_extension(path: &str) -> String {
    let cut = path
        .char_indices()
        .find(|&(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        .map(|(i, _)| i)
        .unwrap_or(path.len());
    let head = &path[..cut];
    let last = head
        .char_indices()
        .rev()
        .find(|&(_, c)| matches!(c, '.' | '/' | '\\'))
        .map(|(i, _)| i);
    match last {
        Some(i) => path[i + 1..].to_lowercase(),
        None => path.to_lowercase(),
    }
}

/// Extension -> media type table extracted from mime 1.6.0 `types.json`.
/// Sorted by extension (ASCII byte order) for binary search.
pub static MIME_TYPES: &[(&str, &str)] = &[
    ("123", "application/vnd.lotus-1-2-3"),
    ("3dml", "text/vnd.in3d.3dml"),
    ("3ds", "image/x-3ds"),
    ("3g2", "video/3gpp2"),
    ("3gp", "video/3gpp"),
    ("3gpp", "video/3gpp"),
    ("7z", "application/x-7z-compressed"),
    ("aab", "application/x-authorware-bin"),
    ("aac", "audio/x-aac"),
    ("aam", "application/x-authorware-map"),
    ("aas", "application/x-authorware-seg"),
    ("abw", "application/x-abiword"),
    ("ac", "application/pkix-attr-cert"),
    ("acc", "application/vnd.americandynamics.acc"),
    ("ace", "application/x-ace-compressed"),
    ("acu", "application/vnd.acucobol"),
    ("acutc", "application/vnd.acucorp"),
    ("adp", "audio/adpcm"),
    ("aep", "application/vnd.audiograph"),
    ("afm", "application/x-font-type1"),
    ("afp", "application/vnd.ibm.modcap"),
    ("ahead", "application/vnd.ahead.space"),
    ("ai", "application/postscript"),
    ("aif", "audio/x-aiff"),
    ("aifc", "audio/x-aiff"),
    ("aiff", "audio/x-aiff"),
    (
        "air",
        "application/vnd.adobe.air-application-installer-package+zip",
    ),
    ("ait", "application/vnd.dvb.ait"),
    ("ami", "application/vnd.amiga.ami"),
    ("apk", "application/vnd.android.package-archive"),
    ("apng", "image/apng"),
    ("appcache", "text/cache-manifest"),
    ("application", "application/x-ms-application"),
    ("apr", "application/vnd.lotus-approach"),
    ("arc", "application/x-freearc"),
    ("arj", "application/x-arj"),
    ("asc", "application/pgp-signature"),
    ("asf", "video/x-ms-asf"),
    ("asm", "text/x-asm"),
    ("aso", "application/vnd.accpac.simply.aso"),
    ("asx", "video/x-ms-asf"),
    ("atc", "application/vnd.acucorp"),
    ("atom", "application/atom+xml"),
    ("atomcat", "application/atomcat+xml"),
    ("atomsvc", "application/atomsvc+xml"),
    ("atx", "application/vnd.antix.game-component"),
    ("au", "audio/basic"),
    ("avi", "video/x-msvideo"),
    ("aw", "application/applixware"),
    ("azf", "application/vnd.airzip.filesecure.azf"),
    ("azs", "application/vnd.airzip.filesecure.azs"),
    ("azw", "application/vnd.amazon.ebook"),
    ("bat", "application/x-msdownload"),
    ("bcpio", "application/x-bcpio"),
    ("bdf", "application/x-font-bdf"),
    ("bdm", "application/vnd.syncml.dm+wbxml"),
    ("bdoc", "application/bdoc"),
    ("bed", "application/vnd.realvnc.bed"),
    ("bh2", "application/vnd.fujitsu.oasysprs"),
    ("bin", "application/octet-stream"),
    ("blb", "application/x-blorb"),
    ("blorb", "application/x-blorb"),
    ("bmi", "application/vnd.bmi"),
    ("bmp", "image/bmp"),
    ("book", "application/vnd.framemaker"),
    ("box", "application/vnd.previewsystems.box"),
    ("boz", "application/x-bzip2"),
    ("bpk", "application/octet-stream"),
    ("btif", "image/prs.btif"),
    ("buffer", "application/octet-stream"),
    ("bz", "application/x-bzip"),
    ("bz2", "application/x-bzip2"),
    ("c", "text/x-c"),
    ("c11amc", "application/vnd.cluetrust.cartomobile-config"),
    ("c11amz", "application/vnd.cluetrust.cartomobile-config-pkg"),
    ("c4d", "application/vnd.clonk.c4group"),
    ("c4f", "application/vnd.clonk.c4group"),
    ("c4g", "application/vnd.clonk.c4group"),
    ("c4p", "application/vnd.clonk.c4group"),
    ("c4u", "application/vnd.clonk.c4group"),
    ("cab", "application/vnd.ms-cab-compressed"),
    ("caf", "audio/x-caf"),
    ("cap", "application/vnd.tcpdump.pcap"),
    ("car", "application/vnd.curl.car"),
    ("cat", "application/vnd.ms-pki.seccat"),
    ("cb7", "application/x-cbr"),
    ("cba", "application/x-cbr"),
    ("cbr", "application/x-cbr"),
    ("cbt", "application/x-cbr"),
    ("cbz", "application/x-cbr"),
    ("cc", "text/x-c"),
    ("cco", "application/x-cocoa"),
    ("cct", "application/x-director"),
    ("ccxml", "application/ccxml+xml"),
    ("cdbcmsg", "application/vnd.contact.cmsg"),
    ("cdf", "application/x-netcdf"),
    ("cdkey", "application/vnd.mediastation.cdkey"),
    ("cdmia", "application/cdmi-capability"),
    ("cdmic", "application/cdmi-container"),
    ("cdmid", "application/cdmi-domain"),
    ("cdmio", "application/cdmi-object"),
    ("cdmiq", "application/cdmi-queue"),
    ("cdx", "chemical/x-cdx"),
    ("cdxml", "application/vnd.chemdraw+xml"),
    ("cdy", "application/vnd.cinderella"),
    ("cer", "application/pkix-cert"),
    ("cfs", "application/x-cfs-compressed"),
    ("cgm", "image/cgm"),
    ("chat", "application/x-chat"),
    ("chm", "application/vnd.ms-htmlhelp"),
    ("chrt", "application/vnd.kde.kchart"),
    ("cif", "chemical/x-cif"),
    (
        "cii",
        "application/vnd.anser-web-certificate-issue-initiation",
    ),
    ("cil", "application/vnd.ms-artgalry"),
    ("cla", "application/vnd.claymore"),
    ("class", "application/java-vm"),
    ("clkk", "application/vnd.crick.clicker.keyboard"),
    ("clkp", "application/vnd.crick.clicker.palette"),
    ("clkt", "application/vnd.crick.clicker.template"),
    ("clkw", "application/vnd.crick.clicker.wordbank"),
    ("clkx", "application/vnd.crick.clicker"),
    ("clp", "application/x-msclip"),
    ("cmc", "application/vnd.cosmocaller"),
    ("cmdf", "chemical/x-cmdf"),
    ("cml", "chemical/x-cml"),
    ("cmp", "application/vnd.yellowriver-custom-menu"),
    ("cmx", "image/x-cmx"),
    ("cod", "application/vnd.rim.cod"),
    ("coffee", "text/coffeescript"),
    ("com", "application/x-msdownload"),
    ("conf", "text/plain"),
    ("cpio", "application/x-cpio"),
    ("cpp", "text/x-c"),
    ("cpt", "application/mac-compactpro"),
    ("crd", "application/x-mscardfile"),
    ("crl", "application/pkix-crl"),
    ("crt", "application/x-x509-ca-cert"),
    ("crx", "application/x-chrome-extension"),
    ("cryptonote", "application/vnd.rig.cryptonote"),
    ("csh", "application/x-csh"),
    ("csml", "chemical/x-csml"),
    ("csp", "application/vnd.commonspace"),
    ("css", "text/css"),
    ("cst", "application/x-director"),
    ("csv", "text/csv"),
    ("cu", "application/cu-seeme"),
    ("curl", "text/vnd.curl"),
    ("cww", "application/prs.cww"),
    ("cxt", "application/x-director"),
    ("cxx", "text/x-c"),
    ("dae", "model/vnd.collada+xml"),
    ("daf", "application/vnd.mobius.daf"),
    ("dart", "application/vnd.dart"),
    ("dataless", "application/vnd.fdsn.seed"),
    ("davmount", "application/davmount+xml"),
    ("dbk", "application/docbook+xml"),
    ("dcr", "application/x-director"),
    ("dcurl", "text/vnd.curl.dcurl"),
    ("dd2", "application/vnd.oma.dd2+xml"),
    ("ddd", "application/vnd.fujixerox.ddd"),
    ("deb", "application/octet-stream"),
    ("def", "text/plain"),
    ("deploy", "application/octet-stream"),
    ("der", "application/x-x509-ca-cert"),
    ("dfac", "application/vnd.dreamfactory"),
    ("dgc", "application/x-dgc-compressed"),
    ("dic", "text/x-c"),
    ("dir", "application/x-director"),
    ("dis", "application/vnd.mobius.dis"),
    ("dist", "application/octet-stream"),
    ("distz", "application/octet-stream"),
    ("djv", "image/vnd.djvu"),
    ("djvu", "image/vnd.djvu"),
    ("dll", "application/octet-stream"),
    ("dmg", "application/octet-stream"),
    ("dmp", "application/vnd.tcpdump.pcap"),
    ("dms", "application/octet-stream"),
    ("dna", "application/vnd.dna"),
    ("doc", "application/msword"),
    ("docm", "application/vnd.ms-word.document.macroenabled.12"),
    (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    ("dot", "application/msword"),
    ("dotm", "application/vnd.ms-word.template.macroenabled.12"),
    (
        "dotx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    ),
    ("dp", "application/vnd.osgi.dp"),
    ("dpg", "application/vnd.dpgraph"),
    ("dra", "audio/vnd.dra"),
    ("dsc", "text/prs.lines.tag"),
    ("dssc", "application/dssc+der"),
    ("dtb", "application/x-dtbook+xml"),
    ("dtd", "application/xml-dtd"),
    ("dts", "audio/vnd.dts"),
    ("dtshd", "audio/vnd.dts.hd"),
    ("dump", "application/octet-stream"),
    ("dvb", "video/vnd.dvb.file"),
    ("dvi", "application/x-dvi"),
    ("dwf", "model/vnd.dwf"),
    ("dwg", "image/vnd.dwg"),
    ("dxf", "image/vnd.dxf"),
    ("dxp", "application/vnd.spotfire.dxp"),
    ("dxr", "application/x-director"),
    ("ear", "application/java-archive"),
    ("ecelp4800", "audio/vnd.nuera.ecelp4800"),
    ("ecelp7470", "audio/vnd.nuera.ecelp7470"),
    ("ecelp9600", "audio/vnd.nuera.ecelp9600"),
    ("ecma", "application/ecmascript"),
    ("edm", "application/vnd.novadigm.edm"),
    ("edx", "application/vnd.novadigm.edx"),
    ("efif", "application/vnd.picsel"),
    ("ei6", "application/vnd.pg.osasli"),
    ("elc", "application/octet-stream"),
    ("emf", "application/x-msmetafile"),
    ("eml", "message/rfc822"),
    ("emma", "application/emma+xml"),
    ("emz", "application/x-msmetafile"),
    ("eol", "audio/vnd.digital-winds"),
    ("eot", "application/vnd.ms-fontobject"),
    ("eps", "application/postscript"),
    ("epub", "application/epub+zip"),
    ("es3", "application/vnd.eszigno3+xml"),
    ("esa", "application/vnd.osgi.subsystem"),
    ("esf", "application/vnd.epson.esf"),
    ("et3", "application/vnd.eszigno3+xml"),
    ("etx", "text/x-setext"),
    ("eva", "application/x-eva"),
    ("evy", "application/x-envoy"),
    ("exe", "application/octet-stream"),
    ("exi", "application/exi"),
    ("ext", "application/vnd.novadigm.ext"),
    ("ez", "application/andrew-inset"),
    ("ez2", "application/vnd.ezpix-album"),
    ("ez3", "application/vnd.ezpix-package"),
    ("f", "text/x-fortran"),
    ("f4v", "video/x-f4v"),
    ("f77", "text/x-fortran"),
    ("f90", "text/x-fortran"),
    ("fbs", "image/vnd.fastbidsheet"),
    ("fcdt", "application/vnd.adobe.formscentral.fcdt"),
    ("fcs", "application/vnd.isac.fcs"),
    ("fdf", "application/vnd.fdf"),
    ("fe_launch", "application/vnd.denovo.fcselayout-link"),
    ("fg5", "application/vnd.fujitsu.oasysgp"),
    ("fgd", "application/x-director"),
    ("fh", "image/x-freehand"),
    ("fh4", "image/x-freehand"),
    ("fh5", "image/x-freehand"),
    ("fh7", "image/x-freehand"),
    ("fhc", "image/x-freehand"),
    ("fig", "application/x-xfig"),
    ("flac", "audio/x-flac"),
    ("fli", "video/x-fli"),
    ("flo", "application/vnd.micrografx.flo"),
    ("flv", "video/x-flv"),
    ("flw", "application/vnd.kde.kivio"),
    ("flx", "text/vnd.fmi.flexstor"),
    ("fly", "text/vnd.fly"),
    ("fm", "application/vnd.framemaker"),
    ("fnc", "application/vnd.frogans.fnc"),
    ("for", "text/x-fortran"),
    ("fpx", "image/vnd.fpx"),
    ("frame", "application/vnd.framemaker"),
    ("fsc", "application/vnd.fsc.weblaunch"),
    ("fst", "image/vnd.fst"),
    ("ftc", "application/vnd.fluxtime.clip"),
    ("fti", "application/vnd.anser-web-funds-transfer-initiation"),
    ("fvt", "video/vnd.fvt"),
    ("fxp", "application/vnd.adobe.fxp"),
    ("fxpl", "application/vnd.adobe.fxp"),
    ("fzs", "application/vnd.fuzzysheet"),
    ("g2w", "application/vnd.geoplan"),
    ("g3", "image/g3fax"),
    ("g3w", "application/vnd.geospace"),
    ("gac", "application/vnd.groove-account"),
    ("gam", "application/x-tads"),
    ("gbr", "application/rpki-ghostbusters"),
    ("gca", "application/x-gca-compressed"),
    ("gdl", "model/vnd.gdl"),
    ("gdoc", "application/vnd.google-apps.document"),
    ("geo", "application/vnd.dynageo"),
    ("geojson", "application/geo+json"),
    ("gex", "application/vnd.geometry-explorer"),
    ("ggb", "application/vnd.geogebra.file"),
    ("ggt", "application/vnd.geogebra.tool"),
    ("ghf", "application/vnd.groove-help"),
    ("gif", "image/gif"),
    ("gim", "application/vnd.groove-identity-message"),
    ("glb", "model/gltf-binary"),
    ("gltf", "model/gltf+json"),
    ("gml", "application/gml+xml"),
    ("gmx", "application/vnd.gmx"),
    ("gnumeric", "application/x-gnumeric"),
    ("gph", "application/vnd.flographit"),
    ("gpx", "application/gpx+xml"),
    ("gqf", "application/vnd.grafeq"),
    ("gqs", "application/vnd.grafeq"),
    ("gram", "application/srgs"),
    ("gramps", "application/x-gramps-xml"),
    ("gre", "application/vnd.geometry-explorer"),
    ("grv", "application/vnd.groove-injector"),
    ("grxml", "application/srgs+xml"),
    ("gsf", "application/x-font-ghostscript"),
    ("gsheet", "application/vnd.google-apps.spreadsheet"),
    ("gslides", "application/vnd.google-apps.presentation"),
    ("gtar", "application/x-gtar"),
    ("gtm", "application/vnd.groove-tool-message"),
    ("gtw", "model/vnd.gtw"),
    ("gv", "text/vnd.graphviz"),
    ("gxf", "application/gxf"),
    ("gxt", "application/vnd.geonext"),
    ("gz", "application/gzip"),
    ("h", "text/x-c"),
    ("h261", "video/h261"),
    ("h263", "video/h263"),
    ("h264", "video/h264"),
    ("hal", "application/vnd.hal+xml"),
    ("hbci", "application/vnd.hbci"),
    ("hbs", "text/x-handlebars-template"),
    ("hdd", "application/x-virtualbox-hdd"),
    ("hdf", "application/x-hdf"),
    ("hh", "text/x-c"),
    ("hjson", "text/hjson"),
    ("hlp", "application/winhlp"),
    ("hpgl", "application/vnd.hp-hpgl"),
    ("hpid", "application/vnd.hp-hpid"),
    ("hps", "application/vnd.hp-hps"),
    ("hqx", "application/mac-binhex40"),
    ("htc", "text/x-component"),
    ("htke", "application/vnd.kenameaapp"),
    ("htm", "text/html"),
    ("html", "text/html"),
    ("hvd", "application/vnd.yamaha.hv-dic"),
    ("hvp", "application/vnd.yamaha.hv-voice"),
    ("hvs", "application/vnd.yamaha.hv-script"),
    ("i2g", "application/vnd.intergeo"),
    ("icc", "application/vnd.iccprofile"),
    ("ice", "x-conference/x-cooltalk"),
    ("icm", "application/vnd.iccprofile"),
    ("ico", "image/x-icon"),
    ("ics", "text/calendar"),
    ("ief", "image/ief"),
    ("ifb", "text/calendar"),
    ("ifm", "application/vnd.shana.informed.formdata"),
    ("iges", "model/iges"),
    ("igl", "application/vnd.igloader"),
    ("igm", "application/vnd.insors.igm"),
    ("igs", "model/iges"),
    ("igx", "application/vnd.micrografx.igx"),
    ("iif", "application/vnd.shana.informed.interchange"),
    ("img", "application/octet-stream"),
    ("imp", "application/vnd.accpac.simply.imp"),
    ("ims", "application/vnd.ms-ims"),
    ("in", "text/plain"),
    ("ini", "text/plain"),
    ("ink", "application/inkml+xml"),
    ("inkml", "application/inkml+xml"),
    ("install", "application/x-install-instructions"),
    ("iota", "application/vnd.astraea-software.iota"),
    ("ipfix", "application/ipfix"),
    ("ipk", "application/vnd.shana.informed.package"),
    ("irm", "application/vnd.ibm.rights-management"),
    ("irp", "application/vnd.irepository.package+xml"),
    ("iso", "application/octet-stream"),
    ("itp", "application/vnd.shana.informed.formtemplate"),
    ("ivp", "application/vnd.immervision-ivp"),
    ("ivu", "application/vnd.immervision-ivu"),
    ("jad", "text/vnd.sun.j2me.app-descriptor"),
    ("jade", "text/jade"),
    ("jam", "application/vnd.jam"),
    ("jar", "application/java-archive"),
    ("jardiff", "application/x-java-archive-diff"),
    ("java", "text/x-java-source"),
    ("jisp", "application/vnd.jisp"),
    ("jlt", "application/vnd.hp-jlyt"),
    ("jng", "image/x-jng"),
    ("jnlp", "application/x-java-jnlp-file"),
    ("joda", "application/vnd.joost.joda-archive"),
    ("jp2", "image/jp2"),
    ("jpe", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("jpf", "image/jpx"),
    ("jpg", "image/jpeg"),
    ("jpg2", "image/jp2"),
    ("jpgm", "video/jpm"),
    ("jpgv", "video/jpeg"),
    ("jpm", "image/jpm"),
    ("jpx", "image/jpx"),
    ("js", "application/javascript"),
    ("json", "application/json"),
    ("json5", "application/json5"),
    ("jsonld", "application/ld+json"),
    ("jsonml", "application/jsonml+json"),
    ("jsx", "text/jsx"),
    ("kar", "audio/midi"),
    ("karbon", "application/vnd.kde.karbon"),
    ("kfo", "application/vnd.kde.kformula"),
    ("kia", "application/vnd.kidspiration"),
    ("kml", "application/vnd.google-earth.kml+xml"),
    ("kmz", "application/vnd.google-earth.kmz"),
    ("kne", "application/vnd.kinar"),
    ("knp", "application/vnd.kinar"),
    ("kon", "application/vnd.kde.kontour"),
    ("kpr", "application/vnd.kde.kpresenter"),
    ("kpt", "application/vnd.kde.kpresenter"),
    ("kpxx", "application/vnd.ds-keypoint"),
    ("ksp", "application/vnd.kde.kspread"),
    ("ktr", "application/vnd.kahootz"),
    ("ktx", "image/ktx"),
    ("ktz", "application/vnd.kahootz"),
    ("kwd", "application/vnd.kde.kword"),
    ("kwt", "application/vnd.kde.kword"),
    ("lasxml", "application/vnd.las.las+xml"),
    ("latex", "application/x-latex"),
    ("lbd", "application/vnd.llamagraphics.life-balance.desktop"),
    (
        "lbe",
        "application/vnd.llamagraphics.life-balance.exchange+xml",
    ),
    ("les", "application/vnd.hhe.lesson-player"),
    ("less", "text/less"),
    ("lha", "application/x-lzh-compressed"),
    ("link66", "application/vnd.route66.link66+xml"),
    ("list", "text/plain"),
    ("list3820", "application/vnd.ibm.modcap"),
    ("listafp", "application/vnd.ibm.modcap"),
    ("litcoffee", "text/coffeescript"),
    ("lnk", "application/x-ms-shortcut"),
    ("log", "text/plain"),
    ("lostxml", "application/lost+xml"),
    ("lrf", "application/octet-stream"),
    ("lrm", "application/vnd.ms-lrm"),
    ("ltf", "application/vnd.frogans.ltf"),
    ("lua", "text/x-lua"),
    ("luac", "application/x-lua-bytecode"),
    ("lvp", "audio/vnd.lucent.voice"),
    ("lwp", "application/vnd.lotus-wordpro"),
    ("lzh", "application/x-lzh-compressed"),
    ("m13", "application/x-msmediaview"),
    ("m14", "application/x-msmediaview"),
    ("m1v", "video/mpeg"),
    ("m21", "application/mp21"),
    ("m2a", "audio/mpeg"),
    ("m2v", "video/mpeg"),
    ("m3a", "audio/mpeg"),
    ("m3u", "audio/x-mpegurl"),
    ("m3u8", "application/vnd.apple.mpegurl"),
    ("m4a", "audio/mp4"),
    ("m4p", "application/mp4"),
    ("m4u", "video/vnd.mpegurl"),
    ("m4v", "video/x-m4v"),
    ("ma", "application/mathematica"),
    ("mads", "application/mads+xml"),
    ("mag", "application/vnd.ecowin.chart"),
    ("maker", "application/vnd.framemaker"),
    ("man", "text/troff"),
    ("manifest", "text/cache-manifest"),
    ("map", "application/json"),
    ("mar", "application/octet-stream"),
    ("markdown", "text/markdown"),
    ("mathml", "application/mathml+xml"),
    ("mb", "application/mathematica"),
    ("mbk", "application/vnd.mobius.mbk"),
    ("mbox", "application/mbox"),
    ("mc1", "application/vnd.medcalcdata"),
    ("mcd", "application/vnd.mcd"),
    ("mcurl", "text/vnd.curl.mcurl"),
    ("md", "text/markdown"),
    ("mdb", "application/x-msaccess"),
    ("mdi", "image/vnd.ms-modi"),
    ("me", "text/troff"),
    ("mesh", "model/mesh"),
    ("meta4", "application/metalink4+xml"),
    ("metalink", "application/metalink+xml"),
    ("mets", "application/mets+xml"),
    ("mfm", "application/vnd.mfmp"),
    ("mft", "application/rpki-manifest"),
    ("mgp", "application/vnd.osgeo.mapguide.package"),
    ("mgz", "application/vnd.proteus.magazine"),
    ("mid", "audio/midi"),
    ("midi", "audio/midi"),
    ("mie", "application/x-mie"),
    ("mif", "application/vnd.mif"),
    ("mime", "message/rfc822"),
    ("mj2", "video/mj2"),
    ("mjp2", "video/mj2"),
    ("mjs", "application/javascript"),
    ("mk3d", "video/x-matroska"),
    ("mka", "audio/x-matroska"),
    ("mkd", "text/x-markdown"),
    ("mks", "video/x-matroska"),
    ("mkv", "video/x-matroska"),
    ("mlp", "application/vnd.dolby.mlp"),
    ("mmd", "application/vnd.chipnuts.karaoke-mmd"),
    ("mmf", "application/vnd.smaf"),
    ("mml", "text/mathml"),
    ("mmr", "image/vnd.fujixerox.edmics-mmr"),
    ("mng", "video/x-mng"),
    ("mny", "application/x-msmoney"),
    ("mobi", "application/x-mobipocket-ebook"),
    ("mods", "application/mods+xml"),
    ("mov", "video/quicktime"),
    ("movie", "video/x-sgi-movie"),
    ("mp2", "audio/mpeg"),
    ("mp21", "application/mp21"),
    ("mp2a", "audio/mpeg"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("mp4a", "audio/mp4"),
    ("mp4s", "application/mp4"),
    ("mp4v", "video/mp4"),
    ("mpc", "application/vnd.mophun.certificate"),
    ("mpd", "application/dash+xml"),
    ("mpe", "video/mpeg"),
    ("mpeg", "video/mpeg"),
    ("mpg", "video/mpeg"),
    ("mpg4", "video/mp4"),
    ("mpga", "audio/mpeg"),
    ("mpkg", "application/vnd.apple.installer+xml"),
    ("mpm", "application/vnd.blueice.multipass"),
    ("mpn", "application/vnd.mophun.application"),
    ("mpp", "application/vnd.ms-project"),
    ("mpt", "application/vnd.ms-project"),
    ("mpy", "application/vnd.ibm.minipay"),
    ("mqy", "application/vnd.mobius.mqy"),
    ("mrc", "application/marc"),
    ("mrcx", "application/marcxml+xml"),
    ("ms", "text/troff"),
    ("mscml", "application/mediaservercontrol+xml"),
    ("mseed", "application/vnd.fdsn.mseed"),
    ("mseq", "application/vnd.mseq"),
    ("msf", "application/vnd.epson.msf"),
    ("msg", "application/vnd.ms-outlook"),
    ("msh", "model/mesh"),
    ("msi", "application/octet-stream"),
    ("msl", "application/vnd.mobius.msl"),
    ("msm", "application/octet-stream"),
    ("msp", "application/octet-stream"),
    ("msty", "application/vnd.muvee.style"),
    ("mts", "model/vnd.mts"),
    ("mus", "application/vnd.musician"),
    ("musicxml", "application/vnd.recordare.musicxml+xml"),
    ("mvb", "application/x-msmediaview"),
    ("mwf", "application/vnd.mfer"),
    ("mxf", "application/mxf"),
    ("mxl", "application/vnd.recordare.musicxml"),
    ("mxml", "application/xv+xml"),
    ("mxs", "application/vnd.triscape.mxs"),
    ("mxu", "video/vnd.mpegurl"),
    ("n-gage", "application/vnd.nokia.n-gage.symbian.install"),
    ("n3", "text/n3"),
    ("nb", "application/mathematica"),
    ("nbp", "application/vnd.wolfram.player"),
    ("nc", "application/x-netcdf"),
    ("ncx", "application/x-dtbncx+xml"),
    ("nfo", "text/x-nfo"),
    ("ngdat", "application/vnd.nokia.n-gage.data"),
    ("nitf", "application/vnd.nitf"),
    ("nlu", "application/vnd.neurolanguage.nlu"),
    ("nml", "application/vnd.enliven"),
    ("nnd", "application/vnd.noblenet-directory"),
    ("nns", "application/vnd.noblenet-sealer"),
    ("nnw", "application/vnd.noblenet-web"),
    ("npx", "image/vnd.net-fpx"),
    ("nsc", "application/x-conference"),
    ("nsf", "application/vnd.lotus-notes"),
    ("ntf", "application/vnd.nitf"),
    ("nzb", "application/x-nzb"),
    ("oa2", "application/vnd.fujitsu.oasys2"),
    ("oa3", "application/vnd.fujitsu.oasys3"),
    ("oas", "application/vnd.fujitsu.oasys"),
    ("obd", "application/x-msbinder"),
    ("obj", "application/x-tgif"),
    ("oda", "application/oda"),
    ("odb", "application/vnd.oasis.opendocument.database"),
    ("odc", "application/vnd.oasis.opendocument.chart"),
    ("odf", "application/vnd.oasis.opendocument.formula"),
    (
        "odft",
        "application/vnd.oasis.opendocument.formula-template",
    ),
    ("odg", "application/vnd.oasis.opendocument.graphics"),
    ("odi", "application/vnd.oasis.opendocument.image"),
    ("odm", "application/vnd.oasis.opendocument.text-master"),
    ("odp", "application/vnd.oasis.opendocument.presentation"),
    ("ods", "application/vnd.oasis.opendocument.spreadsheet"),
    ("odt", "application/vnd.oasis.opendocument.text"),
    ("oga", "audio/ogg"),
    ("ogg", "audio/ogg"),
    ("ogv", "video/ogg"),
    ("ogx", "application/ogg"),
    ("omdoc", "application/omdoc+xml"),
    ("onepkg", "application/onenote"),
    ("onetmp", "application/onenote"),
    ("onetoc", "application/onenote"),
    ("onetoc2", "application/onenote"),
    ("opf", "application/oebps-package+xml"),
    ("opml", "text/x-opml"),
    ("oprc", "application/vnd.palm"),
    ("org", "application/vnd.lotus-organizer"),
    ("osf", "application/vnd.yamaha.openscoreformat"),
    (
        "osfpvg",
        "application/vnd.yamaha.openscoreformat.osfpvg+xml",
    ),
    ("otc", "application/vnd.oasis.opendocument.chart-template"),
    ("otf", "font/otf"),
    (
        "otg",
        "application/vnd.oasis.opendocument.graphics-template",
    ),
    ("oth", "application/vnd.oasis.opendocument.text-web"),
    ("oti", "application/vnd.oasis.opendocument.image-template"),
    (
        "otp",
        "application/vnd.oasis.opendocument.presentation-template",
    ),
    (
        "ots",
        "application/vnd.oasis.opendocument.spreadsheet-template",
    ),
    ("ott", "application/vnd.oasis.opendocument.text-template"),
    ("ova", "application/x-virtualbox-ova"),
    ("ovf", "application/x-virtualbox-ovf"),
    ("oxps", "application/oxps"),
    ("oxt", "application/vnd.openofficeorg.extension"),
    ("p", "text/x-pascal"),
    ("p10", "application/pkcs10"),
    ("p12", "application/x-pkcs12"),
    ("p7b", "application/x-pkcs7-certificates"),
    ("p7c", "application/pkcs7-mime"),
    ("p7m", "application/pkcs7-mime"),
    ("p7r", "application/x-pkcs7-certreqresp"),
    ("p7s", "application/pkcs7-signature"),
    ("p8", "application/pkcs8"),
    ("pac", "application/x-ns-proxy-autoconfig"),
    ("pas", "text/x-pascal"),
    ("paw", "application/vnd.pawaafile"),
    ("pbd", "application/vnd.powerbuilder6"),
    ("pbm", "image/x-portable-bitmap"),
    ("pcap", "application/vnd.tcpdump.pcap"),
    ("pcf", "application/x-font-pcf"),
    ("pcl", "application/vnd.hp-pcl"),
    ("pclxl", "application/vnd.hp-pclxl"),
    ("pct", "image/x-pict"),
    ("pcurl", "application/vnd.curl.pcurl"),
    ("pcx", "image/x-pcx"),
    ("pdb", "application/vnd.palm"),
    ("pde", "text/x-processing"),
    ("pdf", "application/pdf"),
    ("pem", "application/x-x509-ca-cert"),
    ("pfa", "application/x-font-type1"),
    ("pfb", "application/x-font-type1"),
    ("pfm", "application/x-font-type1"),
    ("pfr", "application/font-tdpfr"),
    ("pfx", "application/x-pkcs12"),
    ("pgm", "image/x-portable-graymap"),
    ("pgn", "application/x-chess-pgn"),
    ("pgp", "application/pgp-encrypted"),
    ("php", "application/x-httpd-php"),
    ("pic", "image/x-pict"),
    ("pkg", "application/octet-stream"),
    ("pki", "application/pkixcmp"),
    ("pkipath", "application/pkix-pkipath"),
    ("pkpass", "application/vnd.apple.pkpass"),
    ("pl", "application/x-perl"),
    ("plb", "application/vnd.3gpp.pic-bw-large"),
    ("plc", "application/vnd.mobius.plc"),
    ("plf", "application/vnd.pocketlearn"),
    ("pls", "application/pls+xml"),
    ("pm", "application/x-perl"),
    ("pml", "application/vnd.ctc-posml"),
    ("png", "image/png"),
    ("pnm", "image/x-portable-anymap"),
    ("portpkg", "application/vnd.macports.portpkg"),
    ("pot", "application/vnd.ms-powerpoint"),
    (
        "potm",
        "application/vnd.ms-powerpoint.template.macroenabled.12",
    ),
    (
        "potx",
        "application/vnd.openxmlformats-officedocument.presentationml.template",
    ),
    (
        "ppam",
        "application/vnd.ms-powerpoint.addin.macroenabled.12",
    ),
    ("ppd", "application/vnd.cups-ppd"),
    ("ppm", "image/x-portable-pixmap"),
    ("pps", "application/vnd.ms-powerpoint"),
    (
        "ppsm",
        "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    ),
    (
        "ppsx",
        "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ),
    ("ppt", "application/vnd.ms-powerpoint"),
    (
        "pptm",
        "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    ),
    (
        "pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    ("pqa", "application/vnd.palm"),
    ("prc", "application/x-mobipocket-ebook"),
    ("pre", "application/vnd.lotus-freelance"),
    ("prf", "application/pics-rules"),
    ("ps", "application/postscript"),
    ("psb", "application/vnd.3gpp.pic-bw-small"),
    ("psd", "image/vnd.adobe.photoshop"),
    ("psf", "application/x-font-linux-psf"),
    ("pskcxml", "application/pskc+xml"),
    ("ptid", "application/vnd.pvi.ptid1"),
    ("pub", "application/x-mspublisher"),
    ("pvb", "application/vnd.3gpp.pic-bw-var"),
    ("pwn", "application/vnd.3m.post-it-notes"),
    ("pya", "audio/vnd.ms-playready.media.pya"),
    ("pyv", "video/vnd.ms-playready.media.pyv"),
    ("qam", "application/vnd.epson.quickanime"),
    ("qbo", "application/vnd.intu.qbo"),
    ("qfx", "application/vnd.intu.qfx"),
    ("qps", "application/vnd.publishare-delta-tree"),
    ("qt", "video/quicktime"),
    ("qwd", "application/vnd.quark.quarkxpress"),
    ("qwt", "application/vnd.quark.quarkxpress"),
    ("qxb", "application/vnd.quark.quarkxpress"),
    ("qxd", "application/vnd.quark.quarkxpress"),
    ("qxl", "application/vnd.quark.quarkxpress"),
    ("qxt", "application/vnd.quark.quarkxpress"),
    ("ra", "audio/x-pn-realaudio"),
    ("ram", "audio/x-pn-realaudio"),
    ("raml", "application/raml+yaml"),
    ("rar", "application/x-rar-compressed"),
    ("ras", "image/x-cmu-raster"),
    ("rcprofile", "application/vnd.ipunplugged.rcprofile"),
    ("rdf", "application/rdf+xml"),
    ("rdz", "application/vnd.data-vision.rdz"),
    ("rep", "application/vnd.businessobjects"),
    ("res", "application/x-dtbresource+xml"),
    ("rgb", "image/x-rgb"),
    ("rif", "application/reginfo+xml"),
    ("rip", "audio/vnd.rip"),
    ("ris", "application/x-research-info-systems"),
    ("rl", "application/resource-lists+xml"),
    ("rlc", "image/vnd.fujixerox.edmics-rlc"),
    ("rld", "application/resource-lists-diff+xml"),
    ("rm", "application/vnd.rn-realmedia"),
    ("rmi", "audio/midi"),
    ("rmp", "audio/x-pn-realaudio-plugin"),
    ("rms", "application/vnd.jcp.javame.midlet-rms"),
    ("rmvb", "application/vnd.rn-realmedia-vbr"),
    ("rnc", "application/relax-ng-compact-syntax"),
    ("rng", "application/xml"),
    ("roa", "application/rpki-roa"),
    ("roff", "text/troff"),
    ("rp9", "application/vnd.cloanto.rp9"),
    ("rpm", "application/x-redhat-package-manager"),
    ("rpss", "application/vnd.nokia.radio-presets"),
    ("rpst", "application/vnd.nokia.radio-preset"),
    ("rq", "application/sparql-query"),
    ("rs", "application/rls-services+xml"),
    ("rsd", "application/rsd+xml"),
    ("rss", "application/rss+xml"),
    ("rtf", "application/rtf"),
    ("rtx", "text/richtext"),
    ("run", "application/x-makeself"),
    ("s", "text/x-asm"),
    ("s3m", "audio/s3m"),
    ("saf", "application/vnd.yamaha.smaf-audio"),
    ("sass", "text/x-sass"),
    ("sbml", "application/sbml+xml"),
    ("sc", "application/vnd.ibm.secure-container"),
    ("scd", "application/x-msschedule"),
    ("scm", "application/vnd.lotus-screencam"),
    ("scq", "application/scvp-cv-request"),
    ("scs", "application/scvp-cv-response"),
    ("scss", "text/x-scss"),
    ("scurl", "text/vnd.curl.scurl"),
    ("sda", "application/vnd.stardivision.draw"),
    ("sdc", "application/vnd.stardivision.calc"),
    ("sdd", "application/vnd.stardivision.impress"),
    ("sdkd", "application/vnd.solent.sdkm+xml"),
    ("sdkm", "application/vnd.solent.sdkm+xml"),
    ("sdp", "application/sdp"),
    ("sdw", "application/vnd.stardivision.writer"),
    ("sea", "application/x-sea"),
    ("see", "application/vnd.seemail"),
    ("seed", "application/vnd.fdsn.seed"),
    ("sema", "application/vnd.sema"),
    ("semd", "application/vnd.semd"),
    ("semf", "application/vnd.semf"),
    ("ser", "application/java-serialized-object"),
    ("setpay", "application/set-payment-initiation"),
    ("setreg", "application/set-registration-initiation"),
    ("sfd-hdstx", "application/vnd.hydrostatix.sof-data"),
    ("sfs", "application/vnd.spotfire.sfs"),
    ("sfv", "text/x-sfv"),
    ("sgi", "image/sgi"),
    ("sgl", "application/vnd.stardivision.writer-global"),
    ("sgm", "text/sgml"),
    ("sgml", "text/sgml"),
    ("sh", "application/x-sh"),
    ("shar", "application/x-shar"),
    ("shf", "application/shf+xml"),
    ("shtml", "text/html"),
    ("sid", "image/x-mrsid-image"),
    ("sig", "application/pgp-signature"),
    ("sil", "audio/silk"),
    ("silo", "model/mesh"),
    ("sis", "application/vnd.symbian.install"),
    ("sisx", "application/vnd.symbian.install"),
    ("sit", "application/x-stuffit"),
    ("sitx", "application/x-stuffitx"),
    ("skd", "application/vnd.koan"),
    ("skm", "application/vnd.koan"),
    ("skp", "application/vnd.koan"),
    ("skt", "application/vnd.koan"),
    (
        "sldm",
        "application/vnd.ms-powerpoint.slide.macroenabled.12",
    ),
    (
        "sldx",
        "application/vnd.openxmlformats-officedocument.presentationml.slide",
    ),
    ("slim", "text/slim"),
    ("slm", "text/slim"),
    ("slt", "application/vnd.epson.salt"),
    ("sm", "application/vnd.stepmania.stepchart"),
    ("smf", "application/vnd.stardivision.math"),
    ("smi", "application/smil+xml"),
    ("smil", "application/smil+xml"),
    ("smv", "video/x-smv"),
    ("smzip", "application/vnd.stepmania.package"),
    ("snd", "audio/basic"),
    ("snf", "application/x-font-snf"),
    ("so", "application/octet-stream"),
    ("spc", "application/x-pkcs7-certificates"),
    ("spf", "application/vnd.yamaha.smaf-phrase"),
    ("spl", "application/x-futuresplash"),
    ("spot", "text/vnd.in3d.spot"),
    ("spp", "application/scvp-vp-response"),
    ("spq", "application/scvp-vp-request"),
    ("spx", "audio/ogg"),
    ("sql", "application/x-sql"),
    ("src", "application/x-wais-source"),
    ("srt", "application/x-subrip"),
    ("sru", "application/sru+xml"),
    ("srx", "application/sparql-results+xml"),
    ("ssdl", "application/ssdl+xml"),
    ("sse", "application/vnd.kodak-descriptor"),
    ("ssf", "application/vnd.epson.ssf"),
    ("ssml", "application/ssml+xml"),
    ("st", "application/vnd.sailingtracker.track"),
    ("stc", "application/vnd.sun.xml.calc.template"),
    ("std", "application/vnd.sun.xml.draw.template"),
    ("stf", "application/vnd.wt.stf"),
    ("sti", "application/vnd.sun.xml.impress.template"),
    ("stk", "application/hyperstudio"),
    ("stl", "application/vnd.ms-pki.stl"),
    ("str", "application/vnd.pg.format"),
    ("stw", "application/vnd.sun.xml.writer.template"),
    ("styl", "text/stylus"),
    ("stylus", "text/stylus"),
    ("sub", "text/vnd.dvb.subtitle"),
    ("sus", "application/vnd.sus-calendar"),
    ("susp", "application/vnd.sus-calendar"),
    ("sv4cpio", "application/x-sv4cpio"),
    ("sv4crc", "application/x-sv4crc"),
    ("svc", "application/vnd.dvb.service"),
    ("svd", "application/vnd.svd"),
    ("svg", "image/svg+xml"),
    ("svgz", "image/svg+xml"),
    ("swa", "application/x-director"),
    ("swf", "application/x-shockwave-flash"),
    ("swi", "application/vnd.aristanetworks.swi"),
    ("sxc", "application/vnd.sun.xml.calc"),
    ("sxd", "application/vnd.sun.xml.draw"),
    ("sxg", "application/vnd.sun.xml.writer.global"),
    ("sxi", "application/vnd.sun.xml.impress"),
    ("sxm", "application/vnd.sun.xml.math"),
    ("sxw", "application/vnd.sun.xml.writer"),
    ("t", "text/troff"),
    ("t3", "application/x-t3vm-image"),
    ("taglet", "application/vnd.mynfc"),
    ("tao", "application/vnd.tao.intent-module-archive"),
    ("tar", "application/x-tar"),
    ("tcap", "application/vnd.3gpp2.tcap"),
    ("tcl", "application/x-tcl"),
    ("teacher", "application/vnd.smart.teacher"),
    ("tei", "application/tei+xml"),
    ("teicorpus", "application/tei+xml"),
    ("tex", "application/x-tex"),
    ("texi", "application/x-texinfo"),
    ("texinfo", "application/x-texinfo"),
    ("text", "text/plain"),
    ("tfi", "application/thraud+xml"),
    ("tfm", "application/x-tex-tfm"),
    ("tga", "image/x-tga"),
    ("thmx", "application/vnd.ms-officetheme"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("tk", "application/x-tcl"),
    ("tmo", "application/vnd.tmobile-livetv"),
    ("torrent", "application/x-bittorrent"),
    ("tpl", "application/vnd.groove-tool-template"),
    ("tpt", "application/vnd.trid.tpt"),
    ("tr", "text/troff"),
    ("tra", "application/vnd.trueapp"),
    ("trm", "application/x-msterminal"),
    ("ts", "video/mp2t"),
    ("tsd", "application/timestamped-data"),
    ("tsv", "text/tab-separated-values"),
    ("ttc", "font/collection"),
    ("ttf", "font/ttf"),
    ("ttl", "text/turtle"),
    ("twd", "application/vnd.simtech-mindmapper"),
    ("twds", "application/vnd.simtech-mindmapper"),
    ("txd", "application/vnd.genomatix.tuxedo"),
    ("txf", "application/vnd.mobius.txf"),
    ("txt", "text/plain"),
    ("u32", "application/x-authorware-bin"),
    ("udeb", "application/x-debian-package"),
    ("ufd", "application/vnd.ufdl"),
    ("ufdl", "application/vnd.ufdl"),
    ("ulx", "application/x-glulx"),
    ("umj", "application/vnd.umajin"),
    ("unityweb", "application/vnd.unity"),
    ("uoml", "application/vnd.uoml+xml"),
    ("uri", "text/uri-list"),
    ("uris", "text/uri-list"),
    ("urls", "text/uri-list"),
    ("ustar", "application/x-ustar"),
    ("utz", "application/vnd.uiq.theme"),
    ("uu", "text/x-uuencode"),
    ("uva", "audio/vnd.dece.audio"),
    ("uvd", "application/vnd.dece.data"),
    ("uvf", "application/vnd.dece.data"),
    ("uvg", "image/vnd.dece.graphic"),
    ("uvh", "video/vnd.dece.hd"),
    ("uvi", "image/vnd.dece.graphic"),
    ("uvm", "video/vnd.dece.mobile"),
    ("uvp", "video/vnd.dece.pd"),
    ("uvs", "video/vnd.dece.sd"),
    ("uvt", "application/vnd.dece.ttml+xml"),
    ("uvu", "video/vnd.uvvu.mp4"),
    ("uvv", "video/vnd.dece.video"),
    ("uvva", "audio/vnd.dece.audio"),
    ("uvvd", "application/vnd.dece.data"),
    ("uvvf", "application/vnd.dece.data"),
    ("uvvg", "image/vnd.dece.graphic"),
    ("uvvh", "video/vnd.dece.hd"),
    ("uvvi", "image/vnd.dece.graphic"),
    ("uvvm", "video/vnd.dece.mobile"),
    ("uvvp", "video/vnd.dece.pd"),
    ("uvvs", "video/vnd.dece.sd"),
    ("uvvt", "application/vnd.dece.ttml+xml"),
    ("uvvu", "video/vnd.uvvu.mp4"),
    ("uvvv", "video/vnd.dece.video"),
    ("uvvx", "application/vnd.dece.unspecified"),
    ("uvvz", "application/vnd.dece.zip"),
    ("uvx", "application/vnd.dece.unspecified"),
    ("uvz", "application/vnd.dece.zip"),
    ("vbox", "application/x-virtualbox-vbox"),
    ("vbox-extpack", "application/x-virtualbox-vbox-extpack"),
    ("vcard", "text/vcard"),
    ("vcd", "application/x-cdlink"),
    ("vcf", "text/x-vcard"),
    ("vcg", "application/vnd.groove-vcard"),
    ("vcs", "text/x-vcalendar"),
    ("vcx", "application/vnd.vcx"),
    ("vdi", "application/x-virtualbox-vdi"),
    ("vhd", "application/x-virtualbox-vhd"),
    ("vis", "application/vnd.visionary"),
    ("viv", "video/vnd.vivo"),
    ("vmdk", "application/x-virtualbox-vmdk"),
    ("vob", "video/x-ms-vob"),
    ("vor", "application/vnd.stardivision.writer"),
    ("vox", "application/x-authorware-bin"),
    ("vrml", "model/vrml"),
    ("vsd", "application/vnd.visio"),
    ("vsf", "application/vnd.vsf"),
    ("vss", "application/vnd.visio"),
    ("vst", "application/vnd.visio"),
    ("vsw", "application/vnd.visio"),
    ("vtt", "text/vtt"),
    ("vtu", "model/vnd.vtu"),
    ("vxml", "application/voicexml+xml"),
    ("w3d", "application/x-director"),
    ("wad", "application/x-doom"),
    ("wadl", "application/vnd.sun.wadl+xml"),
    ("war", "application/java-archive"),
    ("wasm", "application/wasm"),
    ("wav", "audio/wav"),
    ("wax", "audio/x-ms-wax"),
    ("wbmp", "image/vnd.wap.wbmp"),
    ("wbs", "application/vnd.criticaltools.wbs+xml"),
    ("wbxml", "application/vnd.wap.wbxml"),
    ("wcm", "application/vnd.ms-works"),
    ("wdb", "application/vnd.ms-works"),
    ("wdp", "image/vnd.ms-photo"),
    ("weba", "audio/webm"),
    ("webapp", "application/x-web-app-manifest+json"),
    ("webm", "video/webm"),
    ("webmanifest", "application/manifest+json"),
    ("webp", "image/webp"),
    ("wg", "application/vnd.pmi.widget"),
    ("wgt", "application/widget"),
    ("wks", "application/vnd.ms-works"),
    ("wm", "video/x-ms-wm"),
    ("wma", "audio/x-ms-wma"),
    ("wmd", "application/x-ms-wmd"),
    ("wmf", "application/x-msmetafile"),
    ("wml", "text/vnd.wap.wml"),
    ("wmlc", "application/vnd.wap.wmlc"),
    ("wmls", "text/vnd.wap.wmlscript"),
    ("wmlsc", "application/vnd.wap.wmlscriptc"),
    ("wmv", "video/x-ms-wmv"),
    ("wmx", "video/x-ms-wmx"),
    ("wmz", "application/x-ms-wmz"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("wpd", "application/vnd.wordperfect"),
    ("wpl", "application/vnd.ms-wpl"),
    ("wps", "application/vnd.ms-works"),
    ("wqd", "application/vnd.wqd"),
    ("wri", "application/x-mswrite"),
    ("wrl", "model/vrml"),
    ("wsdl", "application/wsdl+xml"),
    ("wspolicy", "application/wspolicy+xml"),
    ("wtb", "application/vnd.webturbo"),
    ("wvx", "video/x-ms-wvx"),
    ("x32", "application/x-authorware-bin"),
    ("x3d", "model/x3d+xml"),
    ("x3db", "model/x3d+binary"),
    ("x3dbz", "model/x3d+binary"),
    ("x3dv", "model/x3d+vrml"),
    ("x3dvz", "model/x3d+vrml"),
    ("x3dz", "model/x3d+xml"),
    ("xaml", "application/xaml+xml"),
    ("xap", "application/x-silverlight-app"),
    ("xar", "application/vnd.xara"),
    ("xbap", "application/x-ms-xbap"),
    ("xbd", "application/vnd.fujixerox.docuworks.binder"),
    ("xbm", "image/x-xbitmap"),
    ("xdf", "application/xcap-diff+xml"),
    ("xdm", "application/vnd.syncml.dm+xml"),
    ("xdp", "application/vnd.adobe.xdp+xml"),
    ("xdssc", "application/dssc+xml"),
    ("xdw", "application/vnd.fujixerox.docuworks"),
    ("xenc", "application/xenc+xml"),
    ("xer", "application/patch-ops-error+xml"),
    ("xfdf", "application/vnd.adobe.xfdf"),
    ("xfdl", "application/vnd.xfdl"),
    ("xht", "application/xhtml+xml"),
    ("xhtml", "application/xhtml+xml"),
    ("xhvml", "application/xv+xml"),
    ("xif", "image/vnd.xiff"),
    ("xla", "application/vnd.ms-excel"),
    ("xlam", "application/vnd.ms-excel.addin.macroenabled.12"),
    ("xlc", "application/vnd.ms-excel"),
    ("xlf", "application/x-xliff+xml"),
    ("xlm", "application/vnd.ms-excel"),
    ("xls", "application/vnd.ms-excel"),
    (
        "xlsb",
        "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    ),
    ("xlsm", "application/vnd.ms-excel.sheet.macroenabled.12"),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    ("xlt", "application/vnd.ms-excel"),
    ("xltm", "application/vnd.ms-excel.template.macroenabled.12"),
    (
        "xltx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    ),
    ("xlw", "application/vnd.ms-excel"),
    ("xm", "audio/xm"),
    ("xml", "application/xml"),
    ("xo", "application/vnd.olpc-sugar"),
    ("xop", "application/xop+xml"),
    ("xpi", "application/x-xpinstall"),
    ("xpl", "application/xproc+xml"),
    ("xpm", "image/x-xpixmap"),
    ("xpr", "application/vnd.is-xpr"),
    ("xps", "application/vnd.ms-xpsdocument"),
    ("xpw", "application/vnd.intercon.formnet"),
    ("xpx", "application/vnd.intercon.formnet"),
    ("xsd", "application/xml"),
    ("xsl", "application/xml"),
    ("xslt", "application/xslt+xml"),
    ("xsm", "application/vnd.syncml+xml"),
    ("xspf", "application/xspf+xml"),
    ("xul", "application/vnd.mozilla.xul+xml"),
    ("xvm", "application/xv+xml"),
    ("xvml", "application/xv+xml"),
    ("xwd", "image/x-xwindowdump"),
    ("xyz", "chemical/x-xyz"),
    ("xz", "application/x-xz"),
    ("yaml", "text/yaml"),
    ("yang", "application/yang"),
    ("yin", "application/yin+xml"),
    ("yml", "text/yaml"),
    ("ymp", "text/x-suse-ymp"),
    ("z1", "application/x-zmachine"),
    ("z2", "application/x-zmachine"),
    ("z3", "application/x-zmachine"),
    ("z4", "application/x-zmachine"),
    ("z5", "application/x-zmachine"),
    ("z6", "application/x-zmachine"),
    ("z7", "application/x-zmachine"),
    ("z8", "application/x-zmachine"),
    ("zaz", "application/vnd.zzazz.deck+xml"),
    ("zip", "application/zip"),
    ("zir", "application/vnd.zul"),
    ("zirz", "application/vnd.zul"),
    ("zmm", "application/vnd.handheld-entertainment+xml"),
];

fn mime_lookup(ext: &str) -> &'static str {
    match MIME_TYPES.binary_search_by(|probe| probe.0.cmp(ext)) {
        Ok(index) => MIME_TYPES[index].1,
        Err(_) => DEFAULT_MIME,
    }
}

/// mime 1.6.0 `mime.lookup(path)`.
pub fn mime_type(path: &str) -> &'static str {
    mime_lookup(&mime_extension(path))
}

/// send 0.19.2 `SendStream.prototype.type()`: media type plus
/// `'; charset=UTF-8'` when `mime.charsets.lookup` says so.
pub fn content_type(path: &str) -> String {
    let media_type = mime_type(path);
    let needs_charset = media_type.starts_with("text/")
        || media_type.starts_with("application/javascript")
        || media_type.starts_with("application/json");
    if needs_charset {
        format!("{media_type}; charset=UTF-8")
    } else {
        media_type.to_string()
    }
}

// ---------------------------------------------------------------------------
// Content-Disposition (content-disposition 0.5.4)
// ---------------------------------------------------------------------------

/// A path separator for this platform's `path` module: `/`, and on win32
/// also `\\` (`path.basename` accepts both; `path.normalize` turns `/` into
/// `\\` before send splits on `path.sep`).
fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `path.basename` (the absolute paths the route hands over carry no drive
/// letter edge cases on win32 beyond the separators).
fn posix_basename(path: &str) -> &str {
    if path.is_empty() {
        return "";
    }
    let trimmed = path.trim_end_matches(is_separator);
    if trimmed.is_empty() {
        // `path.basename("/")` is "", not "/".
        return "";
    }
    match trimmed.rfind(is_separator) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// `TEXT_REGEXP = /^[\x20-\x7e\x80-\xff]+$/` — safe inside a quoted string.
fn is_text(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| matches!(c, '\u{20}'..='\u{7e}' | '\u{80}'..='\u{ff}'))
}

/// `getlatin1`: replaces every code unit outside `[\x20-\x7e\xa0-\xff]` with `?`.
///
/// Operates per UTF-16 code unit, so a non-BMP character becomes two `?`.
fn latin1_fallback(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\u{20}'..='\u{7e}' | '\u{a0}'..='\u{ff}') {
            out.push(c);
        } else {
            out.push('?');
            if (c as u32) > 0xffff {
                out.push('?');
            }
        }
    }
    out
}

/// `HEX_ESCAPE_REGEXP = /%[0-9A-Fa-f]{2}/`
fn has_hex_escape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes
        .windows(3)
        .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
}

/// `qstring`: double quote the value, backslash-escaping `\` and `"`.
fn qstring(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// `encodeURIComponent`'s unreserved set.
fn uri_component_unreserved(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
}

/// `ustring`: RFC 5987 UTF-8 percent encoding.
fn ustring(value: &str) -> String {
    let mut out = String::from("UTF-8''");
    for c in value.chars() {
        if uri_component_unreserved(c) && !matches!(c, '*' | '\'' | '(' | ')') {
            out.push(c);
            continue;
        }
        let mut buf = [0u8; 4];
        for byte in c.encode_utf8(&mut buf).as_bytes() {
            out.push('%');
            out.push(
                char::from_digit(u32::from(*byte) >> 4, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
            out.push(
                char::from_digit(u32::from(*byte) & 0xf, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
        }
    }
    out
}

/// `contentDisposition(path, {type: 'attachment', fallback: true})` — the exact
/// Express `res.download()` call — as the bytes Node writes on the wire
/// (latin1, one byte per code unit).
pub fn attachment_disposition(path: &str) -> Vec<u8> {
    let name = posix_basename(path);
    let quoted = is_text(name);
    let fallback_name = latin1_fallback(name);
    let has_fallback = fallback_name != name;

    let mut header = String::from("attachment");
    // Object.keys(params).sort(): "filename" sorts before "filename*".
    if quoted || has_fallback {
        let value = if has_fallback { &fallback_name } else { name };
        header.push_str("; filename=");
        header.push_str(&qstring(value));
    }
    if has_fallback || !quoted || has_hex_escape(name) {
        header.push_str("; filename*=");
        header.push_str(&ustring(name));
    }
    header.chars().map(|c| c as u32 as u8).collect()
}

// ---------------------------------------------------------------------------
// Response planning
// ---------------------------------------------------------------------------

/// One header exactly as Node would write it on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    /// Header name, spelled as send / Express spell it.
    pub name: String,
    /// Header value bytes (latin1; one byte per JS code unit).
    pub value: Vec<u8>,
}

impl Header {
    fn new(name: &str, value: &str) -> Self {
        Header {
            name: name.to_string(),
            value: value.as_bytes().to_vec(),
        }
    }

    fn bytes(name: &str, value: Vec<u8>) -> Self {
        Header {
            name: name.to_string(),
            value,
        }
    }
}

/// Everything the caller needs to write the response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendPlan {
    /// A 200 (whole file) or 206 (single range) response.
    ///
    /// Stream `content_length` bytes starting at `start`; `end` is the inclusive
    /// last byte offset and equals `start` when `content_length` is 0. When
    /// `head_only` is set (request method `HEAD`) the headers are written with
    /// no body.
    File {
        status: u16,
        headers: Vec<Header>,
        start: u64,
        end: u64,
        content_length: u64,
        head_only: bool,
    },
    /// A 304 response: the headers after `removeContentHeaderFields`, no body.
    NotModified { status: u16, headers: Vec<Header> },
    /// `send` raised an error: the ordered headers already set on `res` at that
    /// moment (for a 416 this includes `Content-Range: bytes */<size>`). The
    /// caller's Express error handler writes the JSON body and may overwrite
    /// `Content-Type` / set `Content-Length` / `ETag`.
    Error { status: u16, headers: Vec<Header> },
}

/// Truthiness of a JS header value (the empty string is falsy).
fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// `parseTokenList` from send 0.19.2 (drops empty tokens).
fn parse_token_list_send(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let (mut start, mut end) = (0usize, 0usize);
    let mut list = Vec::new();
    for (i, byte) in bytes.iter().enumerate() {
        match byte {
            0x20 => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            0x2c => {
                if start != end {
                    list.push(&value[start..end]);
                }
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    if start != end {
        list.push(&value[start..end]);
    }
    list
}

/// `parseTokenList` from fresh 0.5.2 (keeps empty tokens).
fn parse_token_list_fresh(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let (mut start, mut end) = (0usize, 0usize);
    let mut list = Vec::new();
    for (i, byte) in bytes.iter().enumerate() {
        match byte {
            0x20 => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            0x2c => {
                list.push(&value[start..end]);
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    list.push(&value[start..end]);
    list
}

/// send 0.19.2 `isPreconditionFailure` (the response ETag is always present).
fn precondition_failure_with(
    if_match: Option<&str>,
    unmodified_since: Option<&str>,
    etag_value: &str,
    last_modified: &str,
) -> bool {
    if let Some(match_value) = if_match {
        if match_value == "*" {
            return false;
        }
        let weak = format!("W/{etag_value}");
        return parse_token_list_send(match_value).iter().all(|token| {
            *token != etag_value && *token != weak && format!("W/{token}") != etag_value
        });
    }
    if let Some(since) = unmodified_since {
        if let Some(unmodified_since_ms) = parse_http_date(since) {
            let last_modified_ms = parse_http_date(last_modified).unwrap_or(f64::NAN);
            return last_modified_ms.is_nan() || last_modified_ms > unmodified_since_ms;
        }
    }
    false
}

/// fresh 0.5.2 `fresh()`.
fn is_fresh(
    modified_since: Option<&str>,
    none_match: Option<&str>,
    cache_control: Option<&str>,
    etag_value: &str,
    last_modified: &str,
) -> bool {
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if let Some(cache_control) = cache_control {
        if has_no_cache(cache_control) {
            return false;
        }
    }
    if let Some(none_match) = none_match {
        if none_match != "*" {
            let weak = format!("W/{etag_value}");
            let matched = parse_token_list_fresh(none_match).iter().any(|token| {
                *token == etag_value || *token == weak || format!("W/{token}") == etag_value
            });
            if !matched {
                return false;
            }
        }
    }
    if let Some(modified_since) = modified_since {
        let fresh = match (
            parse_http_date(last_modified),
            parse_http_date(modified_since),
        ) {
            (Some(a), Some(b)) => a <= b,
            _ => false,
        };
        if !fresh {
            return false;
        }
    }
    true
}

/// `CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/`
fn has_no_cache(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let needle: Vec<char> = "no-cache".chars().collect();
    if chars.len() < needle.len() {
        return false;
    }
    for i in 0..=chars.len() - needle.len() {
        if chars[i..i + needle.len()] != needle[..] {
            continue;
        }
        let mut before = i;
        while before > 0 && js_whitespace(chars[before - 1]) {
            before -= 1;
        }
        if !(before == 0 || chars[before - 1] == ',') {
            continue;
        }
        let mut after = i + needle.len();
        while after < chars.len() && js_whitespace(chars[after]) {
            after += 1;
        }
        if after == chars.len() || chars[after] == ',' {
            return true;
        }
    }
    false
}

/// `parseInt(value, 10)`.
fn js_parse_int(value: &str) -> f64 {
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0usize;
    while i < chars.len() && js_whitespace(chars[i]) {
        i += 1;
    }
    let mut negative = false;
    if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
        negative = chars[i] == '-';
        i += 1;
    }
    let start = i;
    let mut result = 0.0f64;
    while i < chars.len() && chars[i].is_ascii_digit() {
        result = result * 10.0 + f64::from(chars[i] as u8 - b'0');
        i += 1;
    }
    if i == start {
        return f64::NAN;
    }
    if negative {
        -result
    } else {
        result
    }
}

/// A single satisfiable byte range, inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// Outcome of range-parser 1.2.1.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ParsedRange {
    /// `-1`
    Unsatisfiable,
    /// `-2`
    Invalid,
    Ranges(Vec<ByteRange>),
}

/// range-parser 1.2.1 `parseRange(size, str, {combine: true})`.
fn parse_range(size: f64, value: &str) -> ParsedRange {
    let index = match value.find('=') {
        Some(index) => index,
        None => return ParsedRange::Invalid,
    };
    let mut ranges: Vec<(f64, f64)> = Vec::new();
    for part in value[index + 1..].split(',') {
        let mut fields = part.split('-');
        let mut start = js_parse_int(fields.next().unwrap_or(""));
        let mut end = js_parse_int(fields.next().unwrap_or(""));
        if start.is_nan() {
            start = size - end;
            end = size - 1.0;
        } else if end.is_nan() {
            end = size - 1.0;
        }
        if end > size - 1.0 {
            end = size - 1.0;
        }
        if start.is_nan() || end.is_nan() || start > end || start < 0.0 {
            continue;
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return ParsedRange::Unsatisfiable;
    }

    // combineRanges: sort by start (stable), merge overlapping/adjacent, then
    // restore the original order.
    let mut ordered: Vec<(f64, f64, usize)> = ranges
        .iter()
        .enumerate()
        .map(|(index, &(start, end))| (start, end, index))
        .collect();
    ordered.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut j = 0usize;
    for i in 1..ordered.len() {
        let range = ordered[i];
        if range.0 > ordered[j].1 + 1.0 {
            j += 1;
            ordered[j] = range;
        } else if range.1 > ordered[j].1 {
            ordered[j].1 = range.1;
            ordered[j].2 = ordered[j].2.min(range.2);
        }
    }
    ordered.truncate(j + 1);
    ordered.sort_by_key(|range| range.2);

    ParsedRange::Ranges(
        ordered
            .into_iter()
            .map(|(start, end, _)| ByteRange {
                start: start as u64,
                end: end as u64,
            })
            .collect(),
    )
}

/// `BYTES_RANGE_REGEXP = /^ *bytes=/`
fn is_bytes_range(value: &str) -> bool {
    value.trim_start_matches(' ').starts_with("bytes=")
}

/// send 0.19.2 `isRangeFresh`.
fn is_range_fresh(if_range: Option<&str>, etag_value: &str, last_modified: &str) -> bool {
    let Some(if_range) = if_range else {
        return true;
    };
    if if_range.contains('"') {
        return if_range.contains(etag_value);
    }
    match (parse_http_date(last_modified), parse_http_date(if_range)) {
        (Some(a), Some(b)) => a <= b,
        _ => false,
    }
}

/// `removeContentHeaderFields`: strips exactly these five (Content-Location and
/// Content-Disposition survive).
fn is_content_header_field(name: &str) -> bool {
    matches!(
        name,
        "Content-Encoding"
            | "Content-Language"
            | "Content-Length"
            | "Content-Range"
            | "Content-Type"
    )
}

/// Reproduces the response `send` leaves on `res` for an already-resolved
/// absolute path to a regular file, `method` being the request method and
/// `header` a lower-case-name request-header lookup.
///
/// `attachment` selects Express `res.download()` (`true`), which injects
/// `Content-Disposition` through `send`'s `headers` event before `Accept-Ranges`.
pub fn plan(
    path: &str,
    stat: &FileStat,
    method: &str,
    header: &dyn Fn(&str) -> Option<String>,
    attachment: bool,
) -> SendPlan {
    // send's legacy dotfile branch with `root: null` and `hidden: false`:
    // only the last path part decides, and it yields `404` before any header.
    let last_part = match path.rfind(is_separator) {
        Some(index) => &path[index + 1..],
        None => path,
    };
    if last_part.len() > 1 && last_part.starts_with('.') {
        return SendPlan::Error {
            status: 404,
            headers: Vec::new(),
        };
    }

    let mtime = node_mtime(stat);
    let last_modified = utc_string(mtime);
    let etag_value = etag(stat);
    let media_type = content_type(path);

    let mut headers = Vec::new();
    if attachment {
        headers.push(Header::bytes(
            "Content-Disposition",
            attachment_disposition(path),
        ));
    }
    headers.push(Header::new("Accept-Ranges", "bytes"));
    headers.push(Header::new("Cache-Control", "public, max-age=0"));
    headers.push(Header::new("Last-Modified", &last_modified));
    headers.push(Header::new("ETag", &etag_value));
    headers.push(Header::new("Content-Type", &media_type));

    let if_match = header("if-match");
    let if_unmodified_since = header("if-unmodified-since");
    let if_none_match = header("if-none-match");
    let if_modified_since = header("if-modified-since");
    let if_range = header("if-range");
    let cache_control = header("cache-control");

    let conditional = truthy(if_match.as_ref()).is_some()
        || truthy(if_unmodified_since.as_ref()).is_some()
        || truthy(if_none_match.as_ref()).is_some()
        || truthy(if_modified_since.as_ref()).is_some();

    if conditional {
        if precondition_failure_with(
            truthy(if_match.as_ref()),
            truthy(if_unmodified_since.as_ref()),
            &etag_value,
            &last_modified,
        ) {
            return SendPlan::Error {
                status: 412,
                headers,
            };
        }
        // isCachable() is always true for the default 200 status.
        if is_fresh(
            truthy(if_modified_since.as_ref()),
            truthy(if_none_match.as_ref()),
            truthy(cache_control.as_ref()),
            &etag_value,
            &last_modified,
        ) {
            headers.retain(|field| !is_content_header_field(&field.name));
            return SendPlan::NotModified {
                status: 304,
                headers,
            };
        }
    }

    let mut status = 200u16;
    let mut start = 0u64;
    let mut len = stat.size;

    if let Some(range_header) = header("range").as_deref().filter(|v| !v.is_empty()) {
        if is_bytes_range(range_header) {
            let mut parsed = parse_range(len as f64, range_header);
            if !is_range_fresh(truthy(if_range.as_ref()), &etag_value, &last_modified) {
                parsed = ParsedRange::Invalid;
            }
            match parsed {
                ParsedRange::Unsatisfiable => {
                    headers.push(Header::new("Content-Range", &format!("bytes */{len}")));
                    return SendPlan::Error {
                        status: 416,
                        headers,
                    };
                }
                ParsedRange::Invalid => {}
                ParsedRange::Ranges(ranges) if ranges.len() == 1 => {
                    let range = ranges[0];
                    status = 206;
                    headers.push(Header::new(
                        "Content-Range",
                        &format!("bytes {}-{}/{}", range.start, range.end, len),
                    ));
                    start += range.start;
                    len = range.end - range.start + 1;
                }
                ParsedRange::Ranges(_) => {}
            }
        }
    }

    let end = start.max(start.saturating_add(len).saturating_sub(1));
    headers.push(Header::new("Content-Length", &len.to_string()));

    SendPlan::File {
        status,
        headers,
        start,
        end,
        content_length: len,
        head_only: method == "HEAD",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_headers(_: &str) -> Option<String> {
        None
    }

    fn header_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value.clone())
        }
    }

    fn expect_error(status: u16, headers: Vec<Header>) -> SendPlan {
        SendPlan::Error { status, headers }
    }

    // ---- FileStat ----

    #[test]
    fn mtime_rounds_half_up() {
        // 1699999999999.999 rounds up to 1700000000000 (Node's dateFromMs).
        let stat = FileStat {
            size: 1,
            mtime_ms: 1699999999999.999,
        };
        assert_eq!(node_mtime(&stat), 1_700_000_000_000.0);

        let stat = FileStat {
            size: 1,
            mtime_ms: 1699999999123.4,
        };
        assert_eq!(node_mtime(&stat), 1_699_999_999_123.0);

        let stat = FileStat {
            size: 1,
            mtime_ms: 1234567890000.0005,
        };
        assert_eq!(node_mtime(&stat), 1_234_567_890_000.0);

        let stat = FileStat {
            size: 1,
            mtime_ms: -2.5,
        };
        assert_eq!(
            node_mtime(&stat),
            -2.0,
            "JS Math.round ties toward +Infinity"
        );

        let stat = FileStat {
            size: 1,
            mtime_ms: f64::NAN,
        };
        assert!(node_mtime(&stat).is_nan());

        let stat = FileStat {
            size: 1,
            mtime_ms: 8.64e15 + 1.0,
        };
        assert!(node_mtime(&stat).is_nan());
    }

    #[test]
    fn etag_matches_node() {
        let stat = FileStat {
            size: 1000,
            mtime_ms: 1699999999123.4,
        };
        assert_eq!(etag(&stat), "W/\"3e8-18bcfe56493\"");
        let stat = FileStat {
            size: 0,
            mtime_ms: 1600000000500.0,
        };
        assert_eq!(etag(&stat), "W/\"0-174876e81f4\"");
        // Rounding happens before the hex conversion.
        let stat = FileStat {
            size: 1000,
            mtime_ms: 1699999999999.999,
        };
        assert_eq!(etag(&stat), "W/\"3e8-18bcfe56800\"");
    }

    // ---- Dates ----

    #[test]
    fn utc_string_matches_node() {
        assert_eq!(utc_string(0.0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(utc_string(-1.0), "Wed, 31 Dec 1969 23:59:59 GMT");
        assert_eq!(utc_string(784111777000.0), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(
            utc_string(253402300800000.0),
            "Sat, 01 Jan 10000 00:00:00 GMT"
        );
        assert_eq!(
            utc_string(-62167219200000.0),
            "Sat, 01 Jan 0000 00:00:00 GMT"
        );
        assert_eq!(
            utc_string(-62167219200001.0),
            "Fri, 31 Dec -0001 23:59:59 GMT"
        );
        assert_eq!(
            utc_string(8640000000000000.0),
            "Sat, 13 Sep 275760 00:00:00 GMT"
        );
        assert_eq!(
            utc_string(-8640000000000000.0),
            "Tue, 20 Apr -271821 00:00:00 GMT"
        );
        assert_eq!(utc_string(8640000000000001.0), "Invalid Date");
        assert_eq!(utc_string(f64::NAN), "Invalid Date");
        // new Date(x) truncates toward zero.
        assert_eq!(utc_string(784111777999.9), "Sun, 06 Nov 1994 08:49:37 GMT");
    }

    #[test]
    fn parse_http_date_http_formats() {
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784111777000.0)
        );
        assert_eq!(
            parse_http_date("Sunday, 06-Nov-94 08:49:37 GMT"),
            Some(784111777000.0)
        );
        assert_eq!(
            parse_http_date("Sun Nov  6 08:49:37 1994"),
            Some(784111777000.0)
        );
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49 GMT"),
            Some(784111740000.0)
        );
        assert_eq!(
            parse_http_date("Sun, 06 Nov 94 08:49:37 GMT"),
            Some(784111777000.0)
        );
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1094 08:49:37 GMT"),
            Some(-27617123423000.0)
        );
        assert_eq!(parse_http_date("garbage"), None);
        assert_eq!(parse_http_date(""), None);
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT extra"), None);
    }

    #[test]
    fn parse_http_date_iso() {
        assert_eq!(
            parse_http_date("1994-11-06T08:49:37Z"),
            Some(784111777000.0)
        );
        assert_eq!(
            parse_http_date("1994-11-06T08:49:37.123Z"),
            Some(784111777123.0)
        );
        assert_eq!(
            parse_http_date("1994-11-06T08:49:37.123456789Z"),
            Some(784111777123.0)
        );
        assert_eq!(
            parse_http_date("1994-11-06T08:49:37+01:00"),
            Some(784108177000.0)
        );
        assert_eq!(parse_http_date("1994-11-06"), Some(784080000000.0));
        assert_eq!(parse_http_date("1994-11"), Some(783648000000.0));
        assert_eq!(parse_http_date("1994"), Some(757382400000.0));
        assert_eq!(
            parse_http_date("+002024-01-01T00:00:00Z"),
            Some(1704067200000.0)
        );
        assert_eq!(
            parse_http_date("2024-01-01T24:00:00Z"),
            Some(1704153600000.0)
        );
        assert_eq!(
            parse_http_date("2024-02-30T00:00:00Z"),
            Some(1709251200000.0)
        );
        assert_eq!(parse_http_date("2024-13-01T00:00:00Z"), None);
        assert_eq!(parse_http_date("1994-11-06T08:49:37.Z"), None);
        assert_eq!(parse_http_date("  2024-01-01T00:00:00Z  "), None);
    }

    // ---- MIME ----

    #[test]
    fn mime_lookup_matches_package() {
        assert_eq!(mime_type("/x/a.png"), "image/png");
        assert_eq!(mime_type("/x/FILE.PNG"), "image/png");
        assert_eq!(mime_type("/a/b.c/file"), "application/octet-stream");
        assert_eq!(mime_type("/a/.png"), "image/png");
        assert_eq!(mime_type("/x/archive.tar.gz"), "application/gzip");
        assert_eq!(mime_type("/x/a."), "application/octet-stream");
        assert_eq!(mime_type("/x/README"), "application/octet-stream");
        assert_eq!(mime_type("png"), "image/png");
        assert_eq!(mime_type("/x/x.JS"), "application/javascript");
        assert_eq!(mime_type("/x/y.html"), "text/html");
    }

    #[test]
    fn content_type_appends_utf8_charset() {
        assert_eq!(content_type("/x/plain.txt"), "text/plain; charset=UTF-8");
        assert_eq!(content_type("/x/y.html"), "text/html; charset=UTF-8");
        assert_eq!(
            content_type("/x/x.JS"),
            "application/javascript; charset=UTF-8"
        );
        assert_eq!(content_type("/x/a.json"), "application/json; charset=UTF-8");
        assert_eq!(content_type("/x/a.png"), "image/png");
        assert_eq!(content_type("/x/a.bin"), "application/octet-stream");
    }

    // ---- content-disposition ----

    #[test]
    fn disposition_matches_package() {
        let case = |path: &str, expected: &str| {
            let bytes = attachment_disposition(path);
            assert_eq!(String::from_utf8(bytes).unwrap(), expected, "for {path}");
        };
        case("/tmp/plain.txt", "attachment; filename=\"plain.txt\"");
        case("/tmp/.hidden", "attachment; filename=\".hidden\"");
        case(
            "/x/a\"b\\c.json",
            "attachment; filename=\"a\\\"b\\\\c.json\"",
        );
        case(
            "/tmp/中文 文件.png",
            "attachment; filename=\"?? ??.png\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png",
        );
        case(
            "/tmp/emoji😀.bin",
            "attachment; filename=\"emoji??.bin\"; filename*=UTF-8''emoji%F0%9F%98%80.bin",
        );
        case(
            "/tmp/100%25.txt",
            "attachment; filename=\"100%25.txt\"; filename*=UTF-8''100%2525.txt",
        );
        case(
            "/x/tab\tname",
            "attachment; filename=\"tab?name\"; filename*=UTF-8''tab%09name",
        );
        case("/x/a;b.txt", "attachment; filename=\"a;b.txt\"");
        case("/x/star*.txt", "attachment; filename=\"star*.txt\"");
        case("/x/(paren).txt", "attachment; filename=\"(paren).txt\"");
        // U+0085 is not latin1-printable: '?' in the fallback, %C2%85 encoded.
        case(
            "/x/c1\u{85}.txt",
            "attachment; filename=\"c1?.txt\"; filename*=UTF-8''c1%C2%85.txt",
        );
        // 0xFF stays a single latin1 byte.
        let bytes = attachment_disposition("/x/\u{ff}.txt");
        assert_eq!(bytes, b"attachment; filename=\"\xff.txt\"".to_vec());
    }

    // ---- plan ----

    fn plain_stat() -> FileStat {
        FileStat {
            size: 1000,
            mtime_ms: 1699999999123.4,
        }
    }

    fn names(headers: &[Header]) -> Vec<(&str, String)> {
        headers
            .iter()
            .map(|h| (h.name.as_str(), String::from_utf8(h.value.clone()).unwrap()))
            .collect()
    }

    #[test]
    fn plan_plain_get() {
        let got = plan("/tmp/plain.txt", &plain_stat(), "GET", &no_headers, false);
        let SendPlan::File {
            status,
            headers,
            start,
            end,
            content_length,
            head_only,
        } = got
        else {
            panic!("expected File");
        };
        assert_eq!(status, 200);
        assert_eq!(start, 0);
        assert_eq!(end, 999);
        assert_eq!(content_length, 1000);
        assert!(!head_only);
        assert_eq!(
            names(&headers),
            vec![
                ("Accept-Ranges", "bytes".to_string()),
                ("Cache-Control", "public, max-age=0".to_string()),
                ("Last-Modified", "Tue, 14 Nov 2023 22:13:19 GMT".to_string()),
                ("ETag", "W/\"3e8-18bcfe56493\"".to_string()),
                ("Content-Type", "text/plain; charset=UTF-8".to_string()),
                ("Content-Length", "1000".to_string()),
            ]
        );
    }

    #[test]
    fn plan_head_has_no_body() {
        let SendPlan::File {
            status, head_only, ..
        } = plan("/tmp/plain.txt", &plain_stat(), "HEAD", &no_headers, false)
        else {
            panic!("expected File");
        };
        assert_eq!(status, 200);
        assert!(head_only);
    }

    #[test]
    fn plan_download_puts_disposition_first() {
        let SendPlan::File { headers, .. } =
            plan("/tmp/plain.txt", &plain_stat(), "GET", &no_headers, true)
        else {
            panic!("expected File");
        };
        assert_eq!(headers[0].name, "Content-Disposition");
        assert_eq!(headers[0].value, b"attachment; filename=\"plain.txt\"");
    }

    #[test]
    fn plan_dotfile_is_404_without_headers() {
        assert_eq!(
            plan("/tmp/.hidden", &plain_stat(), "GET", &no_headers, false),
            expect_error(404, vec![])
        );
        // The legacy rule only looks at the last path part.
        let SendPlan::File { status, .. } = plan(
            "/tmp/.dir/inside.txt",
            &plain_stat(),
            "GET",
            &no_headers,
            false,
        ) else {
            panic!("expected File");
        };
        assert_eq!(status, 200);
    }

    #[test]
    fn plan_single_range() {
        let h = header_of(&[("range", "bytes=0-0")]);
        let SendPlan::File {
            status,
            headers,
            start,
            end,
            content_length,
            ..
        } = plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected File");
        };
        assert_eq!((status, start, end, content_length), (206, 0, 0, 1));
        assert_eq!(
            headers.last().map(|h| h.name.as_str()),
            Some("Content-Length")
        );
        assert_eq!(headers[5].name, "Content-Range");
        assert_eq!(headers[5].value, b"bytes 0-0/1000");
    }

    #[test]
    fn plan_range_edges() {
        for (value, expect_416) in [
            ("bytes=-0", true),
            ("bytes=5-2", true),
            ("bytes=abc", true),
            ("bytes=-9999", true),
        ] {
            let h = header_of(&[("range", value)]);
            let SendPlan::Error { status, headers } =
                plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
            else {
                panic!("expected Error for {value}");
            };
            assert_eq!(status, 416);
            assert_eq!(headers.last().unwrap().name, "Content-Range");
            assert_eq!(headers.last().unwrap().value, b"bytes */1000");
            assert!(expect_416);
        }
        // Syntactically ignored units and multiple ranges fall back to 200.
        for value in ["bytes = 1-2", "items=0-1", "bytes=0-1,4-5"] {
            let h = header_of(&[("range", value)]);
            let SendPlan::File { status, .. } =
                plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
            else {
                panic!("expected File for {value}");
            };
            assert_eq!(status, 200);
        }
        // Overlapping ranges combine into one.
        let h = header_of(&[("range", "bytes=0-2,1-3")]);
        let SendPlan::File {
            status,
            content_length,
            end,
            ..
        } = plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected File");
        };
        assert_eq!((status, end, content_length), (206, 3, 4));
    }

    #[test]
    fn plan_not_modified() {
        let h = header_of(&[("if-none-match", "W/\"3e8-18bcfe56493\"")]);
        let SendPlan::NotModified { status, headers } =
            plan("/tmp/plain.txt", &plain_stat(), "GET", &h, true)
        else {
            panic!("expected NotModified");
        };
        assert_eq!(status, 304);
        // Content-Type is stripped, Content-Disposition survives.
        assert_eq!(
            names(&headers),
            vec![
                (
                    "Content-Disposition",
                    "attachment; filename=\"plain.txt\"".to_string()
                ),
                ("Accept-Ranges", "bytes".to_string()),
                ("Cache-Control", "public, max-age=0".to_string()),
                ("Last-Modified", "Tue, 14 Nov 2023 22:13:19 GMT".to_string()),
                ("ETag", "W/\"3e8-18bcfe56493\"".to_string()),
            ]
        );
    }

    #[test]
    fn plan_no_cache_forces_200() {
        let h = header_of(&[
            ("if-none-match", "W/\"3e8-18bcfe56493\""),
            ("cache-control", "no-cache"),
        ]);
        let SendPlan::File { status, .. } = plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected File");
        };
        assert_eq!(status, 200);
    }

    #[test]
    fn plan_precondition_failure_is_412() {
        let h = header_of(&[("if-match", "\"bad\"")]);
        let SendPlan::Error { status, headers } =
            plan("/tmp/plain.txt", &plain_stat(), "GET", &h, true)
        else {
            panic!("expected Error");
        };
        assert_eq!(status, 412);
        assert_eq!(headers.len(), 6);
        assert_eq!(headers[5].name, "Content-Type");

        let h = header_of(&[("if-unmodified-since", "Mon, 13 Nov 2023 22:13:19 GMT")]);
        let SendPlan::Error { status, .. } =
            plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected Error");
        };
        assert_eq!(status, 412);
    }

    #[test]
    fn plan_if_range() {
        let h = header_of(&[("range", "bytes=0-0"), ("if-range", "\"mismatch\"")]);
        let SendPlan::File { status, .. } = plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected File");
        };
        assert_eq!(status, 200);

        let h = header_of(&[
            ("range", "bytes=0-0"),
            ("if-range", "W/\"3e8-18bcfe56493\""),
        ]);
        let SendPlan::File { status, .. } = plan("/tmp/plain.txt", &plain_stat(), "GET", &h, false)
        else {
            panic!("expected File");
        };
        assert_eq!(status, 206);
    }

    #[test]
    fn plan_empty_file() {
        let stat = FileStat {
            size: 0,
            mtime_ms: 1600000000500.0,
        };
        let SendPlan::File {
            status,
            end,
            content_length,
            ..
        } = plan("/tmp/empty.txt", &stat, "GET", &no_headers, false)
        else {
            panic!("expected File");
        };
        assert_eq!((status, end, content_length), (200, 0, 0));

        let h = header_of(&[("range", "bytes=0-")]);
        let SendPlan::Error { status, .. } = plan("/tmp/empty.txt", &stat, "GET", &h, false) else {
            panic!("expected Error");
        };
        assert_eq!(status, 416);
    }
}
