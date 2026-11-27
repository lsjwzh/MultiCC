use super::*;

pub(super) fn sync_build<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (board, options) = (args[0], default_object(args[1])?);
    let prepared = corpus::prepare(board, options, true)?;
    let rows = prepared.get(c"rows")?;
    let native = call(
        p.get(c"addon")?,
        c"boardSearchSnapshot",
        &[corpus::payload(p, rows, true)?],
    )?;
    let inspection = json_call(p, c"parse", call(native, c"inspect", &[])?)?;
    let docs = prepared.get(c"docs")?;
    let map_ctor = p.global()?.get(c"Map")?;
    inspection.get(c"rows")?.for_each(|entry| {
        let row = rows.element(entry.element(0)?.number()? as u32)?;
        row.set(c"lengths", entry.element(1)?)?;
        row.set(c"terms", map_ctor.construct(&[entry.element(2)?])?)?;
        call(docs, c"set", &[row.get(c"taskId")?, row])?;
        Ok(())
    })?;
    let owner = fields(p, &[("board", board), ("tasks", prepared.get(c"tasks")?)])?;
    let fields_for = function(owner, "fieldsFor", 1, 1, |state, a| {
        let task = state.get(c"tasks")?.get_key(a[0])?;
        corpus::search_fields(state.get(c"board")?, task)
    })?;
    let idf = function(native, "idf", 1, 1, |native, a| {
        let term = if a[0].kind()? == sys::ValueType::napi_string {
            a[0]
        } else {
            text(native, "")?
        };
        call(native, c"idf", &[term])
    })?;
    let revision = num(p, board.optional(c"revision")?.explicit_number()?)?;
    let index = fields(
        p,
        &[
            ("version", num(p, 1.)?),
            ("revision", fallback(revision, 0.0.into())?),
            ("docCount", docs.get(c"size")?),
            ("idf", idf),
            ("avgLengths", inspection.get(c"average")?),
            ("docs", docs),
            ("fieldsFor", fields_for),
        ],
    )?;
    Ok(index)
}

pub(super) fn sync_search<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let index = args[0];
    let query = presentation::parsed(p, args[1])?;
    let docs = index.optional(c"docs")?;
    if !docs.optional(c"size")?.truthy()? || size(query.get(c"terms")?)? == 0 {
        return array(p);
    }
    let options = default_object(args[2])?;
    ranking::search(p, index, query, options)
}

pub(super) fn search_board<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let index = sync_build(p, &mut [a[0], a[2]])?;
    sync_search(p, &mut [index, a[1], a[2]])
}

fn build_prepared<'a>(p: L<'a>, prepared: L<'a>) -> Result<L<'a>> {
    let payload = corpus::payload(p, prepared.get(c"rows")?, false)?;
    let state = fields(
        p,
        &[
            ("addon", p.get(c"addon")?),
            ("payload", payload),
            ("docs", prepared.get(c"docs")?),
        ],
    )?;
    let job = function(state, "build", 0, 0, |s, _| {
        call(s.get(c"addon")?, c"buildSearchIndex", &[s.get(c"payload")?])
    })?;
    let promise = call(p, c"runNative", &[job])?;
    then(promise, state, |s, a| {
        fields(
            s,
            &[
                ("backend", text(s, "rust")?),
                ("native", a[0]),
                ("docs", s.get(c"docs")?),
                (
                    "timings",
                    fields(s, &[("buildNativeMs", a[0].get(c"buildMs")?)])?,
                ),
            ],
        )
    })
}

pub(super) fn build_index<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        build_prepared(
            p,
            corpus::prepare(args[0], default_object(args[1])?, false)?,
        )
    })
}

pub(super) fn search_index<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let index = args[0];
        let query = presentation::parsed(p, args[1])?;
        if size(query.get(c"terms")?)? == 0 {
            return array(p);
        }
        let options = default_object(args[2])?;
        let input = json_call(
            p,
            c"stringify",
            presentation::filters(p, query, options, false)?,
        )?;
        let state = fields(
            p,
            &[
                ("ports", p),
                ("index", index),
                ("query", query),
                ("options", options),
                ("input", input),
            ],
        )?;
        let job = function(state, "search", 0, 0, |s, _| {
            call(
                s.get(c"index")?.get(c"native")?,
                c"search",
                &[s.get(c"input")?],
            )
        })?;
        let promise = call(p, c"runNative", &[job])?;
        then(promise, state, |s, a| {
            let p = s.get(c"ports")?;
            let index = s.get(c"index")?;
            index
                .get(c"timings")?
                .set(c"searchNativeMs", a[0].get(c"computeMs")?)?;
            let result = presentation::decorate(
                p,
                a[0].get(c"result")?,
                s.get(c"query")?,
                s.get(c"options")?,
                index.get(c"docs")?,
            )?;
            call(p, c"record", &[text(p, "search")?])?;
            Ok(result)
        })
    })
}

pub(super) fn create_backend<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let owner = fields(p, &[("ports", p), ("cached", null(p)?)])?;
    function(owner, "searchTasks", 2, 3, |s, args| {
        async_result(s, || {
            let p = s.get(c"ports")?;
            let options = default_object(args[2])?;
            let prepared = corpus::prepare(args[0], options, false)?;
            let key = json_call(s, c"stringify", prepared.get(c"rows")?)?;
            let cached = s.get(c"cached")?;
            let promise = if cached.nullish()? || !cached.get(c"key")?.equals(key)? {
                let promise = async_result(p, || build_prepared(p, prepared))?;
                let entry = fields(s, &[("key", key), ("promise", promise)])?;
                s.set(c"cached", entry)?;
                let recovery = fields(s, &[("owner", s), ("entry", entry)])?;
                recover(promise, recovery, |r, _| {
                    let owner = r.get(c"owner")?;
                    if owner.get(c"cached")?.equals(r.get(c"entry")?)? {
                        owner.set(c"cached", null(owner)?)?;
                    }
                    undef(owner)
                })?;
                promise
            } else {
                cached.get(c"promise")?
            };
            let next = fields(s, &[("ports", p), ("query", args[1]), ("options", options)])?;
            then(promise, next, |s, a| {
                search_index(
                    s.get(c"ports")?,
                    &mut [a[0], s.get(c"query")?, s.get(c"options")?],
                )
            })
        })
    })
}
