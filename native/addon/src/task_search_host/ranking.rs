//! The synchronous API accepts a live, inspectable index. Read its Maps, field
//! lengths and idf callback so callers can pass a snapshot or a derived view.
//! Asynchronous HTTP search ranks the owned SearchIndex directly on libuv.
use super::*;
use multicc_core::search::field_score;

fn has<'a>(set: L<'a>, value: L<'a>) -> Result<bool> {
    call(set, c"has", &[value])?.truthy()
}

fn phrase_bonus<'a>(p: L<'a>, doc: L<'a>, phrase: L<'a>) -> Result<f64> {
    if !phrase.truthy()? || size(phrase)? < 2 {
        return Ok(0.);
    }
    let fields = doc.get(c"fields")?;
    let weights = p.get(c"weights")?;
    let mut best: f64 = 0.;
    for name in NAMES {
        let field = fields.get(name)?;
        if field.truthy()?
            && call(
                crate::search_tokens::normalized(field, false)?,
                c"includes",
                &[phrase],
            )?
            .truthy()?
        {
            best = best.max(weights.get(name)?.number()?);
        }
    }
    Ok(best)
}

struct Filters<'a> {
    dir: L<'a>,
    dirs: L<'a>,
    statuses: L<'a>,
    include: L<'a>,
    exclude: L<'a>,
}

impl<'a> Filters<'a> {
    fn new(input: L<'a>) -> Result<Self> {
        let set = input.global()?.get(c"Set")?;
        let optional = |name| -> Result<L<'a>> {
            let v = input.get(name)?;
            if v.nullish()? {
                Ok(v)
            } else {
                set.construct(&[v])
            }
        };
        Ok(Self {
            dir: input.get(c"dirId")?,
            dirs: optional(c"dirIds")?,
            statuses: optional(c"statuses")?,
            include: optional(c"taskIds")?,
            exclude: optional(c"excludeTaskIds")?,
        })
    }

    fn accepts(&self, doc: L<'a>) -> Result<bool> {
        let id = doc.get(c"taskId")?;
        Ok((self.include.nullish()? || has(self.include, id)?)
            && (self.exclude.nullish()? || !has(self.exclude, id)?)
            && (self.dir.nullish()? || self.dir.equals(doc.get(c"dirId")?)?)
            && (self.dirs.nullish()? || has(self.dirs, doc.get(c"dirId")?)?)
            && (self.statuses.nullish()? || has(self.statuses, doc.get(c"status")?)?))
    }
}

pub(super) fn search<'a>(p: L<'a>, index: L<'a>, query: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let input = presentation::filters(p, query, options, true)?;
    let filters = Filters::new(input)?;
    let minimum = input.get(c"minScore")?.number()?;
    let docs = index.get(c"docs")?;
    let rows = array(p)?;
    let weights = p.get(c"weights")?;
    call(docs, c"values", &[])?.for_each(|doc| {
        if !filters.accepts(doc)? {
            return Ok(());
        }
        let terms = doc.get(c"terms")?;
        let lengths = doc.get(c"lengths")?;
        let mut score = 0.;
        let mut strong = false;
        let mut field_hits = [false; 4];
        let matched = array(p)?;
        let fields = array(p)?;
        query.get(c"terms")?.for_each(|pair| {
            let (term, weight) = pair.iterator_pair()?;
            let counts = call(terms, c"get", &[term])?;
            if !counts.truthy()? {
                return Ok(());
            }
            let mut subtotal = 0.;
            for (i, key) in NAMES.into_iter().enumerate() {
                let tf = counts.get(key)?;
                if !tf.truthy()? {
                    continue;
                }
                let average =
                    fallback(index.get(c"avgLengths")?.get(key)?, 1.0.into())?.number()?;
                let length = lengths
                    .get(key)?
                    .number_value()?
                    .filter(|n| n.is_finite())
                    .unwrap_or(average);
                let value = field_score(
                    fallback(weights.get(key)?, 1.0.into())?.number()?,
                    call(index, c"idf", &[term])?.number()?,
                    tf.number()?,
                    length,
                    average,
                );
                if value > 0. && !field_hits[i] {
                    push(fields, text(p, key.to_str().expect("field name"))?)?;
                    field_hits[i] = true;
                }
                subtotal += value;
            }
            if subtotal > 0. {
                let weight = weight.number()?;
                score += subtotal * weight;
                push(matched, term)?;
                strong |= weight >= 1.;
            }
            Ok(())
        })?;
        if (size(query.get(c"strong")?)? > 0 && !strong) || score <= 0. {
            return Ok(());
        }
        score += phrase_bonus(p, doc, query.get(c"phrase")?)?;
        if score < minimum {
            return Ok(());
        }
        let row = pick(
            doc,
            &[c"taskId", c"title", c"dirId", c"status", c"updatedAt"],
        )?;
        row.set(c"score", num(p, (score * 1000.).round() / 1000.)?)?;
        row.set(c"matchedTerms", matched)?;
        row.set(c"matchedFields", fields)?;
        push(rows, row)
    })?;
    presentation::finish(p, rows, query, options, docs)
}
