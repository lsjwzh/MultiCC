//! Provision the reserved gateway inside the host's synchronous mutation.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;

const ID: &str = "__voice_router__";
const LABEL: &str = "🎙️ 实时语音 Router";

fn valid(record: L<'_>) -> Result<bool> {
    Ok(record.truthy()?
        && read(record, c"id")?.is_string(ID)?
        && read(record, c"type")?.is_string("gateway")?
        && read(record, c"kind")?.is_string("chat")?)
}
#[napi]
pub fn is_voice_router(env: Env, value: Unknown<'_>) -> Result<bool> {
    valid(L::new(&env, value))
}

fn outcome<'a>(p: L<'a>, record: L<'a>, created: bool) -> Result<L<'a>> {
    if valid(record)? {
        fields(
            p,
            &[
                ("ok", flag(p, true)?),
                ("created", flag(p, created)?),
                ("record", record),
            ],
        )
    } else {
        fields(
            p,
            &[
                ("ok", flag(p, false)?),
                ("code", text(p, "voice_router_id_conflict")?),
            ],
        )
    }
}
fn ensure(p: L<'_>) -> Result<L<'_>> {
    let id = text(p, ID)?;
    let existing = call(p, c"lookup", &[id])?;
    if existing.truthy()? {
        return outcome(p, existing, false);
    }
    p.catch(|| call(p, c"mkdir", &[]))?;
    let stamp = p.get(c"now")?.call_plain(&[])?;
    let state = fields(
        p,
        &[
            ("stamp", stamp),
            ("ports", p),
            ("cli", p.get(c"cli")?),
            ("cwd", p.get(c"cwd")?),
            ("record", null(p)?),
            ("created", flag(p, false)?),
        ],
    )?;
    let mutate = function(state, "", 1, 1, |s, a| {
        let id = text(s, ID)?;
        let collision = call(s.get(c"ports")?, c"draftGet", &[a[0], id])?;
        if collision.truthy()? {
            s.set(c"record", collision)?;
        } else {
            let stamp = s.get(c"stamp")?;
            let record = fields(
                s,
                &[
                    ("id", id),
                    ("type", text(s, "gateway")?),
                    ("kind", text(s, "chat")?),
                    ("cli", s.get(c"cli")?),
                    ("cliSessionId", null(s)?),
                    ("dirId", null(s)?),
                    ("label", text(s, LABEL)?),
                    ("cwd", s.get(c"cwd")?),
                    ("createdAt", stamp),
                    ("updatedAt", stamp),
                ],
            )?;
            s.set(c"record", record)?;
            call(s.get(c"ports")?, c"draftSet", &[a[0], id, record])?;
            s.set(c"created", flag(s, true)?)?;
        }
        s.from_value(&V::Undefined)
    })?;
    p.get(c"mutate")?
        .call_plain(&[text(p, "voice.router-provision")?, mutate])?;
    outcome(p, state.get(c"record")?, state.get(c"created")?.truthy()?)
}
#[napi]
pub fn voice_router_provisioner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            ("cwd", p.get(c"cwd")?),
            ("ensure", function(p, "ensure", 0, 0, |p, _| ensure(p))?),
            (
                "get",
                function(p, "get", 0, 0, |p, _| {
                    let r = call(p, c"lookup", &[text(p, ID)?])?;
                    if valid(r)? {
                        Ok(r)
                    } else {
                        null(p)
                    }
                })?,
            ),
            ("id", text(p, ID)?),
        ],
    )?
    .freeze()?
    .raw())
}

#[napi]
pub fn voice_router_api(
    env: Env,
    addon: Unknown<'_>,
    unpack: Unknown<'_>,
    prepare: Unknown<'_>,
) -> Result<sys::napi_value> {
    let n = L::new(&env, addon);
    let state = fields(
        n,
        &[
            ("unpack", L::new(&env, unpack)),
            ("prepare", L::new(&env, prepare)),
        ],
    )?;
    let create = function(state, "createVoiceRouterProvisioner", 0, 1, |s, a| {
        let input = s.get(c"unpack")?.call_plain(&[a[0]])?;
        let records = read(input, c"records")?;
        let mutate = input.get(c"mutate")?;
        let root = input.get(c"runtimeRoot")?;
        let cli = input.get(c"cli")?;
        let now = input.get(c"now")?;
        if !records.instance_of(s.global()?.get(c"Map")?)? {
            return Err(s.type_error("voice router provisioner requires records Map"));
        }
        if mutate.kind()? != sys::ValueType::napi_function {
            return Err(s.type_error("voice router provisioner requires mutate"));
        }
        let ports = s.get(c"prepare")?.call_plain(&[
            records,
            mutate,
            root,
            if cli.undefined()? {
                text(s, "claude")?
            } else {
                cli
            },
            now,
        ])?;
        Ok(crate::host_methods::raw(
            s,
            voice_router_provisioner(
                crate::host_methods::env(s),
                crate::host_methods::arg(ports)?,
            )?,
        ))
    })?;
    let test = function(n, "isVoiceRouterRecord", 1, 1, |s, a| flag(s, valid(a[0])?))?;
    Ok(fields(
        n,
        &[
            ("VOICE_ROUTER_ID", text(n, ID)?),
            ("VOICE_ROUTER_LABEL", text(n, LABEL)?),
            ("createVoiceRouterProvisioner", create),
            ("isVoiceRouterRecord", test),
        ],
    )?
    .raw())
}
