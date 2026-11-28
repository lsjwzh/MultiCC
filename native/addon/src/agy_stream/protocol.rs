//! 将 agy 的启动和事件约定接入宿主已有的常驻进程池。
use crate::host_api::*;
use napi_derive::napi;

#[napi]
pub fn agy_resident_protocol(env: Env) -> Result<sys::napi_value> {
    let p = L::from_raw(env.raw(), unsafe {
        crate::js_bridge::write_value(env.raw(), &V::Undefined)?
    });
    let api = methods(
        p,
        &[
            ("fingerprint", 1, |p, _| text(p, "")),
            ("resumeArgs", 2, |p, a| {
                let args = call(a[0], c"slice", &[])?;
                if a[1].truthy()? {
                    call(args, c"push", &[text(p, "--conversation")?, a[1]])?;
                }
                Ok(args)
            }),
            ("configure", 3, |p, a| {
                let (s, cfg) = (a[0], a[1]);
                let id = fallback(cfg.get(c"sessionId")?, V::Null)?;
                if a[2].truthy()?
                    && (!s.get(c"threadId")?.equals(id)?
                        || !s.get(c"launchKey")?.equals(cfg.get(c"launchKey")?)?
                        || cfg.get(c"rotateCapability")?.is_true()?)
                {
                    s.set(c"recycleRequested", flag(p, true)?)?;
                }
                s.set(c"threadId", id)?;
                s.set(c"launchKey", cfg.get(c"launchKey")?)?;
                undef(p)
            }),
            ("read", 1, |p, a| {
                let evt = a[0];
                let kind = evt.optional(c"event")?;
                if kind.string()?.is_none() {
                    return null(p);
                }
                let id = if kind.is_string("init")? || kind.is_string("multicc_conversation")? {
                    evt.get(c"conversation_id")?
                } else {
                    null(p)?
                };
                fields(
                    p,
                    &[
                        ("forward", flag(p, true)?),
                        ("retire", evt.optional(c"multicc_retire")?),
                        ("nativeId", id),
                        ("done", flag(p, kind.is_string("result")?)?),
                    ],
                )
            }),
        ],
    )?;
    api.set(c"exitEvent", text(p, "close")?)?;
    api.set(c"cancelCurrentOnly", flag(p, true)?)?;
    Ok(api.raw())
}
