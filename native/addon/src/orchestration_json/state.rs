use super::*;
use multicc_core::orchestration_store::COLLECTIONS;

pub(super) fn initial(v: L<'_>) -> Result<L<'_>> {
    let state = fields(
        v,
        &[
            ("schemaVersion", num(v, 3.)?),
            ("revision", num(v, 0.)?),
            ("updatedAt", num(v, 0.)?),
            ("nextOutboxSequence", num(v, 1.)?),
        ],
    )?;
    for name in COLLECTIONS {
        state.set_key(text(v, name)?, fields(v, &[])?)?;
    }
    Ok(state)
}
fn record(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_object && !v.is_array()?)
}
pub(super) fn validate<'a>(ports: L<'a>, input: L<'a>, file: L<'a>) -> Result<L<'a>> {
    let mut v = input;
    if record(input)? {
        let version = input.get(c"schemaVersion")?;
        if version.is_number(1.)? || version.is_number(2.)? {
            v = fields(input, &[])?;
            v.spread_from(input)?;
            v.set(c"schemaVersion", num(v, 3.)?)?;
            if version.is_number(1.)? {
                v.set(c"operations", fields(v, &[])?)?;
                v.set(c"tasks", fields(v, &[])?)?;
            }
            v.set(c"sessionSchedules", fields(v, &[])?)?;
        }
    }
    let invalid =
        |prefix: &str| corrupt(ports, join(file, &[text(file, prefix)?, file])?, file, None);
    if !record(v)? || !v.get(c"schemaVersion")?.is_number(3.)? {
        return invalid("unsupported orchestration state in ");
    }
    let integer = |n: L<'_>, min: f64| -> Result<bool> {
        Ok(n.number_value()?
            .is_some_and(|x| x >= min && x <= 9_007_199_254_740_991. && x.fract() == 0.))
    };
    if !integer(v.get(c"revision")?, 0.)? {
        return invalid("invalid orchestration revision in ");
    }
    if !integer(v.get(c"nextOutboxSequence")?, 1.)? {
        return invalid("invalid orchestration collections in ");
    }
    for name in COLLECTIONS {
        if !record(v.get_key(text(v, name)?)?)? {
            return invalid("invalid orchestration collections in ");
        }
    }
    Ok(v)
}
pub(super) fn clone_json(v: L<'_>) -> Result<L<'_>> {
    if v.undefined()? {
        return Ok(v);
    }
    json(v, c"parse", &[json(v, c"stringify", &[v])?])
}
pub(super) fn freeze(v: L<'_>) -> Result<L<'_>> {
    let object = v.global()?.get(c"Object")?;
    let needs_freeze = |value: L<'_>| -> Result<bool> {
        Ok(value.kind()? == sys::ValueType::napi_object
            && !call(object, c"isFrozen", &[value])?.truthy()?)
    };
    if v.kind()? != sys::ValueType::napi_object {
        return Ok(v);
    }
    // Walk child-first without recursing on the native stack. A back edge in
    // an unfrozen graph has the same RangeError contract as the JS recursion.
    let active = v.global()?.get(c"Set")?.construct(&[])?;
    let mut work = vec![(v, false)];
    while let Some((node, finish)) = work.pop() {
        if finish {
            call(object, c"freeze", &[node])?;
            call(active, c"delete", &[node])?;
        } else if needs_freeze(node)? {
            if call(active, c"has", &[node])?.truthy()? {
                return Err(v
                    .global()?
                    .get(c"RangeError")?
                    .construct(&[text(v, "Maximum call stack size exceeded")?])?
                    .throw_error());
            }
            call(active, c"add", &[node])?;
            work.push((node, true));
            let children = call(object, c"values", &[node])?;
            let count = children.get(c"length")?.number()? as u32;
            for index in (0..count).rev() {
                work.push((children.element(index)?, false));
            }
        }
    }
    Ok(v)
}
