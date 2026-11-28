use super::*;

fn reason<'a>(p: L<'a>, code: &str, traits: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let o = fields(p, &[("code", text(p, code)?)])?;
    for &(k, v) in traits {
        o.define_key(text(p, k)?, v)?;
    }
    Ok(o)
}
pub(super) fn unmet<'a>(r: L<'a>, h: L<'a>) -> Result<L<'a>> {
    if !r.truthy()? {
        return null(h);
    }
    for k in items(keys(r)?)? {
        if !matches!(
            text_of(k)?.as_str(),
            "multicc" | "pluginApi" | "agentBuild" | "platforms" | "apps" | "permissions"
        ) {
            if k.truthy()? {
                return reason(h, "unknownRequirement", &[("requirement", k)]);
            }
            break;
        }
    }
    let platforms = r.get(c"platforms")?;
    if platforms.truthy()? {
        let find = platforms.get(c"find")?;
        if !callable(find)? {
            return Err(h.type_error("requires.platforms.find is not a function"));
        }
        let matches_os = function(h, "", 1, 1, |h, args| {
            flag(h, args[0].get(c"os")?.equals(h.get(c"os")?)?)
        })?;
        let x = find.call(platforms, &[matches_os])?;
        if !x.truthy()? {
            let current = h.get(c"os")?;
            let supported = call(
                platforms,
                c"map",
                &[function(h, "", 1, 1, |_, args| args[0].get(c"os"))?],
            )?;
            return reason(h, "os", &[("current", current), ("supported", supported)]);
        }
        let arch = x.get(c"arch")?;
        if !arch.nullish()? {
            let arches = string_list(call(array(h)?, c"concat", &[arch])?)?;
            if !call(arches, c"includes", &[h.get(c"arch")?])?.truthy()? {
                return reason(
                    h,
                    "arch",
                    &[("current", h.get(c"arch")?), ("supported", arches)],
                );
            }
        }
        let min = x.get(c"minOS")?;
        if min.truthy()? && !(compare(&text_of(h.get(c"osVersion")?)?, &text_of(min)?) >= 0.) {
            return reason(
                h,
                "minOS",
                &[
                    ("os", h.get(c"os")?),
                    ("required", min),
                    ("current", or_null(h.get(c"osVersion")?)?),
                ],
            );
        }
    }
    let min = r.get(c"multicc")?;
    if min.truthy()? && !satisfies(&text_of(h.get(c"multicc")?)?, &text_of(min)?) {
        return reason(
            h,
            "multicc",
            &[("required", min), ("current", h.get(c"multicc")?)],
        );
    }
    let api = r.get(c"pluginApi")?;
    if !api.nullish()? && !(h.get(c"pluginApi")?.number()? >= api.number()?) {
        return reason(
            h,
            "pluginApi",
            &[("required", api), ("current", h.get(c"pluginApi")?)],
        );
    }
    let build = r.get(c"agentBuild")?;
    if build.truthy()? {
        let got = h.get(c"agentBuild")?;
        if got.nullish()? {
            return reason(h, "agentMissing", &[("required", build)]);
        }
        if !satisfies(&text_of(got)?, &text_of(build)?) {
            return reason(h, "agentBuild", &[("required", build), ("current", got)]);
        }
    }
    for app in items(fallback_to(r.get(c"apps")?, array(h)?)?)? {
        let id = app.get(c"id")?;
        let table = h.get(c"apps")?;
        let found = if table.truthy()? {
            table.get_key(id)?
        } else {
            table
        };
        let min = app.get(c"minVersion")?;
        let names = [
            ("app", id),
            ("name", fallback_to(str_nonempty(app.get(c"name")?)?, id)?),
            ("nameEn", str_nonempty(app.get(c"nameEn")?)?),
        ];
        if !found.truthy()? {
            let o = reason(h, "appMissing", &names)?;
            o.set(c"required", or_null(min)?)?;
            return Ok(o);
        }
        if min.truthy()? && !(compare(&text_of(found.get(c"version")?)?, &text_of(min)?) >= 0.) {
            let o = reason(h, "appVersion", &names)?;
            o.set(c"required", min)?;
            o.set(c"current", or_null(found.get(c"version")?)?)?;
            return Ok(o);
        }
    }
    null(h)
}
pub(super) fn apps<'a>(catalog: L<'a>, installed: L<'a>) -> Result<L<'a>> {
    let found = catalog.global()?.get(c"Map")?.construct(&[])?;
    let add = |r: L<'a>| -> Result<()> {
        let apps = r.optional(c"apps")?;
        if apps.is_array()? {
            for app in items(apps)? {
                let id = app.optional(c"id")?;
                if id.truthy()?
                    && valid_bundle(&text_of(id)?)
                    && !call(found, c"has", &[id])?.truthy()?
                {
                    call(found, c"set", &[id, app])?;
                }
            }
        }
        Ok(())
    };
    if catalog.truthy()? {
        for e in items(catalog.get(c"plugins")?)? {
            add(e.get(c"requires")?)?;
            for r in items(e.get(c"releases")?)? {
                add(r.get(c"requires")?)?
            }
        }
    }
    for i in items(installed)? {
        add(i.get(c"requires")?)?;
    }
    call(
        catalog.global()?.get(c"Array")?,
        c"from",
        &[call(found, c"values", &[])?],
    )
}
fn row_state<'a>(row: L<'a>, state: &str, why: L<'a>) -> Result<()> {
    row.set(c"state", text(row, state)?)?;
    row.set(c"reason", why)
}
fn listed<'a>(e: L<'a>, local: L<'a>, host: L<'a>, platform: L<'a>) -> Result<L<'a>> {
    let row = pick(
        e,
        &[
            c"id",
            c"name",
            c"nameEn",
            c"icon",
            c"category",
            c"provides",
            c"distribution",
            c"summary",
            c"summaryEn",
            c"homepage",
        ],
    )?;
    row.set(c"listed", flag(e, true)?)?;
    row.set(c"local", local)?;
    row.set(c"state", null(e)?)?;
    row.set(c"reason", null(e)?)?;
    row.set(
        c"installedVersion",
        if local.truthy()? {
            local.get(c"version")?
        } else {
            null(e)?
        },
    )?;
    for k in [c"candidate", c"latest", c"requires", c"notes", c"notesEn"] {
        row.set(k, null(e)?)?;
    }
    if e.get(c"distribution")?.is_string("builtin")? {
        let req = fallback_to(local.optional(c"requires")?, e.get(c"requires")?)?;
        row.set(c"requires", req)?;
        let mut why = unmet(req, host)?;
        if local.truthy()? {
            row_state(
                row,
                if why.truthy()? {
                    "incompatible"
                } else {
                    "builtin"
                },
                why,
            )?;
        } else {
            if !why.truthy()? {
                let since = e.get(c"builtinSince")?;
                why = if since.truthy()?
                    && compare(&text_of(host.get(c"multicc")?)?, &text_of(since)?) < 0.
                {
                    reason(
                        e,
                        "builtinInNewer",
                        &[("required", since), ("current", host.get(c"multicc")?)],
                    )?
                } else {
                    reason(e, "builtinMissing", &[])?
                };
            }
            row_state(row, "unsupported", why)?;
        }
        return Ok(row);
    }
    let releases = e.get(c"releases")?;
    let latest = releases.element(0)?;
    let mut usable = None;
    let mut own = None;
    for r in items(releases)? {
        if usable.is_none()
            && !unmet(r.get(c"requires")?, host)?.truthy()?
            && r.get(c"assets")?.get_key(platform)?.truthy()?
        {
            usable = Some(r)
        }
        if own.is_none() && local.truthy()? && r.get(c"version")?.equals(local.get(c"version")?)? {
            own = Some(r)
        }
    }
    row.set(c"latest", latest.get(c"version")?)?;
    let shown = usable.unwrap_or(latest);
    for k in [c"requires", c"notes", c"notesEn"] {
        row.set(k, shown.get(k)?)?;
    }
    if local.truthy()? {
        let why = unmet(
            fallback_to(
                local.get(c"requires")?,
                own.unwrap_or(null(e)?).optional(c"requires")?,
            )?,
            host,
        )?;
        if why.truthy()? {
            row_state(row, "incompatible", why)?
        } else if let Some(r) = usable {
            if compare(
                &text_of(r.get(c"version")?)?,
                &text_of(local.get(c"version")?)?,
            ) > 0.
            {
                row.set(c"candidate", r.get(c"version")?)?;
                row_state(row, "update", null(e)?)?;
            } else {
                row_state(row, "installed", null(e)?)?;
            }
        } else {
            row_state(row, "installed", null(e)?)?;
        }
    } else if let Some(r) = usable {
        row_state(row, "installable", null(e)?)?;
        row.set(c"candidate", r.get(c"version")?)?;
    } else {
        let why = unmet(latest.get(c"requires")?, host)?;
        row_state(
            row,
            "unsupported",
            if why.truthy()? {
                why
            } else {
                reason(e, "noAsset", &[("platform", platform)])?
            },
        )?;
    }
    Ok(row)
}
pub(super) fn compute<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let h = input.get(c"host")?;
    let cat = input.get(c"catalog")?;
    let platform = call(
        text(p, "")?,
        c"concat",
        &[h.get(c"os")?, text(p, "-")?, h.get(c"arch")?],
    )?;
    let by_id = p.global()?.get(c"Map")?.construct(&[])?;
    for x in items(default_to(input.get(c"installed")?, array(p)?)?)? {
        call(by_id, c"set", &[x.get(c"id")?, x])?;
    }
    let rows = array(p)?;
    if cat.truthy()? {
        for e in items(cat.get(c"plugins")?)? {
            let id = e.get(c"id")?;
            let local = or_null(call(by_id, c"get", &[id])?)?;
            call(by_id, c"delete", &[id])?;
            push(rows, listed(e, local, h, platform)?)?;
        }
    }
    for local in items(call(by_id, c"values", &[])?)? {
        let why = unmet(local.get(c"requires")?, h)?;
        let row = pick(local, &[c"id", c"name", c"nameEn", c"icon"])?;
        for (k, v) in [
            (c"category", or_null(local.get(c"category")?)?),
            (
                c"provides",
                fallback_to(local.get(c"provides")?, array(p)?)?,
            ),
            (c"distribution", null(p)?),
            (c"summary", local.get(c"description")?),
            (c"summaryEn", local.get(c"descriptionEn")?),
            (c"homepage", null(p)?),
            (
                c"listed",
                if cat.truthy()? {
                    flag(p, false)?
                } else {
                    null(p)?
                },
            ),
            (c"local", local),
        ] {
            row.set(k, v)?;
        }
        row_state(
            row,
            if why.truthy()? {
                "incompatible"
            } else {
                "installed"
            },
            why,
        )?;
        for (k, v) in [
            (c"installedVersion", local.get(c"version")?),
            (c"candidate", null(p)?),
            (c"latest", null(p)?),
            (c"requires", or_null(local.get(c"requires")?)?),
            (c"notes", null(p)?),
            (c"notesEn", null(p)?),
        ] {
            row.set(k, v)?;
        }
        push(rows, row)?;
    }
    call(
        rows,
        c"sort",
        &[function(p.get(c"stateOrder")?, "", 2, 2, |order, a| {
            let left = call(order, c"indexOf", &[a[0].get(c"state")?])?.number()?;
            let right = call(order, c"indexOf", &[a[1].get(c"state")?])?.number()?;
            let diff = left - right;
            if diff != 0. {
                num(order, diff)
            } else {
                call(a[0].get(c"id")?, c"localeCompare", &[a[1].get(c"id")?])
            }
        })?],
    )
}
