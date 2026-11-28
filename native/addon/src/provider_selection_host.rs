//! The core validates a projected catalog and may request additional registry
//! facts. Retain the original V8 provider references for those callbacks.
use crate::host_api::*;
use multicc_core::auto_provider_config as config;
use napi::{bindgen_prelude::ToNapiValue, sys::ValueType};
use napi_derive::napi;

type Rule = fn(&str) -> std::result::Result<String, String>;

fn omitted(value: L<'_>) -> Result<bool> {
    Ok(matches!(
        value.kind()?,
        ValueType::napi_undefined | ValueType::napi_function | ValueType::napi_symbol
    ))
}

fn encode(value: L<'_>, depth: usize) -> Result<L<'_>> {
    if omitted(value)? {
        return null(value);
    }
    if let Some(n) = value.number_value()? {
        if n.is_finite() {
            return Ok(value);
        }
        return fields(
            value,
            &[(
                "__jsnum__",
                text(
                    value,
                    if n.is_nan() {
                        "NaN"
                    } else if n > 0. {
                        "Infinity"
                    } else {
                        "-Infinity"
                    },
                )?,
            )],
        );
    }
    if value.kind()? == ValueType::napi_bigint {
        return fields(value, &[("__jsbigint__", call(value, c"toString", &[])?)]);
    }
    if !object(value)? {
        return Ok(value);
    }
    if depth > 1024 {
        return Err(value
            .global()?
            .get(c"RangeError")?
            .construct(&[text(value, "Maximum call stack size exceeded")?])?
            .throw_error());
    }
    if value.is_array()? {
        let recurse = function(value, "encode", 1, 1, move |_, a| encode(a[0], depth + 1))?;
        return call(value, c"map", &[recurse]);
    }
    let out = fields(value, &[])?;
    let keys = call(value.global()?.get(c"Object")?, c"keys", &[value])?;
    for i in 0..keys.get(c"length")?.number()? as u32 {
        let key = keys.element(i)?;
        let child = value.get_key(key)?;
        if !omitted(child)? {
            out.set_key(key, encode(child, depth + 1)?)?;
        }
    }
    Ok(out)
}

fn wire<'a>(p: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let env = fields(p, &[("facts", p.get(c"facts")?)])?;
    env.spread_from(payload)?;
    json_call(p, c"stringify", env)
}
fn parse_rule(payload: L<'_>, rule: Rule) -> Result<L<'_>> {
    let wire = json_call(payload, c"stringify", payload)?
        .coerce_string()?
        .to_string_lossy();
    let value = rule(&wire).map_err(napi::Error::from_reason)?;
    json_call(payload, c"parse", text(payload, &value)?)
}
fn apply<'a>(p: L<'a>, payload: L<'a>, rule: Rule) -> Result<L<'a>> {
    let encoded = wire(p, payload)?.coerce_string()?.to_string_lossy();
    let result = rule(&encoded).map_err(napi::Error::from_reason)?;
    json_call(p, c"parse", text(p, &result)?)
}

fn originals(items: L<'_>) -> Result<L<'_>> {
    let pairs = call(
        items,
        c"map",
        &[function(items, "providerEntry", 1, 1, |_, a| {
            let id = string(crate::js_iteration::read(a[0], c"id")?)?;
            let pair = array(id)?;
            pair.set_element(0, id)?;
            pair.set_element(1, a[0])?;
            Ok(pair)
        })?],
    )?;
    items.global()?.get(c"Map")?.construct(&[pairs])
}

fn catalog<'a>(providers: L<'a>, cli: L<'a>) -> Result<L<'a>> {
    let typ = call(providers, c"appTypeForCli", &[cli])?;
    let has = callable(providers.get(c"appTypesForCli")?)?;
    let types = if has {
        call(providers, c"appTypesForCli", &[cli])?
    } else {
        undef(cli)?
    };
    let plan = parse_rule(
        fields(
            cli,
            &[
                ("cli", encode(cli, 0)?),
                ("appType", encode(typ, 0)?),
                ("appTypes", encode(types, 0)?),
                ("hasAppTypesForCli", flag(cli, has)?),
            ],
        )?,
        config::catalog_app_types,
    )?;
    let list = plan.get(c"list")?;
    let items = if list.get(c"length")?.truthy()? {
        call(
            list,
            c"flatMap",
            &[function(providers, "providersOfType", 1, 1, |p, a| {
                call(p, c"listProviders", &[a[0]])
            })?],
        )?
    } else {
        call(providers, c"listProviders", &[typ])?
    };
    let items = if items.is_array()? {
        items
    } else {
        array(cli)?
    };
    fields(
        cli,
        &[
            ("appType", typ),
            ("cli", cli),
            ("items", items),
            ("originals", originals(items)?),
        ],
    )
}

fn providers_of(opts: L<'_>) -> Result<L<'_>> {
    if opts.truthy()? {
        opts.get(c"providers")
    } else {
        Ok(opts)
    }
}
fn usable(p: L<'_>) -> Result<bool> {
    Ok(p.truthy()? && callable(p.get(c"listProviders")?)? && callable(p.get(c"appTypeForCli")?)?)
}
fn answer_probe<'a>(probe: L<'a>, providers: L<'a>, catalogs: L<'a>) -> Result<L<'a>> {
    let kind = probe.get(c"kind")?;
    if kind.is_string("catalog")? {
        let read = catalog(providers, probe.get(c"cli")?)?;
        call(catalogs, c"set", &[probe.get(c"cli")?, read])?;
        let typ = encode(read.get(c"appType")?, 0)?;
        let cli = read.get(c"cli")?;
        let items = read.get(c"items")?;
        let projection = function(items, "projectProvider", 1, 1, |_, a| {
            let item = a[0];
            let out = fields(item, &[])?;
            if object(item)? {
                for k in [
                    c"id",
                    c"protocol",
                    c"apiFormat",
                    c"isOfficial",
                    c"appType",
                    c"compatibleClis",
                ] {
                    if item.has(k)? {
                        out.set(k, encode(item.get(k)?, 0)?)?;
                    }
                }
            }
            Ok(out)
        })?;
        let projected = call(items, c"map", &[projection])?;
        return fields(
            probe,
            &[(
                "catalog",
                fields(
                    probe,
                    &[("appType", typ), ("cli", cli), ("providers", projected)],
                )?,
            )],
        );
    }
    let value = if kind.is_string("supportsCli")? {
        let read = call(catalogs, c"get", &[probe.get(c"cli")?])?;
        let candidate = probe.get(c"provider")?;
        let id = if candidate.truthy()? {
            probe.get(c"provider")?.get(c"id")?
        } else {
            candidate
        };
        let original = if read.truthy()? {
            call(read.get(c"originals")?, c"get", &[string(id)?])?
        } else {
            undef(probe)?
        };
        let provider = if original.undefined()? {
            probe.get(c"provider")?
        } else {
            original
        };
        call(
            providers,
            c"providerSupportsCli",
            &[provider, probe.get(c"cli")?],
        )?
    } else if kind.is_string("modelValid")? {
        call(
            providers,
            c"modelValidForProvider",
            &[
                probe.get(c"appType")?,
                probe.get(c"providerId")?,
                probe.get(c"model")?,
            ],
        )?
    } else {
        return Err(napi::Error::from_reason(format!(
            "unknown auto-provider probe: {}",
            kind.coerce_string()?.to_string_lossy()
        )));
    };
    fields(probe, &[("value", encode(value, 0)?)])
}

fn validate<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[1])?;
    let providers = providers_of(opts)?;
    let flags = fields(
        p,
        &[
            ("usable", flag(p, usable(providers)?)?),
            (
                "hasProviderSupportsCli",
                flag(
                    p,
                    providers.truthy()? && callable(providers.get(c"providerSupportsCli")?)?,
                )?,
            ),
            (
                "hasModelValidForProvider",
                flag(
                    p,
                    providers.truthy()? && callable(providers.get(c"modelValidForProvider")?)?,
                )?,
            ),
        ],
    )?;
    let args = fields(
        p,
        &[
            ("input", encode(args[0], 0)?),
            ("options", encode(opts, 0)?),
            ("providers", flags),
        ],
    )?;
    let answers = array(p)?;
    args.set(c"answers", answers)?;
    let catalogs = p.global()?.get(c"Map")?.construct(&[])?;
    loop {
        let reply = apply(p, args, config::validate_provider_selection)?;
        let probe = reply.get(c"probe")?;
        if !probe.truthy()? {
            return crate::turn_request::deep_freeze(reply.get(c"result")?);
        }
        call(
            answers,
            c"push",
            &[answer_probe(probe, providers, catalogs)?],
        )?;
    }
}
fn selection_request<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    wire(p, fields(p, &[("input", encode(input, 0)?)])?)
}

