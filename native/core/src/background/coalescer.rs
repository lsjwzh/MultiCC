//! Completion batching. A fixed window starts at the first completion of a
//! session (never a debounce), and the nudge wording is byte-identical to the
//! legacy coalescer. The deadline table replaces `setTimeout`: the native owner
//! exposes the next deadline and the JavaScript facade arms one unref'd timer.
use crate::background::snippet::tail_units;
use crate::background::state::string_or_empty;
use crate::background::state::OrderedMap;
use crate::js::{coerce::js_to_string, string::JsString, JsValue};

pub const DEFAULT_WINDOW_MS: f64 = 1500.0;
pub const MERGED_SNIPPET_CAP: usize = 800;

#[derive(Clone, Debug)]
pub struct Item {
    pub monitor: bool,
    pub desc: JsValue,
    pub status: JsValue,
    pub snippet: JsString,
    pub task_id: Option<JsValue>,
    pub tool_use_id: Option<JsValue>,
    pub token: u64,
}

impl Item {
    pub fn monitor(
        desc: JsValue,
        status: JsValue,
        snippet: JsString,
        task_id: Option<JsValue>,
        tool_use_id: Option<JsValue>,
        token: u64,
    ) -> Self {
        Self {
            monitor: true,
            desc,
            status,
            snippet,
            task_id,
            tool_use_id,
            token,
        }
    }

    pub fn task(
        desc: JsValue,
        status: JsValue,
        snippet: JsString,
        task_id: Option<JsValue>,
        tool_use_id: Option<JsValue>,
        token: u64,
    ) -> Self {
        Self {
            monitor: false,
            desc,
            status,
            snippet,
            task_id,
            tool_use_id,
            token,
        }
    }

    fn reference(&self) -> JsString {
        match self.task_id.as_ref().filter(|value| js_truthy(value)) {
            Some(value) => js_to_string(value),
            None => match self.tool_use_id.as_ref().filter(|value| js_truthy(value)) {
                Some(value) => js_to_string(value),
                None => JsString::new(),
            },
        }
    }
}

fn js_truthy(value: &JsValue) -> bool {
    crate::js::coerce::truthy(value)
}

#[derive(Clone, Debug)]
struct Pending {
    items: Vec<Item>,
    deadline: f64,
}

#[derive(Clone, Debug)]
pub struct Coalescer {
    window_ms: f64,
    pending: OrderedMap<Pending>,
}

impl Coalescer {
    pub fn new(window_ms: f64) -> Self {
        Self {
            window_ms,
            pending: OrderedMap::new(),
        }
    }

    pub fn add(&mut self, session: JsString, item: Item, now: f64) {
        if !self.pending.contains_key(&session) {
            self.pending.set(
                session.clone(),
                Pending {
                    items: Vec::new(),
                    deadline: now + self.window_ms,
                },
            );
        }
        if let Some(pending) = self.pending.get_mut(&session) {
            pending.items.push(item);
        }
    }

    pub fn flush(&mut self, session: &JsString) -> Option<Vec<Item>> {
        let pending = self.pending.delete(session)?;
        if pending.items.is_empty() {
            None
        } else {
            Some(pending.items)
        }
    }

    pub fn cancel(&mut self, session: &JsString) -> bool {
        self.pending.delete(session).is_some()
    }

    /// Sessions whose window expired, in insertion order. They are removed from
    /// the deadline table by [`Coalescer::flush`].
    pub fn due(&self, now: f64) -> Vec<JsString> {
        self.pending
            .iter()
            .filter(|(_, pending)| now >= pending.deadline)
            .map(|(session, _)| session.clone())
            .collect()
    }

    pub fn next_due(&self) -> Option<f64> {
        self.pending
            .values()
            .map(|pending| pending.deadline)
            .reduce(f64::min)
    }

    /// The enriched control-channel output replaces the buffered snippet while
    /// the item is still waiting for its window.
    pub fn update_snippet(&mut self, token: u64, snippet: JsString) -> bool {
        for pending in self.pending.values_mut() {
            for item in pending.items.iter_mut() {
                if item.token == token {
                    item.snippet = snippet;
                    return true;
                }
            }
        }
        false
    }
}

const MONITOR_PREFIX: &str = "【后台事件】以下是后台工具的输出，不是用户回复。根据事件继续原任务，不要把监听仍在运行当作任务完成：";

