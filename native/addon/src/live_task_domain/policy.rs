use super::*;
use crate::task_routing::{
    normalize_host_attribution_mode, HostAttributionSettings,
};
use multicc_core::task_routing::{DEFAULT_MODE, MODES};
use std::rc::Rc;

fn settings<'a>(p: L<'a>, initial: L<'a>) -> Result<L<'a>> {
    let owner = Rc::new(HostAttributionSettings::new(env(p), arg(initial)?)?);
    let read = owner.clone();
    let out = fields(p, &[])?;
    expose(p, out, "getMode", 0, 0, move |p, _| {
        text(p, &read.get_mode())
    })?;
    expose(p, out, "setMode", 1, 1, move |p, a| {
        Ok(raw(p, owner.set_mode(env(p), arg(a[0])?)?))
    })?;
    Ok(out)
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    expose(p, out, "getAttributionModePolicy", 0, 0, |p, _| {
        let prior = p.get(c"policy")?;
        if prior.truthy()? {
            return Ok(prior);
        }
        let modes = p
            .from_value(&V::Array(MODES.iter().map(|mode| V::from(*mode)).collect()))?
            .freeze()?;
        let policy = fields(
            p,
            &[("MODES", modes), ("DEFAULT_MODE", text(p, DEFAULT_MODE)?)],
        )?;
        expose(p, policy, "normalizeAttributionMode", 1, 2, |p, a| {
            let fallback = if a[1].undefined()? {
                text(p, DEFAULT_MODE)?
            } else {
                a[1]
            };
            Ok(raw(
                p,
                normalize_host_attribution_mode(env(p), arg(a[0])?, arg(fallback)?)?,
            ))
        })?;
        policy.set(c"planAttributionAction", p.get(c"planAttributionAction")?)?;
        p.set(c"policy", policy)?;
        Ok(policy)
    })?;
    expose(p, out, "createAttributionSettings", 0, 1, |p, a| {
        let initial = default_object(a[0])?.get(c"initial")?;
        settings(
            p,
            if initial.undefined()? {
                null(p)?
            } else {
                initial
            },
        )
    })?;
    expose(p, out, "createAttributionSettingsFromEnv", 0, 0, |p, _| {
        settings(
            p,
            p.get(c"environment")?
                .get(c"MULTICC_TASK_ATTRIBUTION_MODE")?,
        )
    })?;
    Ok(())
}
