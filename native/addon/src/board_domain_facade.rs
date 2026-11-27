//! Task-domain commands operate on the caller's live board. The injected
//! taskDomain and replace ports can recognize the resident board's proxies.
use crate::{
    host_methods::{arg, default_object, env, function, raw},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

mod bridge;
mod normalize;
mod planning;

fn undefined(value: L<'_>) -> Result<L<'_>> {
    value.from_value(&V::Undefined)
}

fn or_default<'a>(value: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if value.undefined()? { fallback } else { value })
}

fn empty_if_falsy(value: L<'_>) -> Result<L<'_>> {
    if value.truthy()? {
        Ok(value)
    } else {
        fields(value, &[])
    }
}

fn now(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"Date")?, c"now", &[])
}

fn time_or_now(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        now(value)
    } else {
        Ok(value)
    }
}

fn array<'a>(owner: L<'a>, items: &[L<'a>]) -> Result<L<'a>> {
    let list = owner.global()?.get(c"Array")?.construct(&[])?;
    for (index, item) in items.iter().enumerate() {
        list.set_element(index as u32, *item)?;
    }
    Ok(list)
}

fn object_method<'a>(p: L<'a>, method: &CStr, values: &[L<'a>]) -> Result<L<'a>> {
    call(p.global()?.get(c"Object")?, method, values)
}

fn group_order<'a>(p: L<'a>, groups: L<'a>, filter_empty: bool) -> Result<L<'a>> {
    let ids = array(p, &[])?;
    object_method(p, c"values", &[empty_if_falsy(groups)?])?.for_each(|group| {
        let id = group.get(c"id")?;
        if !filter_empty || id.truthy()? {
            call(ids, c"push", &[id])?;
        }
        Ok(())
    })?;
    call(ids, c"sort", &[p.get(c"compareIds")?])
}

fn date_pair<'a>(p: L<'a>, dates: L<'a>, value: L<'a>) -> Result<()> {
    let iso = call(p, c"wireDate", &[value])?;
    call(dates, c"push", &[array(p, &[value, iso])?])?;
    Ok(())
}

fn new_id<'a>(p: L<'a>, prefix: L<'a>) -> Result<L<'a>> {
    let prefix = string(prefix)?;
    let suffix = call(p, c"uuid", &[])?;
    call(prefix, c"concat", &[text(p, "-")?, suffix])
}

fn expose<'a>(
    p: L<'a>,
    api: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    api.define_key(text(p, name)?, function(p, name, length, count, run)?)
}

fn string_set<'a>(p: L<'a>, values: &[&str]) -> Result<L<'a>> {
    let list = array(p, &[])?;
    for value in values {
        call(list, c"push", &[text(p, value)?])?;
    }
    p.global()?.get(c"Set")?.construct(&[list])
}

fn domain_command<'a>(p: L<'a>, op: &str, action: L<'a>, args: L<'a>) -> Result<L<'a>> {
    let command = fields(p, &[("op", text(p, op)?), ("action", action)])?;
    command.spread_from(args)?;
    Ok(command)
}

#[napi]
pub fn task_board_domain_facades(env_arg: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env_arg, ports);
    Ok(fields(
        p,
        &[
            ("planning", planning::api(p)?),
            ("normalize", normalize::api(p)?),
            ("bridge", bridge::api(p)?),
        ],
    )?
    .raw())
}
