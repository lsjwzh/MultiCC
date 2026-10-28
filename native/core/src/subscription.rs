//! Billing dates are independent from OAuth expiry and usage reset windows.
use chrono::{DateTime, NaiveDate};
use serde_json::{json, Value};

fn date(value: &Value) -> Option<f64> {
    let n = value.as_f64().or_else(|| value.as_str()?.parse().ok());
    let ms = if let Some(n) = n {
        if n < 1e12 {
            n * 1000.0
        } else {
            n
        }
    } else {
        let s = value.as_str()?;
        DateTime::parse_from_rfc3339(s)
            .map(|d| d.timestamp_millis() as f64)
            .ok()
            .or_else(|| {
                NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()?
                    .and_hms_opt(0, 0, 0)
                    .map(|d| d.and_utc().timestamp_millis() as f64)
            })?
    };
    (946684800000.0..4102444800000.0)
        .contains(&ms)
        .then_some(ms)
}

pub fn parse(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "Invalid subscription response")?;
    let body = &v["body"];
    if !body.is_object() {
        return Ok("null".into());
    }
    let rows = [
        &body["subscription"],
        &body["billing"],
        &body["organization"]["subscription"],
        &body["organization"],
        &body["account"]["subscription"],
        &body["subscription_info"],
        &body["data"]["subscription"],
        body,
    ];
    let pick = |keys: &[&str]| {
        rows.iter()
            .find_map(|row| keys.iter().find_map(|key| date(&row[key])))
    };
    let cancelled = rows.iter().any(|r| {
        r["cancel_at_period_end"] == true || r["auto_renew"] == false || r["will_renew"] == false
    });
    let renews = rows
        .iter()
        .any(|r| r["auto_renew"] == true || r["will_renew"] == true);
    let end = pick(&[
        "current_period_end",
        "subscription_end",
        "subscription_expires_at",
        "chatgpt_subscription_active_until",
    ]);
    let next = if cancelled {
        None
    } else {
        pick(&[
            "next_billing_at",
            "next_billing_date",
            "next_renewal_at",
            "renews_at",
            "renewal_date",
            "next_payment_date",
            "next_invoice_at",
        ])
        .or_else(|| renews.then_some(end).flatten())
    };
    if next.is_none() && end.is_none() && !cancelled {
        return Ok("null".into());
    }
    Ok(json!({"nextBillingAt":next,"currentPeriodEnd":end,"autoRenew":if cancelled {Some(false)} else if renews {Some(true)} else {None},
        "source":v["source"].as_str().unwrap_or("account"),"observedAt":date(&v["observedAt"])}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_explicit_nested_billing_but_never_token_or_quota_expiry() {
        let read = |body: Value| -> Value {
            serde_json::from_str(&parse(&json!({"body":body}).to_string()).unwrap()).unwrap()
        };
        assert!(read(json!({"expires_at":"2030-01-01","resets_at":"2030-01-01"})).is_null());
        assert_eq!(
            read(json!({"account":{"subscription":{"next_payment_date":"2030-01-01"}}}))
                ["nextBillingAt"],
            1893456000000_f64
        );
        let cancelled = read(
            json!({"subscription":{"next_invoice_at":"2030-01-01","current_period_end":"2030-01-01","cancel_at_period_end":true}}),
        );
        assert!(cancelled["nextBillingAt"].is_null());
        assert_eq!(cancelled["autoRenew"], false);
    }
}
