//! Capture the host Date clock before crossing onto a Rust worker. The host's
//! ICU timezone database can differ from the operating system's zoneinfo.
use super::*;
use multicc_core::recurring::timezone::{local_offset_seconds, TimeZoneSnapshot};

pub(super) const DAY_MS: i64 = 86_400_000;

fn offset(date_class: L<'_>, at: i64) -> Result<i32> {
    let date = date_class.construct(&[num(date_class, at as f64)?])?;
    let read = |key| call(date, key, &[])?.number();
    local_offset_seconds(
        at,
        [
            read(c"getFullYear")? as i32,
            read(c"getMonth")? as i32,
            read(c"getDate")? as i32,
            read(c"getHours")? as i32,
            read(c"getMinutes")? as i32,
            read(c"getSeconds")? as i32,
            read(c"getMilliseconds")? as i32,
        ],
    )
    .ok_or_else(|| napi::Error::from_reason("invalid local time"))
}

pub(super) fn snapshot(p: L<'_>, start: i64, end: i64) -> Result<TimeZoneSnapshot> {
    let date_class = p.global()?.get(c"Date")?;
    let mut at = start - 2 * DAY_MS;
    let end = end + 2 * DAY_MS;
    let mut previous = offset(date_class, at)?;
    let mut changes = vec![(at, previous)];
    // IANA clock changes are separated by more than six hours. Once a change
    // is bracketed, retain its exact millisecond boundary for Date setters.
    while at < end {
        let next = (at + 6 * 3_600_000).min(end);
        let current = offset(date_class, next)?;
        if current != previous {
            let mut left = at;
            let mut right = next;
            while right - left > 1 {
                let middle = left + (right - left) / 2;
                if offset(date_class, middle)? == previous {
                    left = middle;
                } else {
                    right = middle;
                }
            }
            changes.push((right, current));
            previous = current;
        }
        at = next;
    }
    TimeZoneSnapshot::new(changes)
        .ok_or_else(|| napi::Error::from_reason("invalid timezone snapshot"))
}
