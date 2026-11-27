//! Live JS views of the Rust catalogue. Static rows have stable, frozen
//! identities. Picker lists are mutable copies, as expected by UI callers.
use crate::{host_methods::method, route_response::*};
use multicc_core::{cli_capability as cli, effort_catalog, js::JsString};
use napi::{bindgen_prelude::ToNapiValue, check_status};
use napi_derive::napi;
use std::ffi::CStr;

fn keys(obj: L<'_>) -> Result<L<'_>> {
    call(obj.global()?.get(c"Object")?, c"keys", &[obj])
}

fn freeze_tree(value: L<'_>) -> Result<L<'_>> {
    if value.kind()? == sys::ValueType::napi_object && !value.nullish()? {
        keys(value)?.for_each(|key| freeze_tree(value.get_key(key)?).map(|_| ()))?;
        value.freeze()?;
    }
    Ok(value)
}

// Preserve lone surrogates in unknown ids which are echoed back to callers.
fn raw(id: L<'_>) -> Result<JsString> {
    if id.nullish()? {
        return Ok(JsString::new());
    }
    let value = match id.string()? {
        Some(value) => value,
        None => string(id)?.coerce_string()?,
    };
    Ok(value.trim())
}

fn normalized(id: L<'_>) -> Result<L<'_>> {
    let value = raw(id)?.to_lowercase();
    for &(alias, canonical) in cli::ALIASES {
        if value.as_units().iter().copied().eq(alias.encode_utf16()) {
            return text(id, canonical);
        }
    }
    id.from_value(&V::String(value))
}

fn own<'a>(table: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let mut present = false;
    check_status!(unsafe {
        sys::napi_has_own_property(table.env(), table.raw(), key.raw(), &mut present)
    })?;
    if present {
        table.get_key(key)
    } else {
        null(table)
    }
}

fn lookup<'a>(state: L<'a>, table: &CStr, cli: L<'a>) -> Result<L<'a>> {
    own(state.get(c"catalog")?.get(table)?, normalized(cli)?)
}

fn capability<'a>(state: L<'a>, cli: L<'a>) -> Result<L<'a>> {
    let row = lookup(state, c"capabilities", cli)?;
    if row.nullish()? {
        state.get(c"catalog")?.get(c"defaultCapability")
    } else {
        Ok(row)
    }
}

fn family<'a>(state: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let key = normalized(id)?;
    let catalog = state.get(c"catalog")?;
    if own(catalog.get(c"clis")?, key)?.truthy()? {
        Ok(key)
    } else {
        own(catalog.get(c"laneFamily")?, key)
    }
}

fn display_field<'a>(state: L<'a>, cli: L<'a>, field: &CStr) -> Result<L<'a>> {
    lookup(state, c"display", cli)?.optional(field)
}

fn kinds<'a>(state: L<'a>, cli: L<'a>) -> Result<L<'a>> {
    let row = display_field(state, cli, c"kinds")?;
    if row.truthy()? {
        Ok(row)
    } else {
        state.get(c"catalog")?.get(c"defaultKinds")
    }
}

fn family_row<'a>(state: L<'a>, table: &CStr, cli: L<'a>) -> Result<L<'a>> {
    let id = family(state, cli)?;
    if id.nullish()? {
        Ok(id)
    } else {
        own(state.get(c"catalog")?.get(table)?, id)
    }
}

fn copy_rows(rows: L<'_>) -> Result<L<'_>> {
    let out = rows.from_value(&V::Array(vec![]))?;
    if !rows.nullish()? {
        let mut index = 0;
        rows.for_each(|row| {
            let copy = fields(rows, &[])?;
            copy.spread_from(row)?;
            out.set_element(index, copy)?;
            index += 1;
            Ok(())
        })?;
    }
    Ok(out)
}

#[napi]
pub fn cli_catalog_views(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let json = cli::catalog().map_err(napi::Error::from_reason)?;
    let catalog = freeze_tree(call(
        anchor.global()?.get(c"JSON")?,
        c"parse",
        &[text(anchor, &json)?],
    )?)?;
    let state = fields(
        anchor,
        &[("catalog", catalog), ("efforts", catalog.get(c"efforts")?)],
    )?;
    let api = fields(anchor, &[])?;
    for (name, key) in [
        (c"ALIASES", c"aliases"),
        (c"CAPABILITIES", c"capabilities"),
        (c"CLIS", c"clis"),
        (c"DEFAULT_CAPABILITY", c"defaultCapability"),
        (c"DEFAULT_COLOUR", c"defaultColour"),
        (c"DEFAULT_KINDS", c"defaultKinds"),
        (c"DISPLAY", c"display"),
        (c"KINDS", c"kinds"),
    ] {
        api.set(name, catalog.get(key)?)?;
    }
    macro_rules! export {
        ($name:expr, $length:expr, $function:expr) => {
            api.set_key(
                text(api, $name)?,
                method(&env, state, $name, $length, $length, $function)?,
            )?
        };
    }
    export!("nameOf", 1, |_, a| normalized(a[0]));
    export!("capabilityOf", 1, |s, a| capability(s, a[0]));
    export!("displayOf", 1, |s, a| lookup(s, c"display", a[0]));
    export!("familyOf", 1, |s, a| family(s, a[0]));
    export!("familyNameOf", 1, |s, a| {
        let row = family_row(s, c"clis", a[0])?;
        if row.truthy()? {
            row.get(c"name")
        } else {
            s.from_value(&V::String(raw(a[0])?))
        }
    });
    for (name, key) in [("displayNameOf", c"displayName"), ("engineOf", c"engine")] {
        export!(name, 1, move |s, a| {
            let field = display_field(s, a[0], key)?;
            if field.truthy()? {
                Ok(field)
            } else {
                s.from_value(&V::String(raw(a[0])?))
            }
        });
    }
    export!("shortMarkOf", 1, |s, a| {
        let mark = display_field(s, a[0], c"shortMark")?;
        if mark.truthy()? {
            return Ok(mark);
        }
        let first = raw(a[0])?.as_units().first().copied().into_iter().collect();
        s.from_value(&V::String(JsString::from_units(first).to_uppercase()))
    });
    export!("colourOf", 1, |s, a| {
        let colour = display_field(s, a[0], c"colour")?;
        if colour.truthy()? {
            Ok(colour)
        } else {
            s.get(c"catalog")?.get(c"defaultColour")
        }
    });
    export!("effortOf", 1, |s, a| own(
        s.get(c"efforts")?,
        normalized(a[0])?
    ));
    export!("isProviderless", 1, |s, a| flag(
        s,
        display_field(s, a[0], c"providerless")?.is_true()?
    ));
    export!("providerlessClis", 0, |s, _| {
        let display = s.get(c"catalog")?.get(c"display")?;
        let set = s.global()?.get(c"Set")?.construct(&[])?;
        keys(display)?.for_each(|key| {
            if display.get_key(key)?.get(c"providerless")?.is_true()? {
                call(set, c"add", &[key])?;
            }
            Ok(())
        })?;
        Ok(set)
    });
    export!("deprecationOf", 1, |s, a| {
        let row = lookup(s, c"display", a[0])?;
        if row.optional(c"deprecated")?.is_true()? {
            fields(
                s,
                &[("replacedBy", fallback(row.get(c"replacedBy")?, V::Null)?)],
            )
        } else {
            null(s)
        }
    });
    export!("isDeprecated", 1, |s, a| flag(
        s,
        display_field(s, a[0], c"deprecated")?.is_true()?
    ));
    export!("kindsOf", 1, |s, a| kinds(s, a[0]));
    export!("offersIn", 2, |s, a| call(
        kinds(s, a[0])?,
        c"includes",
        &[normalized(a[1])?]
    ));
    export!("isAlias", 1, |s, a| {
        let key = s.from_value(&V::String(raw(a[0])?.to_lowercase()))?;
        flag(s, own(s.get(c"catalog")?.get(c"aliases")?, key)?.truthy()?)
    });
    export!("knownClis", 0, |s, _| keys(
        s.get(c"catalog")?.get(c"display")?
    ));
    export!("lanesOf", 2, |s, a| {
        let family = family_row(s, c"lanes", a[0])?;
        let kind = normalized(a[1])?;
        copy_rows(if family.nullish()? {
            family
        } else {
            own(family, kind)?
        })
    });
    export!("familiesFor", 1, |s, a| {
        let list = lookup(s, c"familiesFor", a[0])?;
        if list.nullish()? {
            s.from_value(&V::Array(vec![]))
        } else {
            call(list, c"slice", &[])
        }
    });
    export!("updateOf", 1, |s, a| family_row(s, c"updates", a[0]));
    export!("updateSpecs", 0, |s, _| s.get(c"catalog")?.get(c"updates"));
    export!("npmPackages", 0, |s, _| s
        .get(c"catalog")?
        .get(c"npmPackages"));
    export!("isBundled", 1, |s, a| flag(
        s,
        lookup(s, c"bundled", a[0])?.is_true()?
    ));
    export!("bundledEnginesOf", 1, |s, a| copy_rows(family_row(
        s,
        c"bundledEngines",
        a[0]
    )?));
    for name in ["isResident", "isResidentSession"] {
        export!(name, 1, |s, a| flag(
            s,
            cli::is_resident(&raw(a[0])?.to_string_lossy())
        ));
    }
    export!("protocolOf", 1, |s, a| capability(s, a[0])?
        .get(c"protocol"));
    export!("cancelStopsProcess", 1, |s, a| flag(
        s,
        cli::cancel_stops_process(&raw(a[0])?.to_string_lossy())
    ));
    export!("transportOf", 1, |s, a| text(
        s,
        cli::transport_of(&raw(a[0])?.to_string_lossy())
    ));
    let protocol_family =
        method(
            &env,
            state,
            "protocolFamilyOf",
            1,
            2,
            |s, a| match cli::protocol_family_of(
                &raw(a[0])?.to_string_lossy(),
                a[1].is_string("api")?,
            ) {
                Some(value) => text(s, value),
                None => null(s),
            },
        )?;
    api.set(c"protocolFamilyOf", protocol_family)?;
    let binding = fields(anchor, &[("api", api)])?;
    binding.set(
        c"efforts",
        method(&env, state, "efforts", 0, 0, |s, _| s.get(c"efforts"))?,
    )?;
    binding.set(
        c"refreshEfforts",
        method(&env, state, "refreshEfforts", 0, 0, |s, _| {
            let efforts = serde_json::to_value(&effort_catalog::snapshot().efforts)
                .map_err(|err| napi::Error::from_reason(err.to_string()))?;
            let table = freeze_tree(s.from_value(&multicc_core::js::from_serde(&efforts))?)?;
            s.set(c"efforts", table)?;
            Ok(table)
        })?,
    )?;
    Ok(binding.raw())
}

/// Complete the shared catalogue with compatibility queries. The host retains
/// watchFile's listener identity and resolves optional packages from the CLI.
#[napi]
pub fn cli_catalog_queries(
    env: Env,
    addon: Unknown<'_>,
    api: Unknown<'_>,
) -> Result<sys::napi_value> {
    let owner = L::new(&env, addon);
    let api = L::new(&env, api);
    api.set(
        c"knownEffort",
        crate::host_methods::function(owner, "knownEffort", 1, 1, |s, a| {
            call(s, c"cliKnownEffort", a)
        })?,
    )?;
    api.set(
        c"supportsEffort",
        crate::host_methods::function(owner, "supportsEffort", 3, 3, |s, a| {
            a[1] = fallback(a[1], V::from(""))?;
            call(s, c"cliSupportsEffort", a)
        })?,
    )?;
    Ok(api.raw())
}
