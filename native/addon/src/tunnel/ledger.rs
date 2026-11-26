//! A Funnel attempt is reserved durably before invoking the CLI. Both failed
//! and successful commands consume the budget, including after a clock rollback.
use crate::route_response::*;

const HOUR: f64 = 3_600_000.;
const DAY: f64 = 24. * HOUR;
const COOLDOWN: f64 = 15. * 60_000.;
const MAX_DAY: usize = 4;
const MAX_HOUR: usize = 2;
const MAX_BYTES: f64 = 16. * 1024.;

#[derive(Clone, Copy)]
struct Attempt {
    at: f64,
    outcome: &'static str,
}
fn decode(value: L<'_>, after: f64) -> Result<Option<Vec<Attempt>>> {
    if !value.optional(c"version")?.is_number(1.)? {
        return Ok(None);
    }
    let attempts = value.optional(c"tailscaleFunnel")?.optional(c"attempts")?;
    if !attempts.is_array()? || attempts.get(c"length")?.number()? > MAX_DAY as f64 {
        return Ok(None);
    }
    let mut rows = Vec::new();
    for i in 0..attempts.get(c"length")?.number()? as u32 {
        let item = attempts.element(i)?;
        let Some(at) = item.optional(c"at")?.number_value()? else {
            return Ok(None);
        };
        if !(at > 0. && at <= 9_007_199_254_740_991. && at.fract() == 0.) {
            return Ok(None);
        }
        let outcome = item.optional(c"outcome")?;
        let outcome = if outcome.is_string("pending")? {
            "pending"
        } else if outcome.is_string("command_succeeded")? {
            "command_succeeded"
        } else if outcome.is_string("command_failed")? {
            "command_failed"
        } else {
            return Ok(None);
        };
        if at > after {
            rows.push(Attempt { at, outcome });
        }
    }
    rows.sort_by(|a, b| a.at.total_cmp(&b.at));
    Ok(Some(rows))
}
fn document<'a>(s: L<'a>, attempts: &[Attempt]) -> Result<L<'a>> {
    let rows = s.from_value(&V::Array(vec![]))?;
    for (i, row) in attempts.iter().enumerate() {
        rows.set_element(
            i as u32,
            fields(
                s,
                &[("at", num(s, row.at)?), ("outcome", text(s, row.outcome)?)],
            )?,
        )?;
    }
    fields(
        s,
        &[
            ("version", num(s, 1.)?),
            ("tailscaleFunnel", fields(s, &[("attempts", rows)])?),
        ],
    )
}
fn log_error(s: L<'_>, msg: &str) -> Result<()> {
    call(s.global()?.get(c"console")?, c"error", &[text(s, msg)?])?;
    Ok(())
}
pub(super) fn initialize(s: L<'_>) -> Result<()> {
    s.set(c"repairLedger", document(s, &[])?)?;
    s.set(c"ledgerHealthy", flag(s, true)?)?;
    let fs = s.get(c"fs")?;
    let file = s.get(c"ledgerFile")?;
    if !call(fs, c"existsSync", &[file])?.truthy()? {
        return Ok(());
    }
    let loaded = s
        .catch(|| -> Result<Option<Vec<Attempt>>> {
            if call(fs, c"statSync", &[file])?
                .get(c"size")?
                .explicit_number()?
                > MAX_BYTES
            {
                return Ok(None);
            }
            let raw = call(fs, c"readFileSync", &[file, text(s, "utf8")?])?;
            let parsed = call(s.global()?.get(c"JSON")?, c"parse", &[raw])?;
            decode(parsed, super::config::now(s)? - DAY)
        })?
        .flatten();
    if let Some(attempts) = loaded {
        s.set(c"repairLedger", document(s, &attempts)?)
    } else {
        s.set(c"ledgerHealthy", flag(s, false)?)?;
        log_error(
            s,
            "[multicc/tunnel] Funnel repair ledger is invalid; automatic repair disabled",
        )
    }
}
pub(super) fn status(s: L<'_>, now: f64) -> Result<L<'_>> {
    let rows = decode(s.get(c"repairLedger")?, now - DAY)?.unwrap_or_default();
    fields(
        s,
        &[
            ("ledgerHealthy", s.get(c"ledgerHealthy")?),
            ("lastAttemptAt", num(s, rows.last().map_or(0., |r| r.at))?),
            (
                "attemptsLastHour",
                num(s, rows.iter().filter(|r| r.at > now - HOUR).count() as f64)?,
            ),
            ("attemptsLastDay", num(s, rows.len() as f64)?),
        ],
    )
}
pub(super) fn guard(s: L<'_>, now: f64) -> Result<L<'_>> {
    let view = status(s, now)?;
    let last = view.get(c"lastAttemptAt")?.number()?;
    let reason = if !view.get(c"ledgerHealthy")?.truthy()? {
        "ledger_unavailable"
    } else if last != 0. && now - last < COOLDOWN {
        "cooldown"
    } else if view.get(c"attemptsLastHour")?.number()? >= MAX_HOUR as f64 {
        "hour_cap"
    } else if view.get(c"attemptsLastDay")?.number()? >= MAX_DAY as f64 {
        "day_cap"
    } else {
        return fields(s, &[("ok", flag(s, true)?), ("status", view)]);
    };
    let result = fields(s, &[("ok", flag(s, false)?), ("reason", text(s, reason)?)])?;
    if reason == "cooldown" {
        result.set(
            c"waitSec",
            num(s, ((COOLDOWN - (now - last)) / 1000.).ceil())?,
        )?;
    }
    result.set(c"status", view)?;
    Ok(result)
}
fn write<'a>(s: L<'a>, next: L<'a>) -> Result<()> {
    s.get(c"atomicWriteJson")?
        .call_plain(&[s.get(c"ledgerFile")?, next])?;
    s.set(c"repairLedger", next)
}
pub(super) fn reserve(s: L<'_>, now: f64) -> Result<f64> {
    if !s.get(c"ledgerHealthy")?.truthy()? {
        return Err(s
            .global()?
            .get(c"Error")?
            .construct(&[text(s, "repair ledger unavailable")?])?
            .throw_error());
    }
    let mut rows = decode(s.get(c"repairLedger")?, now - DAY)?.unwrap_or_default();
    if rows.len() == MAX_DAY {
        rows.remove(0);
    }
    rows.push(Attempt {
        at: now,
        outcome: "pending",
    });
    if let Err(err) = write(s, document(s, &rows)?) {
        let reason = s.exception_value()?;
        s.set(c"ledgerHealthy", flag(s, false)?)?;
        return Err(reason.map_or(err, |v| v.throw_error()));
    }
    Ok(now)
}
pub(super) fn settle(s: L<'_>, at: f64, outcome: &str) -> Result<bool> {
    if !s.get(c"ledgerHealthy")?.truthy()? {
        return Ok(false);
    }
    let mut rows = decode(s.get(c"repairLedger")?, f64::NEG_INFINITY)?.unwrap_or_default();
    let Some(row) = rows
        .iter_mut()
        .rev()
        .find(|r| r.at == at && r.outcome == "pending")
    else {
        return Ok(false);
    };
    row.outcome = if outcome == "command_succeeded" {
        "command_succeeded"
    } else {
        "command_failed"
    };
    let next = document(s, &rows)?;
    if s.catch(|| write(s, next))?.is_none() {
        s.set(c"ledgerHealthy", flag(s, false)?)?;
        log_error(
            s,
            "[multicc/tunnel] Funnel repair ledger result write failed; automatic repair disabled",
        )?;
        return Ok(false);
    }
    Ok(true)
}
