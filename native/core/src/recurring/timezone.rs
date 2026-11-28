//! A caller's timezone transitions, detached from its runtime for calendar
//! workers. Offsets include historical sub-minute differences.
use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, TimeZone};
use std::sync::Arc;

pub fn local_offset_seconds(at: i64, parts: [i32; 7]) -> Option<i32> {
    let [year, month, day, hour, minute, second, millis] = parts;
    let local = NaiveDate::from_ymd_opt(year, month.checked_add(1)? as u32, day as u32)?
        .and_hms_milli_opt(hour as u32, minute as u32, second as u32, millis as u32)?;
    i32::try_from((local.and_utc().timestamp_millis() - at) / 1000).ok()
}

#[derive(Clone, Debug)]
pub struct TimeZoneSnapshot {
    changes: Arc<[(i64, FixedOffset)]>,
}

impl TimeZoneSnapshot {
    pub fn new(changes: Vec<(i64, i32)>) -> Option<Self> {
        if changes.is_empty() || changes.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return None;
        }
        let changes = changes
            .into_iter()
            .map(|(at, seconds)| Some((at, FixedOffset::east_opt(seconds)?)))
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            changes: changes.into(),
        })
    }

    fn offset_at(&self, at: i64) -> FixedOffset {
        let index = self.changes.partition_point(|(start, _)| *start <= at);
        self.changes[index.saturating_sub(1)].1
    }
}

impl TimeZone for TimeZoneSnapshot {
    type Offset = FixedOffset;

    fn from_offset(offset: &FixedOffset) -> Self {
        Self {
            changes: vec![(i64::MIN, *offset)].into(),
        }
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<Self::Offset> {
        self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).unwrap())
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<Self::Offset> {
        let local_ms = local.and_utc().timestamp_millis();
        let mut first = None;
        let mut last = None;
        for &(_, offset) in self.changes.iter() {
            let at = local_ms - i64::from(offset.local_minus_utc()) * 1000;
            if self.offset_at(at) != offset {
                continue;
            }
            if first.is_none_or(|(earliest, _)| at < earliest) {
                first = Some((at, offset));
            }
            if last.is_none_or(|(latest, _)| at > latest) {
                last = Some((at, offset));
            }
        }
        match (first, last) {
            (Some((a, first)), Some((b, last))) if a != b => LocalResult::Ambiguous(first, last),
            (Some((_, offset)), _) => LocalResult::Single(offset),
            _ => LocalResult::None,
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> Self::Offset {
        self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> Self::Offset {
        self.offset_at(utc.and_utc().timestamp_millis())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recurring::{month_start, Expression};
    use chrono::DateTime;

    fn millis(value: &str) -> i64 {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn gap_and_overlap_follow_the_supplied_clock() {
        let zone = TimeZoneSnapshot::new(vec![
            (i64::MIN, -8 * 3600),
            (millis("2026-03-08T10:00:00Z"), -7 * 3600),
            (millis("2026-11-01T09:00:00Z"), -8 * 3600),
        ])
        .unwrap();
        assert_eq!(
            Expression::parse("0 2 * * *").unwrap().next_in(
                millis("2026-03-08T09:59:59Z"),
                None,
                &zone
            ),
            Some(millis("2026-03-09T09:00:00Z"))
        );
        assert_eq!(
            Expression::parse("* * * * *").unwrap().next_in(
                millis("2026-11-01T09:15:00Z"),
                None,
                &zone
            ),
            Some(millis("2026-11-01T08:16:00Z"))
        );
    }

    #[test]
    fn month_boundary_preserves_the_hosts_midnight_overlap() {
        let zone = TimeZoneSnapshot::new(vec![
            (i64::MIN, -4 * 3600),
            (millis("2026-11-01T05:00:00Z"), -5 * 3600),
        ])
        .unwrap();
        assert_eq!(
            month_start(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), &zone),
            Some(millis("2026-11-01T04:00:00Z"))
        );
        assert_eq!(
            Expression::parse("30 1 * * *").unwrap().next_in(
                millis("2026-11-01T04:30:00Z"),
                None,
                &zone
            ),
            Some(millis("2026-11-01T06:30:00Z"))
        );
    }

    #[test]
    fn historical_seconds_and_invalid_tables() {
        let zone = TimeZoneSnapshot::new(vec![(i64::MIN, 561)]).unwrap();
        let local = NaiveDate::from_ymd_opt(1900, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        assert_eq!(
            zone.from_local_datetime(&local).unwrap().timestamp_millis(),
            millis("1900-01-01T11:50:39Z")
        );
        assert!(TimeZoneSnapshot::new(vec![]).is_none());
        assert!(TimeZoneSnapshot::new(vec![(1, 0), (1, 3600)]).is_none());
    }
}
