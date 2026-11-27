use super::*;
use multicc_core::js::string::{is_js_whitespace, JsString};

fn collapse(value: &JsString) -> JsString {
    let mut units = Vec::with_capacity(value.len());
    let mut space = false;
    for &u in value.as_units() {
        if is_js_whitespace(u) {
            space = !units.is_empty();
        } else {
            if space {
                units.push(32);
                space = false;
            }
            units.push(u);
        }
    }
    JsString::from_units(units)
}

pub(super) fn analyze<'a>(p: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let raw = call(string(fallback(value, "".into())?)?, c"trim", &[])?;
    let terms = crate::search_tokens::live_board_query_terms(raw)?;
    let all = array(p)?;
    let strong = array(p)?;
    terms.for_each(|pair| {
        let t = pair.element(0)?;
        push(all, t)?;
        if pair.element(1)?.number()? >= 1. {
            push(strong, t)?;
        }
        Ok(())
    })?;
    let highlight = if !raw.truthy()? {
        array(p)?
    } else if size(strong)? > 0 {
        strong
    } else {
        all
    };
    let folded = crate::search_tokens::normalized(raw, false)?.coerce_string()?;
    fields(
        p,
        &[
            ("text", raw),
            ("terms", terms),
            ("strong", strong),
            ("all", all),
            ("highlight", highlight),
            ("phrase", p.from_value(&V::String(collapse(&folded)))?),
        ],
    )
}

pub(super) fn parsed<'a>(p: L<'a>, query: L<'a>) -> Result<L<'a>> {
    if query.nullish()? || query.kind()? == sys::ValueType::napi_string {
        analyze(p, query)
    } else {
        Ok(query)
    }
}

fn find(text: &[u16], term: &[u16]) -> Option<usize> {
    if term.is_empty() {
        return None;
    }
    text.windows(term.len()).position(|w| w == term)
}

pub(super) fn snippet<'a>(p: L<'a>, doc: L<'a>, query: L<'a>) -> Result<L<'a>> {
    let highlight = query.get(c"highlight")?;
    let selected = if highlight.is_array()? && size(highlight)? > 0 {
        highlight
    } else {
        query.get(c"all")?
    };
    let mut marks = Vec::new();
    selected.for_each(|term| {
        marks.push(term.coerce_string()?);
        Ok(())
    })?;
    let corpus = doc.get(c"fields")?;
    let mut fallback_text = None;
    let mut window = None;
    for field in [c"body", c"areas", c"title", c"module"] {
        let source = corpus.get(field)?;
        if !source.truthy()? {
            continue;
        }
        let original = source.coerce_string()?;
        if fallback_text.is_none() {
            fallback_text = Some(original.clone());
        }
        let normalized = crate::search_tokens::normalized(source, false)?.coerce_string()?;
        let mut best = None;
        let mut length = 0;
        for mark in &marks {
            if mark.len() > length {
                if let Some(at) = find(normalized.as_units(), mark.as_units()) {
                    best = Some(at);
                    length = mark.len();
                }
            }
        }
        if let Some(at) = best {
            window = Some(collapse(
                &original.slice_units(at.saturating_sub(40), at + length + 40),
            ));
            break;
        }
    }
    let window =
        window.unwrap_or_else(|| collapse(&fallback_text.unwrap_or_default()).truncate_units(160));
    let live = p.from_value(&V::String(window))?;
    let normalized = crate::search_tokens::normalized(live, false)?.coerce_string()?;
    let mut hits = Vec::new();
    for mark in marks {
        let mut offset = 0;
        while let Some(at) = find(&normalized.as_units()[offset..], mark.as_units()) {
            let start = offset + at;
            offset = start + mark.len();
            hits.push((start, offset));
        }
    }
    hits.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, b) in hits {
        if let Some(last) = merged.last_mut().filter(|last| a <= last.1) {
            last.1 = last.1.max(b);
        } else {
            merged.push((a, b));
        }
    }
    let ranges = V::Array(
        merged
            .into_iter()
            .map(|(a, b)| V::Array(vec![(a as f64).into(), (b as f64).into()]))
            .collect(),
    );
    fields(p, &[("text", live), ("ranges", p.from_value(&ranges)?)])
}

pub(super) fn filters<'a>(
    p: L<'a>,
    query: L<'a>,
    options: L<'a>,
    synchronous: bool,
) -> Result<L<'a>> {
    let input = pick(query, &[c"terms", c"strong", c"phrase"])?;
    let dir = options.get(c"dirId")?;
    input.set(
        c"dirId",
        if dir.truthy()? {
            string(dir)?
        } else {
            null(p)?
        },
    )?;
    for name in [c"dirIds", c"statuses"] {
        input.set(name, corpus::string_list(options.get(name)?, true)?)?;
    }
    for name in [c"taskIds", c"excludeTaskIds"] {
        let value = options.get(name)?;
        let result = if value.truthy()? {
            let string_ctor = p.global()?.get(c"String")?;
            if synchronous {
                call(value, c"map", &[string_ctor])?
            } else {
                call(p.global()?.get(c"Array")?, c"from", &[value, string_ctor])?
            }
        } else {
            null(p)?
        };
        input.set(name, result)?;
    }
    let min = options.get(c"minScore")?.explicit_number()?;
    input.set(c"minScore", num(p, if min > 0. { min } else { 0. })?)?;
    Ok(input)
}

fn order<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    for key in [c"score", c"updatedAt"] {
        let diff = a[1].get(key)?.number()? - a[0].get(key)?.number()?;
        if diff != 0. && !diff.is_nan() {
            return num(p, diff);
        }
    }
    call(
        a[0].get(c"taskId")?,
        c"localeCompare",
        &[a[1].get(c"taskId")?],
    )
}

pub(super) fn decorate<'a>(
    p: L<'a>,
    raw: L<'a>,
    query: L<'a>,
    options: L<'a>,
    docs: L<'a>,
) -> Result<L<'a>> {
    let rows = json_call(p, c"parse", raw)?;
    rows.for_each(|score| {
        let doc = call(docs, c"get", &[score.get(c"taskId")?])?;
        for k in [c"title", c"dirId", c"status", c"updatedAt"] {
            score.set(k, doc.get(k)?)?;
        }
        Ok(())
    })?;
    finish(p, rows, query, options, docs)
}

pub(super) fn finish<'a>(
    p: L<'a>,
    rows: L<'a>,
    query: L<'a>,
    options: L<'a>,
    docs: L<'a>,
) -> Result<L<'a>> {
    call(rows, c"sort", &[function(p, "rankOrder", 2, 2, order)?])?;
    let limit = options.get(c"limit")?.explicit_number()?;
    let limit = if limit == 0. || limit.is_nan() {
        10.
    } else {
        limit.clamp(1., 50.)
    };
    let result = call(rows, c"slice", &[num(p, 0.)?, num(p, limit)?])?;
    result.for_each(|row| {
        let doc = call(docs, c"get", &[row.get(c"taskId")?])?;
        row.set(c"snippet", snippet(p, doc, query)?)
    })?;
    Ok(result)
}
