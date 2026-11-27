//! JS board records keep their live identity and UTF-16 display text. The shared
//! Rust search kernel owns token frequencies and ranking on both API paths.
mod corpus;
mod presentation;
mod ranking;
mod runtime;

use crate::host_api::*;
use multicc_core::search::SearchIndex;
use napi_derive::napi;
use std::ffi::CStr;

const NAMES: [&CStr; 4] = [c"title", c"module", c"areas", c"body"];

#[napi]
pub struct BoardSearchSnapshot {
    index: SearchIndex,
}

#[napi]
impl BoardSearchSnapshot {
    #[napi]
    pub fn inspect(&self) -> String {
        self.index.board_view().to_string()
    }
    #[napi]
    pub fn idf(&self, term: String) -> f64 {
        self.index.term_idf(&term)
    }
}

#[napi]
pub fn board_search_snapshot(documents: String) -> Result<BoardSearchSnapshot> {
    let index = SearchIndex::build_board_snapshot(&documents).map_err(napi::Error::from_reason)?;
    Ok(BoardSearchSnapshot { index })
}

fn push<'a>(list: L<'a>, v: L<'a>) -> Result<()> {
    call(list, c"push", &[v])?;
    Ok(())
}

fn map(v: L<'_>) -> Result<L<'_>> {
    v.global()?.get(c"Map")?.construct(&[])
}

fn size(v: L<'_>) -> Result<u32> {
    Ok(v.get(c"length")?.number()? as u32)
}

#[napi]
pub fn task_search_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = methods(
        p,
        &[
            ("analyzeQuery", 1, |p, a| presentation::analyze(p, a[0])),
            ("buildSnippet", 2, |p, a| {
                presentation::snippet(p, a[0], a[1])
            }),
            ("taskSearchFields", 2, |_, a| {
                corpus::search_fields(a[0], a[1])
            }),
            ("createTaskSearchBackend", 0, runtime::create_backend),
        ],
    )?;
    for (name, length, count, run) in [
        ("buildTaskSearchIndex", 1, 2, runtime::sync_build as Action),
        ("searchTaskIndex", 2, 3, runtime::sync_search as Action),
        ("searchBoard", 2, 3, runtime::search_board as Action),
        ("buildIndex", 1, 2, runtime::build_index as Action),
        ("searchIndex", 2, 3, runtime::search_index as Action),
    ] {
        out.define_key(text(p, name)?, function(p, name, length, count, run)?)?;
    }
    out.set(c"tokenize", p.get(c"tokenizer")?.get(c"tokenize")?)?;
    out.set(
        c"normalizeText",
        p.get(c"tokenizer")?.get(c"normalizeText")?,
    )?;
    out.set(
        c"FIELD_WEIGHTS",
        fields(
            p,
            &[
                ("title", num(p, 6.)?),
                ("module", num(p, 2.)?),
                ("areas", num(p, 3.)?),
                ("body", num(p, 4.)?),
            ],
        )?,
    )?;
    p.set(c"weights", out.get(c"FIELD_WEIGHTS")?)?;
    Ok(out.raw())
}
