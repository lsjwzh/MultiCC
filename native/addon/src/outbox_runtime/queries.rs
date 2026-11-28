//! Query a store snapshot without leaking the private lease token hash.
use super::*;

pub(super) fn rows<'a>(draft: L<'a>, where_: L<'a>) -> Result<L<'a>> {
    if callable(read(draft, c"select")?)? {
        call(
            draft,
            c"select",
            &[text(draft, "outbox")?, fields(draft, &[("where", where_)])?],
        )
    } else {
        call(
            draft.global()?.get(c"Object")?,
            c"values",
            &[read(draft, c"outbox")?],
        )
    }
}
pub(super) fn public_item(item: L<'_>) -> Result<L<'_>> {
    let copy = json_call(item, c"parse", json_call(item, c"stringify", item)?)?;
    copy.delete(c"leaseTokenHash")?;
    Ok(copy)
}
fn projection(item: L<'_>) -> Result<L<'_>> {
    if !item.truthy()? {
        return null(item);
    }
    let copy = spread(item)?;
    copy.delete(c"leaseTokenHash")?;
    Ok(copy)
}
pub(super) fn list<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(a[0])?;
        let session = read(opts, c"sessionId")?;
        let states = read(opts, c"states")?;
        let wanted = if states.undefined()? {
            null(p)?
        } else {
            let ctor = p.global()?.get(c"Set")?;
            let values = if states.is_array()? {
                states
            } else {
                let values = p.from_value(&V::Array(vec![]))?;
                values.set_element(0, states)?;
                values
            };
            ctor.construct(&[values])?
        };
        let query = fields(p, &[("session", session), ("wanted", wanted)])?;
        let f = function(query, "", 1, 1, |q, a| {
            let draft = a[0];
            let criteria = fields(q, &[])?;
            let session = q.get(c"session")?;
            let wanted = q.get(c"wanted")?;
            if session.truthy()? {
                criteria.set(c"sessionId", session)?;
            }
            if wanted.truthy()? {
                let states = q.from_value(&V::Array(vec![]))?;
                let mut index = 0;
                wanted.for_each(|s| {
                    states.set_element(index, s)?;
                    index += 1;
                    Ok(())
                })?;
                criteria.set(c"state", states)?;
            }
            let all = rows(draft, criteria)?;
            let by_session = function(q, "", 1, 1, |q, a| {
                let session = q.get(c"session")?;
                flag(
                    q,
                    !session.truthy()? || read(a[0], c"sessionId")?.equals(session)?,
                )
            })?;
            let for_session = call(all, c"filter", &[by_session])?;
            let by_state = function(q, "", 1, 1, |q, a| {
                let wanted = q.get(c"wanted")?;
                if wanted.truthy()? {
                    call(wanted, c"has", &[read(a[0], c"state")?])
                } else {
                    flag(q, true)
                }
            })?;
            let selected = call(for_session, c"filter", &[by_state])?;
            let sorted = crate::outbox_claim_live::sorted(draft, selected)?;
            call(
                sorted,
                c"map",
                &[function(q, "itemProjection", 1, 1, |_, a| {
                    projection(a[0])
                })?],
            )
        })?;
        call(p.get(c"store")?, c"read", &[f])
    })
}
pub(super) fn get<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let f = function(a[0], "", 1, 1, |id, a| {
            projection(read(a[0], c"outbox")?.get_key(id)?)
        })?;
        call(p.get(c"store")?, c"read", &[f])
    })
}
pub(super) fn delivery<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let store = p.get(c"store")?;
        if callable(read(store, c"select")?)? {
            let where_ = fields(p, &[("id", a[0])])?;
            let columns = p.from_value(&V::Array(
                ["id", "sessionId", "state"]
                    .into_iter()
                    .map(V::string)
                    .collect(),
            ))?;
            let options = fields(
                p,
                &[
                    ("where", where_),
                    ("fields", columns),
                    ("limit", num(p, 1.)?),
                ],
            )?;
            let v = call(store, c"select", &[text(p, "outbox")?, options])?;
            then(v, p, |_, a| fallback(read(a[0], c"0")?, V::Null))
        } else {
            let f = function(a[0], "", 1, 1, |id, a| {
                let item = read(a[0], c"outbox")?.get_key(id)?;
                if item.truthy()? {
                    pick(item, &[c"id", c"sessionId", c"state"])
                } else {
                    null(id)
                }
            })?;
            call(store, c"read", &[f])
        }
    })
}
