//! 只读查询：一批 id 里哪些已经被删除。
//!
//! 宿主的批量调用方（任务首次迁移）每轮要对「聊天记录里绑定的 id」和「任务表里的
//! 全部 id」各问一次「已删除吗」。逐个问等于让常驻任务板的 `deletedTaskIds` 被
//! 重扫一遍，条数上千时整轮是 O(N·m)。这里只把这张表建成一次 HashSet，再按入参
//! 顺序逐个判定。
use super::*;
use std::collections::HashSet;

/// `ids` 中已删除者：保持入参顺序、重复项原样保留（调用方直接建 Set）。
/// 非字符串入参一律视为未删除 —— 与宿主 `deletedTaskIds.includes(id)` 对
/// 非字符串 id 的结果一致（表里只存字符串 id）。
pub fn among(b: &Value, ids: &Value) -> Vec<Value> {
    let deleted = b["deletedTaskIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    ids.as_array()
        .into_iter()
        .flatten()
        .filter(|id| id.as_str().is_some_and(|s| deleted.contains(s)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(deleted: Value) -> Value {
        json!({"schemaVersion":2,"tasks":{},"modules":{},"deletedTaskIds":deleted})
    }

    #[test]
    fn empty_ids_never_match() {
        assert!(among(&board(json!(["a"])), &json!([])).is_empty());
        assert!(among(&board(json!(["a"])), &Value::Null).is_empty());
        assert!(among(&board(json!(["a"])), &json!({"0":"a"})).is_empty());
    }

    #[test]
    fn missing_or_non_array_deleted_list_means_nothing_is_deleted() {
        assert!(among(&json!({"schemaVersion":2}), &json!(["a"])).is_empty());
        assert!(among(&board(Value::Null), &json!(["a"])).is_empty());
        assert!(among(&board(json!({"a":true})), &json!(["a"])).is_empty());
        assert!(among(&board(json!("a")), &json!(["a"])).is_empty());
    }

    #[test]
    fn non_string_inputs_are_not_deleted() {
        let found = among(
            &board(json!(["a", 7])),
            &json!(["b", null, 7, true, ["a"], {"id":"a"}]),
        );
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn non_string_deleted_entries_never_match() {
        // `includes` 对字符串 id 也匹配不到表里的非字符串项。
        assert!(among(&board(json!([7, null, true, ["a"]])), &json!(["a"])).is_empty());
    }

    #[test]
    fn all_none_and_partial_hits() {
        let b = board(json!(["a", "c"]));
        assert_eq!(among(&b, &json!(["a", "c"])), vec![json!("a"), json!("c")]);
        assert!(among(&b, &json!(["b", "d"])).is_empty());
        assert_eq!(among(&b, &json!(["b", "c", "d"])), vec![json!("c")]);
    }

    #[test]
    fn input_order_and_duplicates_are_preserved() {
        let found = among(
            &board(json!(["c", "a"])),
            &json!(["a", "b", "c", "a", "c", "a"]),
        );
        assert_eq!(
            found,
            vec![json!("a"), json!("c"), json!("a"), json!("c"), json!("a")]
        );
    }

    #[test]
    fn the_board_is_not_touched() {
        let b = board(json!(["a"]));
        let before = b.to_string();
        among(&b, &json!(["a", "b"]));
        assert_eq!(b.to_string(), before);
    }
}
