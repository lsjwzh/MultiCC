//! 宿主事实（V8 日期解析、ICU 排序）的查表视图；规则只按值查表，不重做宿主语义。
use super::text;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;

/// `[[原值, wireDate(原值)], ...]` 的查表形式。键是原值的 JSON 文本：与旧协议
/// 按 `Value` 相等逐个比对的结果一致（宿主 JSON 里不会出现 -0）。
#[derive(Default, Clone)]
pub struct Dates(HashMap<String, Value>);

impl Dates {
    pub fn from_pairs(pairs: &Value) -> Self {
        let mut dates = Self::default();
        dates.extend(pairs, false);
        dates
    }
    /// 旧数组按首个匹配生效；常驻表重复上送的是同一函数的值，覆盖与否等价。
    pub fn extend(&mut self, pairs: &Value, overwrite: bool) {
        for p in pairs.as_array().into_iter().flatten() {
            let key = p[0].to_string();
            if overwrite {
                self.0.insert(key, p[1].clone());
            } else {
                self.0.entry(key).or_insert_with(|| p[1].clone());
            }
        }
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// 宿主按 `localeCompare` 排好的 id 序列；只认字符串元素，重复 id 取首个位置。
#[derive(Default, Clone)]
pub struct Order(HashMap<String, usize>);

impl Order {
    pub fn from_ids(ids: &Value) -> Self {
        let mut order = HashMap::new();
        for (i, id) in ids.as_array().into_iter().flatten().enumerate() {
            if let Some(id) = id.as_str() {
                order.entry(id.to_string()).or_insert(i);
            }
        }
        Self(order)
    }
    fn position(&self, v: &Value) -> usize {
        v.as_str()
            .and_then(|id| self.0.get(id).copied())
            .unwrap_or(usize::MAX)
    }
}

#[derive(Clone, Copy)]
pub struct Host<'a> {
    pub dates: &'a Dates,
    pub order: &'a Order,
}

impl Host<'_> {
    /// 旧 `due()`：空值为 null，其余只认宿主解析结果，查不到即 null。
    pub fn date(&self, v: &Value) -> Value {
        if v.is_null() || v == "" {
            return Value::Null;
        }
        self.dates
            .0
            .get(&v.to_string())
            .cloned()
            .unwrap_or(Value::Null)
    }
    /// 旧 `compare()`：先按宿主序，序外 id 排在后面并按字节序。
    pub fn compare(&self, a: &Value, b: &Value) -> Ordering {
        self.order
            .position(a)
            .cmp(&self.order.position(b))
            .then_with(|| text(a).cmp(text(b)))
    }
}

/// 无状态调用：每次从命令里的数组构表（O(n)），替代旧实现每次比较都克隆数组。
/// `Default` 供旧实现中未携带 dates/idOrder 的嵌套调用保持空表语义。
#[derive(Default)]
pub struct Facts {
    pub dates: Dates,
    pub order: Order,
}

impl Facts {
    pub fn of(v: &Value) -> Self {
        Self {
            dates: Dates::from_pairs(&v["dates"]),
            order: Order::from_ids(&v["idOrder"]),
        }
    }
    pub fn host(&self) -> Host<'_> {
        Host {
            dates: &self.dates,
            order: &self.order,
        }
    }
}
