use super::*;
use multicc_core::voice_words as kernel;
const DAILY: f64 = 86_400_000.;
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    methods(
        p,
        &[
            ("createHotwordLearner", 1, create),
            ("messagesOf", 1, messages),
            ("userMessagesOf", 1, users),
            ("isMachineText", 1, |p, a| {
                flag(p, kernel::machine(&a[0].coerce_string()?))
            }),
        ],
    )
}
// Public callers may supply an object with live trimStart/split methods. The
// background scanner parses regular UTF-8 files independently in Rust.
fn messages<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    let take = |m: L<'a>| -> Result<()> {
        if m.truthy()?
            && m.get(c"role")?.string()?.is_some()
            && m.get(c"content")?.string()?.is_some()
        {
            push(
                out,
                fields(
                    p,
                    &[("role", m.get(c"role")?), ("content", m.get(c"content")?)],
                )?,
            )?;
        }
        Ok(())
    };
    let trimmed = call(a[0], c"trimStart", &[])?;
    if call(trimmed, c"startsWith", &[text(p, "[")?])?.truthy()? {
        let complete = p.catch(|| {
            let arr = json_call(p, c"parse", trimmed)?;
            if !arr.is_array()? {
                return Ok(false);
            }
            arr.for_each(take)?;
            Ok(true)
        })?;
        if complete == Some(true) {
            return Ok(out);
        }
    }
    call(a[0], c"split", &[text(p, "\n")?])?.for_each(|line| {
        if call(line, c"includes", &[text(p, "\"role\"")?])?.truthy()? {
            p.catch(|| take(json_call(p, c"parse", line)?))?;
        }
        Ok(())
    })?;
    Ok(out)
}
fn users<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    messages(p, a)?.for_each(|m| {
        if m.get(c"role")?.is_string("user")? {
            push(out, m.get(c"content")?)?;
        }
        Ok(())
    })?;
    Ok(out)
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let o = fields(
        p,
        &[
            ("ports", p),
            ("file", options.get(c"file")?),
            ("examples", options.get(c"examplesFile")?),
            ("dir", options.get(c"chatHistoryDir")?),
            (
                "log",
                with_default(options.get(c"log")?, p.global()?.get(c"console")?)?,
            ),
            (
                "now",
                with_default(
                    options.get(c"now")?,
                    function(p, "now", 0, 0, |p, _| gcall(p, c"Date", c"now", &[]))?,
                )?,
            ),
        ],
    )?;
    if !o.get(c"file")?.truthy()? {
        return Err(p.type_error("hotword learner requires a state file"));
    }
    methods(
        o,
        &[
            ("list", 0, |o, _| result(o)?.get(c"list")),
            ("learnFromExample", 1, learn),
            ("seedFromExamples", 0, seed),
            ("refresh", 0, refresh),
            ("start", 0, start),
            ("stop", 0, stop),
            ("reject", 1, reject),
            ("snapshot", 0, snapshot),
        ],
    )
}
fn iso(o: L<'_>) -> Result<L<'_>> {
    call(
        o.global()?.get(c"Date")?.construct(&[now(o)?])?,
        c"toISOString",
        &[],
    )
}
fn load(o: L<'_>) -> Result<L<'_>> {
    let state = o.get(c"state")?;
    if state.truthy()? {
        return Ok(state);
    }
    let state = fields(
        o,
        &[
            ("version", num(o, 1.)?),
            ("updatedAt", null(o)?),
            ("scannedAt", null(o)?),
            ("seededExamples", flag(o, false)?),
            ("seen", array(o)?),
            ("pairs", fields(o, &[])?),
            ("typed", array(o)?),
            ("rejected", array(o)?),
        ],
    )?;
    let data = read_json(o.get(c"ports")?, o.get(c"file")?)?;
    if data.truthy()? && data.get(c"version")?.is_number(1.)? {
        state.spread_from(data)?;
    }
    let kept = state.get(c"keptTexts")?;
    o.set(c"kept", if kept.is_array()? { kept } else { array(o)? })?;
    state.delete(c"keptTexts")?;
    o.set(c"state", state)?;
    Ok(state)
}
fn save(o: L<'_>) -> Result<()> {
    let s = load(o)?;
    s.set(c"updatedAt", iso(o)?)?;
    o.set(c"cache", null(o)?)?;
    let p = o.get(c"ports")?;
    let file = o.get(c"file")?;
    let data = spread(s)?;
    data.set(c"keptTexts", o.get(c"kept")?)?;
    if let Err(err) = call(p, c"atomicWriteJson", &[file, data]) {
        let msg = error_message(o, err)?;
        let name = call(p, c"basename", &[file])?;
        call(
            o.get(c"log")?,
            c"error",
            &[text(o, "[multicc/hotwords] Failed to write")?, name, msg],
        )?;
    }
    Ok(())
}
fn result(o: L<'_>) -> Result<L<'_>> {
    let state = load(o)?;
    let mut cache = o.get(c"cache")?;
    if !cache.truthy()? {
        cache = call(
            o.get(c"ports")?.get(c"miner")?,
            c"buildHotwords",
            &[state, o.get(c"kept")?],
        )?;
        o.set(c"cache", cache)?
    }
    Ok(cache)
}
fn remember(o: L<'_>, value: L<'_>) -> Result<()> {
    let Some(s) = value.string()? else {
        return Ok(());
    };
    if s.trim().is_empty() {
        return Ok(());
    }
    let cut = ls(o, s.truncate_units(800))?;
    let kept = o.get(c"kept")?;
    if !call(kept, c"includes", &[cut])?.truthy()? {
        push(kept, cut)?;
        if len(kept)? > 1000 {
            o.set(c"kept", slice(kept, -1000., None)?)?
        }
    }
    Ok(())
}
fn valid(v: L<'_>) -> Result<bool> {
    Ok(v.truthy()? && v.get(c"raw")?.truthy()? && v.get(c"userFinal")?.truthy()?)
}
fn absorb(o: L<'_>, e: L<'_>) -> Result<bool> {
    let state = load(o)?;
    let mut data = S::new();
    for (key, separator) in [(c"ts", false), (c"raw", true), (c"userFinal", true)] {
        if separator {
            data.push_unit(0)
        }
        data.push(&fallback(e.get(key)?, V::string(""))?.coerce_string()?);
    }
    let id = text(o, &kernel::example_id(&data))?;
    let seen = state.get(c"seen")?;
    if call(seen, c"includes", &[id])?.truthy()? {
        return Ok(false);
    }
    push(seen, id)?;
    if len(seen)? > 500 {
        state.set(c"seen", slice(seen, -500., None)?)?
    }
    let at = e.get(c"ts")?;
    let at = if at.truthy()? { at } else { iso(o)? };
    let miner = o.get(c"ports")?.get(c"miner")?;
    call(miner, c"minePairs", &[e.get(c"raw")?, e.get(c"userFinal")?])?.for_each(|r| {
        let term = r.get(c"term")?;
        let alias = r.get(c"alias")?;
        let key = call(miner, c"pairKey", &[term, fallback(alias, V::string(""))?])?;
        let pairs = state.get(c"pairs")?;
        let mut pair = pairs.get_key(key)?;
        if !pair.truthy()? {
            pair = fields(o, &[("term", term)])?;
            if alias.truthy()? {
                pair.set(c"alias", alias)?;
            }
            pair.set(c"count", num(o, 0.)?)?;
            pair.set(c"firstSeen", at)?;
        }
        pair.set(c"count", num(o, pair.get(c"count")?.number()? + 1.)?)?;
        pair.set(c"term", term)?;
        pair.set(c"lastSeen", at)?;
        pairs.set_key(key, pair)
    })?;
    remember(o, e.get(c"userFinal")?)?;
    Ok(true)
}
fn learn<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if valid(a[0])? && absorb(o, a[0])? {
        save(o)?;
    }
    undef(o)
}
fn seed<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let state = load(o)?;
    if state.get(c"seededExamples")?.truthy()? {
        return undef(o);
    }
    let file = o.get(c"examples")?;
    if file.truthy()? {
        let examples = read_json(o.get(c"ports")?, file)?;
        if examples.is_array()? {
            examples.for_each(|e| {
                if valid(e)? {
                    absorb(o, e)?;
                }
                Ok(())
            })?;
        }
    }
    state.set(c"seededExamples", flag(o, true)?)?;
    save(o)?;
    undef(o)
}
fn scanned<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let r = a[0];
    if r.nullish()? {
        return undef(o);
    }
    let typed = r.get(c"typed")?;
    let state = load(o)?;
    state.set(c"typed", typed)?;
    state.set(c"scannedAt", iso(o)?)?;
    r.get(c"kept")?.for_each(|v| remember(o, v))?;
    save(o)?;
    let mut model = 0;
    typed.for_each(|v| {
        model += usize::from(v.get(c"source")?.is_string("assistant")?);
        Ok(())
    })?;
    call(o.get(c"log")?,c"log",&[text(o,&format!("[multicc/hotwords] Scanned {} sessions: {} typed terms ({model} from model replies), {} active hotwords",r.get(c"files")?.number()?,len(typed)?,len(result(o)?.get(c"active")?)?))?])?;
    undef(o)
}
fn refresh<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let scanning = o.get(c"scanning")?;
    if scanning.truthy()? {
        return Ok(scanning);
    }
    let promise = async_result(o, || {
        let dir = o.get(c"dir")?;
        if !dir.truthy()? {
            return undef(o);
        }
        then(call(o.get(c"ports")?, c"scan", &[dir])?, o, scanned)
    })?;
    let promise = recover(promise, o, |o, a| {
        call(
            o.get(c"log")?,
            c"error",
            &[
                text(o, "[multicc/hotwords] Chat history scan failed:")?,
                a[0].get(c"message")?,
            ],
        )
    })?;
    let promise = call(
        promise,
        c"finally",
        &[function(o, "clearScan", 0, 0, |o, _| {
            o.set(c"scanning", null(o)?)?;
            undef(o)
        })?],
    )?;
    o.set(c"scanning", promise)?;
    Ok(promise)
}
fn schedule(o: L<'_>, delay: f64) -> Result<()> {
    let callback = function(o, "rescan", 0, 0, |o, _| {
        let r = refresh(o, &mut [])?;
        call(
            r,
            c"finally",
            &[function(o, "nextScan", 0, 0, |o, _| {
                if o.get(c"timer")?.truthy()? {
                    schedule(o, DAILY)?
                }
                undef(o)
            })?],
        )?;
        undef(o)
    })?;
    let timer = o
        .global()?
        .get(c"setTimeout")?
        .call_plain(&[callback, num(o, delay)?])?;
    o.set(c"timer", timer)?;
    if timer.get(c"unref")?.truthy()? {
        call(timer, c"unref", &[])?;
    }
    Ok(())
}
fn start<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if let Err(e) = seed(o, &mut []) {
        let m = error_message(o, e)?;
        call(
            o.get(c"log")?,
            c"error",
            &[text(o, "[multicc/hotwords] Seeding failed:")?, m],
        )?;
    }
    let last = gcall(
        o,
        c"Date",
        c"parse",
        &[fallback(load(o)?.get(c"scannedAt")?, V::string(""))?],
    )?;
    let last = fallback(last, V::Number(0.))?.number()?;
    schedule(o, (last + DAILY - now(o)?.number()?).max(60000.))?;
    undef(o)
}
fn stop<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let timer = o.get(c"timer")?;
    if timer.truthy()? {
        o.global()?.get(c"clearTimeout")?.call_plain(&[timer])?;
    }
    o.set(c"timer", null(o)?)?;
    undef(o)
}
fn reject<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let v = default_object(a[0])?;
    let t = v.get(c"term")?;
    let alias = v.get(c"alias")?;
    let Some(t) = t.string()? else {
        return flag(o, false);
    };
    let t = t.trim();
    if t.is_empty() {
        return flag(o, false);
    }
    let state = load(o)?;
    let key = call(
        o.get(c"ports")?.get(c"miner")?,
        c"pairKey",
        &[
            ls(o, t)?,
            ls(o, alias.string()?.unwrap_or_default().trim())?,
        ],
    )?;
    let rejected = state.get(c"rejected")?;
    if !call(rejected, c"includes", &[key])?.truthy()? {
        push(rejected, key)?;
    }
    save(o)?;
    flag(o, true)
}
fn snapshot<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let r = result(o)?;
    let out = pick(r, &[c"list", c"active"])?;
    for k in [c"pending", c"vetoed"] {
        out.set(
            k,
            call(
                r.get(k)?,
                c"map",
                &[function(o, "pair", 1, 1, |_, v| {
                    pick(v[0], &[c"term", c"alias", c"count"])
                })?],
            )?,
        )?;
    }
    let state = load(o)?;
    for k in [c"typed", c"updatedAt", c"scannedAt"] {
        out.set(k, state.get(k)?)?;
    }
    Ok(out)
}
