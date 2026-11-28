use super::*;
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let env = p.get(c"env")?;
    let cfg = fields(p, &[])?;
    for (key, default) in [
        (c"OPENROUTER_API_KEY", ""),
        (c"OPENROUTER_MODEL", "google/gemini-2.0-flash-001"),
        (c"OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        (c"WHISPER_API_KEY", ""),
        (c"WHISPER_BASE_URL", "https://openrouter.ai/api/v1"),
        (c"WHISPER_MODEL", "whisper-large-v3-turbo"),
        (c"WHISPER_LANGUAGE", "zh"),
        (c"WHISPER_PROMPT", ""),
    ] {
        cfg.set(key, fallback(env.get(key)?, V::string(default))?)?
    }
    let paths = p.get(c"paths")?;
    let enabled = !call(
        regex(p, "^(0|off|false)$", "i")?,
        c"test",
        &[fallback(env.get(c"VOICE_AUTO_HOTWORDS")?, V::string(""))?],
    )?
    .truthy()?;
    let learner = call(
        p.get(c"learner")?,
        c"createHotwordLearner",
        &[fields(
            p,
            &[
                ("file", paths.get(c"voiceHotwordsFile")?),
                ("examplesFile", paths.get(c"voiceExamplesFile")?),
                ("chatHistoryDir", paths.get(c"chatHistoryDir")?),
            ],
        )?],
    )?;
    p.set(c"cfg", cfg)?;
    p.set(c"autoHotwords", learner)?;
    p.set(c"enabled", flag(p, enabled)?)?;
    let api = methods(
        p,
        &[
            ("applyEnvUpdates", 1, apply),
            ("loadVoiceExamples", 0, |p, _| {
                slice(load_array(p, c"voiceExamplesFile")?, -5., None)
            }),
            ("appendVoiceExample", 1, append),
            ("loadWhisperVocab", 0, |p, _| {
                load_array(p, c"whisperVocabFile")
            }),
            ("saveWhisperVocab", 1, |p, a| {
                save(p, c"whisperVocabFile", "whisper_vocab.json", a[0])
            }),
            ("extractCorrections", 2, corrections),
            ("mergeWhisperVocab", 1, merge),
            ("buildWhisperPrompt", 0, prompt),
            ("callVoiceAPI", 2, super::stream::request),
            ("hotwordList", 0, list),
        ],
    )?;
    api.set(c"cfg", cfg)?;
    api.set(c"autoHotwords", learner)?;
    api.set(c"autoHotwordsEnabled", flag(p, enabled)?)?;
    if let Err(err) = backfill(p) {
        let msg = error_message(p, err)?;
        log(
            p,
            c"error",
            &[text(p, "[multicc/stt] Backfill error:")?, msg],
        )?;
    }
    log(
        p,
        c"log",
        &[text(
            p,
            &format!(
                "[multicc/voice] Voice API initialized (OpenRouter, model: {})",
                fold_string(cfg.get(c"OPENROUTER_MODEL")?)?
            ),
        )?],
    )?;
    Ok(api)
}
pub(super) fn log<'a>(p: L<'a>, key: &CStr, values: &[L<'a>]) -> Result<L<'a>> {
    call(p.global()?.get(c"console")?, key, values)
}
fn apply<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let cfg = p.get(c"cfg")?;
    gcall(p, c"Object", c"keys", &[cfg])?.for_each(|key| {
        if !args[0].get_key(key)?.undefined()? {
            cfg.set_key(key, args[0].get_key(key)?)?;
        }
        Ok(())
    })?;
    undef(p)
}
fn load_array<'a>(p: L<'a>, key: &CStr) -> Result<L<'a>> {
    let file = p.get(c"paths")?.get(key)?;
    let result = p.catch(|| {
        if call(p.get(c"fs")?, c"existsSync", &[file])?.truthy()? {
            let data = read_json(p, file)?;
            if data.is_array()? {
                return Ok(data);
            }
        }
        array(p)
    })?;
    if let Some(result) = result {
        Ok(result)
    } else {
        array(p)
    }
}
fn save<'a>(p: L<'a>, key: &CStr, name: &str, data: L<'a>) -> Result<L<'a>> {
    if let Err(e) = call(p, c"atomicWriteJson", &[p.get(c"paths")?.get(key)?, data]) {
        let msg = error_message(p, e)?;
        log(
            p,
            c"error",
            &[text(p, &format!("[multicc] Failed to write {name}:"))?, msg],
        )?;
    }
    undef(p)
}
fn append<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut data = load_array(p, c"voiceExamplesFile")?;
    push(data, a[0])?;
    if len(data)? > 50 {
        data = slice(data, -50., None)?;
    }
    save(p, c"voiceExamplesFile", "voice_examples.json", data)
}
fn corrections<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    if !a[0].truthy()? || !a[1].truthy()? || a[0].equals(a[1])? {
        return Ok(out);
    }
    let tokens = |v| -> Result<L<'a>> {
        or_array(call(
            v,
            c"match",
            &[regex(p, "[a-zA-Z][a-zA-Z0-9_./-]*", "g")?],
        )?)
    };
    let known = p.global()?.get(c"Set")?.construct(&[])?;
    tokens(a[0])?.for_each(|x| {
        call(known, c"add", &[lower(x)?])?;
        Ok(())
    })?;
    tokens(a[1])?.for_each(|x| {
        if len(x)? > 1 && !call(known, c"has", &[lower(x)?])?.truthy()? {
            push(out, x)?;
        }
        Ok(())
    })?;
    Ok(out)
}
fn merge<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let terms = a[0];
    if !terms.truthy()? || terms.get(c"length")?.is_number(0.)? {
        return undef(p);
    }
    let vocab = load_array(p, c"whisperVocabFile")?;
    let map = p.global()?.get(c"Map")?.construct(&[])?;
    vocab.for_each(|v| {
        call(map, c"set", &[lower(v.get(c"term")?)?, v])?;
        Ok(())
    })?;
    terms.for_each(|v| {
        let key = lower(v)?;
        let date = || {
            call(
                p.global()?.get(c"Date")?.construct(&[])?,
                c"toISOString",
                &[],
            )
        };
        if call(map, c"has", &[key])?.truthy()? {
            let entry = call(map, c"get", &[key])?;
            let n = fallback(entry.get(c"count")?, V::Number(1.))?;
            let count = if let Some(mut s) = n.string()? {
                s.push_unit(49);
                ls(p, s)?
            } else {
                num(p, n.number()? + 1.)?
            };
            entry.set(c"count", count)?;
            entry.set(c"lastSeen", date()?)?;
            entry.set(c"term", v)?;
        } else {
            call(
                map,
                c"set",
                &[
                    key,
                    fields(
                        p,
                        &[("term", v), ("count", num(p, 1.)?), ("lastSeen", date()?)],
                    )?,
                ],
            )?;
        }
        Ok(())
    })?;
    let rows = gcall(p, c"Array", c"from", &[call(map, c"values", &[])?])?;
    call(
        rows,
        c"sort",
        &[function(p, "byCount", 2, 2, |p, a| {
            num(
                p,
                a[1].get(c"count")?.number()? - a[0].get(c"count")?.number()?,
            )
        })?],
    )?;
    let sorted = slice(rows, 0., Some(100.))?;
    save(p, c"whisperVocabFile", "whisper_vocab.json", sorted)?;
    log(
        p,
        c"log",
        &[text(
            p,
            &format!(
                "[multicc/stt] Whisper vocab updated: {} terms, added: {}",
                len(sorted)?,
                fold_string(join(terms, ", ")?)?
            ),
        )?],
    )?;
    undef(p)
}
fn backfill(p: L<'_>) -> Result<()> {
    let paths = p.get(c"paths")?;
    let fs = p.get(c"fs")?;
    let examples = paths.get(c"voiceExamplesFile")?;
    if call(fs, c"existsSync", &[paths.get(c"whisperVocabFile")?])?.truthy()?
        || !call(fs, c"existsSync", &[examples])?.truthy()?
    {
        return Ok(());
    }
    let examples = json_call(
        p,
        c"parse",
        call(fs, c"readFileSync", &[examples, text(p, "utf8")?])?,
    )?;
    if examples.is_array()? {
        let all = array(p)?;
        examples.for_each(|e| {
            corrections(p, &mut [e.get(c"raw")?, e.get(c"userFinal")?])?.for_each(|s| push(all, s))
        })?;
        if len(all)? > 0 {
            merge(p, &mut [all])?;
            log(
                p,
                c"log",
                &[text(
                    p,
                    &format!(
                        "[multicc/stt] Backfilled whisper_vocab.json from {} voice examples",
                        len(examples)?
                    ),
                )?],
            )?;
        }
    }
    Ok(())
}
fn list<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let learned = if p.get(c"enabled")?.truthy()? {
        call(p.get(c"autoHotwords")?, c"list", &[])?
    } else {
        text(p, "")?
    };
    let out = array(p)?;
    for term in [
        fallback(p.get(c"cfg")?.get(c"WHISPER_PROMPT")?, V::string(""))?,
        learned,
    ] {
        if call(term, c"trim", &[])?.truthy()? {
            push(out, term)?;
        }
    }
    join(out, ", ")
}
fn prompt<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let parts = array(p)?;
    let terms = call(
        call(p.get(c"corrector")?, c"stripAliases", &[list(p, &mut [])?])?,
        c"trim",
        &[],
    )?;
    if terms.truthy()? {
        push(parts, terms)?;
    }
    p.catch(|| {
        let vocab = load_array(p, c"whisperVocabFile")?;
        if len(vocab)? > 0 {
            let names = call(
                slice(vocab, 0., Some(40.))?,
                c"map",
                &[function(p, "term", 1, 1, |_, a| a[0].get(c"term"))?],
            )?;
            push(parts, join(names, ", ")?)?;
        }
        Ok(())
    })?;
    let s = join(parts, ". ")?;
    if len(s)? > 500 {
        slice(s, 0., Some(500.))
    } else {
        Ok(s)
    }
}
