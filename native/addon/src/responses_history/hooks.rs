//! CPR hooks operate on the forwarded copy. Returning undefined preserves the
//! original request bytes. Only a recognized repair authorizes another dial.
use super::*;

#[derive(Clone, Copy)]
pub(super) enum DialStage {
    Request,
    Rejection,
}

fn string<'a>(value: L<'a>) -> Result<L<'a>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}

fn message(value: L<'_>) -> Result<L<'_>> {
    string(if value.truthy()? {
        value
    } else {
        text(value, "")?
    })
}

fn rejection_error(context: L<'_>) -> Result<L<'_>> {
    // Coercion may execute caller code; only parsing and unwrapping are best effort.
    let raw = message(read(context, c"message")?)?;
    let parsed = context
        .catch(|| {
            let parsed = call(context.global()?.get(c"JSON")?, c"parse", &[raw])?;
            if !object(parsed)? {
                return Ok(None);
            }
            let inner = read(parsed, c"error")?;
            Ok(Some(if object(inner)? {
                spread(inner)?
            } else {
                parsed
            }))
        })?
        .flatten();
    match parsed {
        Some(error) => Ok(error),
        None => fields(context, &[("message", raw)]),
    }
}

fn logged_error(error: L<'_>) -> Result<L<'_>> {
    let details = fields(error, &[("message", message(read(error, c"message")?)?)])?;
    for key in [c"param", c"code"] {
        if read(error, key)?.truthy()? {
            details.set(key, string(read(error, key)?)?)?;
        }
    }
    Ok(details)
}

impl DialStage {
    pub(super) fn run<'a>(self, rules: L<'a>, context: L<'a>, logger: L<'a>) -> Result<L<'a>> {
        let unchanged = context.from_value(&V::Undefined)?;
        if !context.truthy()? || !read(context, c"protocol")?.is_string("openai-responses")? {
            return Ok(unchanged);
        }
        if let Self::Rejection = self {
            let status = read(context, c"status")?.explicit_number()?;
            if status != 400.0 && status != 404.0 {
                return Ok(unchanged);
            }
        }
        let body = read(context, c"body")?;
        if !object(body)? {
            return Ok(unchanged);
        }

        let (rewrite, error) = match self {
            Self::Request => (normalize(rules, body, false)?, None),
            Self::Rejection => {
                let error = rejection_error(context)?;
                (repair::run(rules, body, error)?, Some(error))
            }
        };
        if !rewrite.truthy()? || !has_items(read(rewrite, c"changes")?)? {
            return Ok(unchanged);
        }

        // Construct fields even when the logger is absent. Attribution getters
        // and error coercions run outside the diagnostic exception boundary.
        let report = fields(
            context,
            &[
                ("providerId", read(context, c"providerId")?),
                ("sessionId", read(context, c"sessionId")?),
                ("role", read(context, c"role")?),
            ],
        )?;
        let event = if let Some(error) = error {
            report.set(c"status", read(context, c"status")?)?;
            report.set(c"error", logged_error(error)?)?;
            "model_history_repaired_after_rejection"
        } else {
            "model_history_preprocessed"
        };
        report.set(c"changes", read(rewrite, c"changes")?)?;
        if logger.truthy()? {
            logger.catch(|| call(logger, c"warn", &[text(context, event)?, report]))?;
        }

        let result = fields(context, &[])?;
        if let Self::Rejection = self {
            result.set(c"retry", context.from_value(&V::Bool(true))?)?;
        }
        result.set(c"body", read(rewrite, c"body")?)?;
        Ok(result)
    }
}