#[napi]
pub fn provider_selection_host(env: Env) -> Result<sys::napi_value> {
    let scope = L::new(&env, ().into_unknown(&env)?);
    let table = multicc_core::provider_misc::routing_facts();
    let facts = scope.from_value(&multicc_core::js::serde::from_serde(&table))?;
    let p = fields(facts, &[("facts", facts)])?;
    let snapshot = parse_rule(facts, config::facts)?;
    let api = fields(p, &[])?;
    for (name, key, is_set) in [
        (c"AUTO_CLIS", c"autoClis", true),
        (c"CLI_SWITCH_POLICIES", c"cliSwitchPolicies", true),
        (c"CUSTOM_ROUTING_GATEWAY", c"customRoutingGateway", false),
        (
            c"DEFAULT_CUSTOM_ROUTING_API_KEY",
            c"defaultCustomRoutingApiKey",
            false,
        ),
        (
            c"DEFAULT_CUSTOM_ROUTING_MODEL",
            c"defaultCustomRoutingModel",
            false,
        ),
        (c"DEFAULT_ROUTING_API_KEY", c"defaultRoutingApiKey", false),
        (c"DEFAULT_ROUTING_GATEWAY", c"defaultRoutingGateway", false),
        (c"MAX_ATTEMPTS", c"maxAttempts", false),
        (c"MAX_CANDIDATES", c"maxCandidates", false),
        (
            c"MAX_ROUTING_ENDPOINT_CHARS",
            c"maxRoutingEndpointChars",
            false,
        ),
        (c"MAX_TIERS", c"maxTiers", false),
        (c"PROTOCOLS", c"protocols", true),
        (c"ROUTING_GATEWAYS", c"routingGateways", true),
    ] {
        let value = snapshot.get(key)?;
        api.set(
            name,
            if is_set {
                p.global()?.get(c"Set")?.construct(&[value])?
            } else {
                value
            },
        )?;
    }
    let simple =
        |name: &'static str, key: &'static str, rule: Rule, freeze: bool, default_input: bool| {
            function(p, name, usize::from(!default_input), 1, move |p, a| {
                let v = if default_input {
                    default_object(a[0])?
                } else {
                    a[0]
                };
                let result = apply(p, fields(p, &[(key, encode(v, 0)?)])?, rule)?;
                if freeze {
                    crate::turn_request::deep_freeze(result)
                } else {
                    Ok(result)
                }
            })
        };
    api.set(
        c"catalogFor",
        function(p, "catalogFor", 1, 1, |p, a| {
            let providers = providers_of(a[0])?;
            let cli = string(fallback(a[0].optional(c"cli")?, "".into())?)?;
            if !usable(providers)? {
                return null(p);
            }
            let read = catalog(providers, cli)?;
            fields(
                p,
                &[
                    ("appType", read.get(c"appType")?),
                    ("providers", providers),
                    ("cli", cli),
                    ("byId", originals(read.get(c"items")?)?),
                ],
            )
        })?,
    )?;
    api.set(
        c"customEndpointError",
        simple(
            "customEndpointError",
            "endpoint",
            config::custom_endpoint_error,
            false,
            false,
        )?,
    )?;
    api.set(
        c"jevTarget",
        simple("jevTarget", "routing", config::jev_target, true, false)?,
    )?;
    api.set(
        c"normalizeStoredProviderSelection",
        simple(
            "normalizeStoredProviderSelection",
            "input",
            config::normalize_stored_provider_selection,
            true,
            false,
        )?,
    )?;
    api.set(
        c"primaryProviderCandidate",
        function(p, "primaryProviderCandidate", 1, 2, |p, a| {
            let args = fields(
                p,
                &[("selection", encode(a[0], 0)?), ("cli", encode(a[1], 0)?)],
            )?;
            let index = apply(p, args, config::primary_provider_candidate)?.get(c"index")?;
            if index.nullish()? {
                null(p)
            } else {
                a[0].get(c"candidates")?.get_key(index)
            }
        })?,
    )?;
    api.set(
        c"protocolOf",
        simple("protocolOf", "provider", config::protocol_of, false, false)?,
    )?;
    api.set(
        c"providerSelectionDto",
        function(p, "providerSelectionDto", 1, 1, |p, a| {
            crate::session_dto::selection_dto(selection_request(p, a[0])?)
        })?,
    )?;
    api.set(
        c"providerSelectionRequest",
        function(p, "providerSelectionRequest", 1, 1, |p, a| {
            selection_request(p, a[0])
        })?,
    )?;
    api.set(
        c"selectionClis",
        simple(
            "selectionClis",
            "selection",
            config::selection_clis,
            false,
            false,
        )?,
    )?;
    api.set(
        c"selectionKey",
        simple(
            "selectionKey",
            "input",
            multicc_core::auto_provider_selection_key::selection_key,
            false,
            false,
        )?,
    )?;
    api.set(
        c"trustDomainOf",
        simple(
            "trustDomainOf",
            "provider",
            config::trust_domain_of,
            false,
            false,
        )?,
    )?;
    api.set(
        c"validateProviderSelection",
        function(p, "validateProviderSelection", 1, 2, validate)?,
    )?;
    api.set(
        c"validateRoutingTarget",
        simple(
            "validateRoutingTarget",
            "input",
            config::validate_routing_target,
            true,
            true,
        )?,
    )?;
    Ok(api.raw())
}
