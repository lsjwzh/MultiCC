//! SessionRecordMap is a live view of the owner's table. V8 provides its Map
//! prototype and weak association. Import and task state share the same owner.
use crate::host_api::*;
use crate::host_methods::{arg, env as host_env};
use napi_derive::napi;

fn required_owner<'a>(ports: L<'a>, records: L<'a>) -> Result<L<'a>> {
    let owner = ports.get(c"ownerOf")?.call_plain(&[records])?;
    if owner.truthy()? {
        Ok(owner)
    } else {
        Err(ports.type_error("session record owner is required"))
    }
}

fn defaults(p: L<'_>) -> Result<L<'_>> {
    let raw = crate::session_records::session_records_task_state_defaults(host_env(p))?;
    Ok(L::from_raw(p.env(), raw))
}

#[napi]
pub fn session_table_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    api.set(
        c"createTaskStateStore",
        function(p, "createTaskStateStore", 1, 1, |p, a| {
            let mut shared = p.get(c"defaults")?;
            if shared.undefined()? {
                shared = defaults(p)?.freeze()?;
                p.set(c"defaults", shared)?;
            }
            let result = crate::task_state_store::task_state_store(
                host_env(p),
                arg(a[0])?,
                arg(p.get(c"ownerOf")?)?,
                arg(shared)?,
                arg(p.get(c"payload")?)?,
                arg(p.get(c"emit")?)?,
            )?;
            Ok(L::from_raw(p.env(), result))
        })?,
    )?;
    api.set(c"SessionRecordMap", p.get(c"SessionRecordMap")?)?;
    api.set(
        c"createSessionRecords",
        function(p, "createSessionRecords", 2, 2, |p, a| {
            let (source, shared) = (a[0], a[1]);
            if !shared.truthy()? || !shared.get(c"native")?.truthy()? {
                return Err(p.type_error("session record owner is required"));
            }
            let records = p.get(c"SessionRecordMap")?.construct(&[shared])?;
            let migrated = if source.truthy()? {
                let owner = shared.get(c"native")?;
                let init = owner.get(c"init")?;
                let entries = if source.instance_of(p.global()?.get(c"Map")?)? {
                    call(source, c"entries", &[])?
                } else {
                    source
                };
                init.call(owner, &[entries])?.is_true()?
            } else {
                false
            };
            records.assign(c"loadMigrated", flag(p, migrated)?)?;
            Ok(records)
        })?,
    )?;
    api.set(c"sessionRecordsOwner", p.get(c"ownerOf")?)?;
    api.set(
        c"sessionRecordDefaults",
        function(p, "sessionRecordDefaults", 0, 0, |p, _| defaults(p))?,
    )?;
    for (name, count) in [(c"appendClassifyHistory", 4), (c"resetTaskState", 2)] {
        api.set(
            name,
            function(p, name.to_str().unwrap(), count, count, move |p, a| {
                call(required_owner(p, a[0])?, name, &a[1..])
            })?,
        )?;
    }
    Ok(api.raw())
}