/// Legacy `buildNudge(items)`; an empty list (or a non-list) yields `''`.
pub fn build_nudge(items: &[Item]) -> JsString {
    if items.is_empty() {
        return JsString::new();
    }
    if items.iter().any(|item| item.monitor) {
        let lines: Vec<JsString> = items
            .iter()
            .map(|item| {
                let mut line = JsString::new();
                line.push_str("- ");
                line.push(&js_to_string(&item.desc));
                line.push_str("（");
                if matches!(&item.status, JsValue::String(status) if status == "event") {
                    line.push_str("新事件，监听尚未结束");
                } else {
                    line.push(&js_to_string(&item.status));
                }
                line.push_str("） [ref:");
                line.push(&item.reference());
                line.push_str("]\n");
                line.push(&tail_units(
                    &string_or_empty(Some(&JsValue::String(item.snippet.clone()))),
                    MERGED_SNIPPET_CAP,
                ));
                line
            })
            .collect();
        let mut out = JsString::from_rust_str(MONITOR_PREFIX);
        out.push_str("\n");
        out.push(&JsString::join(&lines, &JsString::from_rust_str("\n")));
        return out;
    }
    if items.len() == 1 {
        let item = &items[0];
        let mut out = JsString::from_rust_str("【后台任务完成】你之前启动的后台任务（");
        out.push(&js_to_string(&item.desc));
        out.push_str("）已结束（状态：");
        out.push(&js_to_string(&item.status));
        out.push_str("）。");
        if !item.snippet.is_empty() {
            out.push_str("\n以下是它的输出，请据此继续推进任务，不要重复已完成的步骤：\n");
            out.push(&item.snippet);
        } else {
            out.push_str("\n（无输出）请据此继续推进任务。");
        }
        let reference = item.reference();
        if !reference.is_empty() {
            out.push_str(" [ref:");
            out.push(&reference);
            out.push_str("]");
        }
        return out;
    }
    let blocks: Vec<JsString> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut block = JsString::from_rust_str(&format!("{}. （", index + 1));
            block.push(&js_to_string(&item.desc));
            block.push_str("）状态：");
            block.push(&js_to_string(&item.status));
            block.push_str("——");
            if item.snippet.is_empty() {
                block.push_str("（无输出）");
                return block;
            }
            block.push_str("输出：\n   ");
            let snippet = tail_units(&item.snippet, MERGED_SNIPPET_CAP);
            let mut indented = JsString::new();
            for unit in snippet.as_units() {
                if *unit == 0x0a {
                    indented.push_str("\n   ");
                } else {
                    indented.push_unit(*unit);
                }
            }
            block.push(&indented);
            block
        })
        .collect();
    let ids: Vec<JsString> = items
        .iter()
        .filter_map(|item| {
            let id = item.reference();
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        })
        .collect();
    let mut out = JsString::from_rust_str(&format!(
        "【后台任务完成 ×{}】你之前启动的多个后台任务已先后结束，请据此一并推进、不要重复已完成的步骤：\n",
        items.len()
    ));
    out.push(&JsString::join(&blocks, &JsString::from_rust_str("\n")));
    if !ids.is_empty() {
        out.push_str(" [refs:");
        out.push(&JsString::join(&ids, &JsString::from_rust_str(",")));
        out.push_str("]");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    fn item(desc: &str, status: &str, snippet: &str) -> Item {
        Item::task(
            JsValue::string(desc),
            JsValue::string(status),
            text(snippet),
            None,
            Some(JsValue::string("tool-1")),
            1,
        )
    }

    #[test]
    fn single_nudge_matches_the_legacy_wording() {
        assert_eq!(
            build_nudge(&[item("任务", "completed", "done")]),
            text("【后台任务完成】你之前启动的后台任务（任务）已结束（状态：completed）。\n以下是它的输出，请据此继续推进任务，不要重复已完成的步骤：\ndone [ref:tool-1]")
        );
        assert_eq!(
            build_nudge(&[item("任务", "completed", "")]),
            text("【后台任务完成】你之前启动的后台任务（任务）已结束（状态：completed）。\n（无输出）请据此继续推进任务。 [ref:tool-1]")
        );
    }

    #[test]
    fn merged_nudge_lists_every_task_and_caps_snippets() {
        let merged = build_nudge(&[item("a", "completed", "one"), item("b", "failed", "")]);
        let merged = merged.to_string_lossy();
        assert!(merged.starts_with("【后台任务完成 ×2】"));
        assert!(merged.contains("1. （a）状态：completed——输出：\n   one"));
        assert!(merged.contains("2. （b）状态：failed——（无输出）"));
        assert!(merged.ends_with(" [refs:tool-1,tool-1]"));
    }

    #[test]
    fn monitor_nudge_marks_running_watches() {
        let monitor = Item::monitor(
            JsValue::string("watch"),
            JsValue::string("event"),
            text("line"),
            Some(JsValue::string("task-9")),
            None,
            2,
        );
        let out = build_nudge(&[monitor]).to_string_lossy();
        assert!(out.starts_with("【后台事件】"));
        assert!(out.contains("- watch（新事件，监听尚未结束） [ref:task-9]\nline"));
    }

    #[test]
    fn windows_are_fixed_and_start_at_the_first_item() {
        let mut coalescer = Coalescer::new(DEFAULT_WINDOW_MS);
        let session = text("s");
        coalescer.add(session.clone(), item("a", "completed", ""), 1000.0);
        coalescer.add(session.clone(), item("b", "completed", ""), 1400.0);
        assert_eq!(coalescer.next_due(), Some(2500.0));
        assert!(coalescer.due(2499.0).is_empty());
        assert_eq!(coalescer.due(2500.0), vec![session.clone()]);
        assert_eq!(coalescer.flush(&session).map(|items| items.len()), Some(2));
        assert!(coalescer.flush(&session).is_none());
    }

    #[test]
    fn update_snippet_only_touches_pending_items() {
        let mut coalescer = Coalescer::new(1000.0);
        let session = text("s");
        coalescer.add(session.clone(), item("a", "completed", "old"), 0.0);
        assert!(coalescer.update_snippet(1, text("new")));
        assert!(!coalescer.update_snippet(99, text("nope")));
        let items = coalescer.flush(&session).unwrap();
        assert_eq!(items[0].snippet, text("new"));
    }
}
