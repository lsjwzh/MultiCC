use super::*;

enum Inspect<'a> {
    Value(L<'a>),
    Descriptor(L<'a>, L<'a>),
}
pub(super) fn contains<'a>(
    p: L<'a>,
    value: L<'a>,
    safe: bool,
    seen: Option<L<'a>>,
) -> Result<bool> {
    let seen = match seen {
        Some(v) if !v.undefined()? => v,
        _ => p.global()?.get(c"WeakSet")?.construct(&[])?,
    };
    let mut stack = vec![Inspect::Value(value)];
    while let Some(item) = stack.pop() {
        let value = match item {
            Inspect::Value(v) => v,
            Inspect::Descriptor(descriptors, key) => {
                let d = descriptors.get_key(key)?;
                if !d.get(c"enumerable")?.truthy()? {
                    continue;
                }
                if !object_call(p, c"hasOwn", &[d, text(p, "value")?])?.truthy()? {
                    if key.is_string("then")? {
                        continue;
                    }
                    return Err(p.type_error("synchronous Rust command returned an accessor"));
                }
                d.get(c"value")?
            }
        };
        if !object(value)? {
            continue;
        }
        if has(p.get(c"owned")?, value)? {
            return Ok(true);
        }
        if safe
            && p.get(c"ports")?
                .get(c"isProxy")?
                .call_plain(&[value])?
                .truthy()?
        {
            return Err(p.type_error("synchronous Rust command returned an opaque proxy"));
        }
        if has(seen, value)? {
            continue;
        }
        call(seen, c"add", &[value])?;
        if safe {
            let descriptors = object_call(p, c"getOwnPropertyDescriptors", &[value])?;
            let keys = reflect(p, c"ownKeys", &[descriptors])?;
            for i in (0..keys.get(c"length")?.number()? as u32).rev() {
                stack.push(Inspect::Descriptor(descriptors, keys.element(i)?));
            }
        } else {
            let values = object_call(p, c"values", &[value])?;
            for i in (0..values.get(c"length")?.number()? as u32).rev() {
                stack.push(Inspect::Value(values.element(i)?));
            }
        }
    }
    Ok(false)
}
pub(super) fn finish<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let now = crate::js_iteration::read(a[0], c"now")?;
    let ports = p.get(c"ports")?;
    let base = p.get(c"base")?;
    let next = pick(
        base,
        &[
            c"schemaVersion",
            c"revision",
            c"updatedAt",
            c"nextOutboxSequence",
        ],
    )?;
    let collections = record_maps(p)?;
    let extras = map(p)?;
    let persisted = fields(p, &[("collections", collections), ("extras", extras)])?;
    let mut changed = false;
    for name in COLLECTIONS.into_iter().chain(["extras"]) {
        let col = text(p, name)?;
        let target = if name == "extras" {
            extras
        } else {
            collections.get_key(col)?
        };
        changes(p, col)?.for_each(|pair| {
            let key = pair.element(0)?;
            let e = pair.element(1)?;
            let before = call(p.get(c"native")?, c"materialize", &[col, key])?;
            let deleted = e.get(c"deleted")?.truthy()?;
            let value = e.get(c"value")?;
            if if deleted {
                before.undefined()?
            } else {
                before.equals(value)?
                    || json_call(p, c"stringify", before)?.equals(json_call(
                        p,
                        c"stringify",
                        value,
                    )?)?
            } {
                return Ok(());
            }
            let row = fields(p, &[("deleted", flag(p, deleted)?), ("before", before)])?;
            if !deleted {
                ports.get(c"_deepFreeze")?.call_plain(&[value])?;
                row.set(c"value", value)?;
            }
            call(target, c"set", &[key, row])?;
            changed = true;
            Ok(())
        })?;
    }
    let top = p.get(c"top")?;
    let schema = ports.get(c"SCHEMA_VERSION")?;
    let requested = call(top, c"get", &[text(p, "schemaVersion")?])?;
    if requested.truthy()? && !requested.get(c"value")?.equals(schema)? {
        return Err(ports
            .get(c"OrchestrationStoreCorruptError")?
            .construct(&[text(
                p,
                "mutation attempted to change orchestration schemaVersion",
            )?])?
            .throw_error());
    }
    let sequence = call(top, c"get", &[text(p, "nextOutboxSequence")?])?;
    let seq = if sequence.truthy()? {
        sequence.get(c"value")?
    } else {
        base.get(c"nextOutboxSequence")?
    };
    changed |= !seq.equals(base.get(c"nextOutboxSequence")?)?;
    next.set(c"nextOutboxSequence", seq)?;
    let state = if changed {
        next.set(c"schemaVersion", schema)?;
        next.set(c"revision", num(p, base.get(c"revision")?.number()? + 1.0)?)?;
        next.set(
            c"updatedAt",
            num(p, now.call_plain(&[])?.explicit_number()?)?,
        )?;
        let sample = spread(next)?;
        for name in COLLECTIONS {
            sample.define_key(text(p, name)?, fields(p, &[])?)?;
        }
        ports
            .get(c"_validateState")?
            .call_plain(&[sample, text(p, "<orchestration-sqlite-draft>")?])?;
        ports.get(c"_deepFreeze")?.call_plain(&[next])?
    } else {
        base
    };
    p.set(c"active", flag(p, false)?)?;
    fields(
        p,
        &[
            ("changed", flag(p, changed)?),
            ("state", state),
            ("expectedRevision", base.get(c"revision")?),
            ("persisted", persisted),
        ],
    )
}
