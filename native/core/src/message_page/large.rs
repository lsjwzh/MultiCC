//! Read selected fields from a record larger than the normal single-row buffer.
//! serde skips each value on the buffered reader; only byte ranges are retained.
use super::*;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use std::{
    cell::Cell,
    fmt,
    io::{BufReader, Read, Seek, SeekFrom},
};

struct Count<'a, R>(R, &'a Cell<u64>);
impl<R: Read> Read for Count<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.read(buf)?;
        self.1.set(self.1.get() + n as u64);
        Ok(n)
    }
}
struct Fields<'a>(&'a Cell<u64>);
impl<'de> Visitor<'de> for Fields<'_> {
    type Value = Vec<(String, (u64, u64))>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a message object")
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut spans = Vec::new();
        while let Some(k) = map.next_key::<String>()? {
            let start = self.0.get();
            map.next_value::<IgnoredAny>()?;
            if matches!(
                k.as_str(),
                "id" | "role"
                    | "taskId"
                    | "ts"
                    | "content"
                    | "tools"
                    | "usage"
                    | "usageEpoch"
                    | "usageCumulative"
                    | "turnId"
                    | "clientMsgId"
                    | "heldResultId"
                    | "_handoffArchive"
                    | "_interim"
                    | "cancelled"
                    | "error"
                    | "partial"
            ) {
                spans.push((k, (start, self.0.get())));
            }
        }
        Ok(spans)
    }
}

pub(super) fn project(mut file: &File, offset: u64, len: usize) -> Result<Value> {
    let resume = file.stream_position().map_err(err)?;
    let result = (|| {
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let pos = Cell::new(0);
        let mut de = serde_json::Deserializer::from_reader(Count(
            BufReader::new(file.take(len as u64)),
            &pos,
        ));
        let spans = serde::Deserializer::deserialize_map(&mut de, Fields(&pos)).map_err(err)?;
        de.end().map_err(err)?;
        let mut out = json!({"truncated":true,"originalLength":len});
        // The reader may include the peeked comma/closing brace for scalar numbers.
        for (key, (start, end)) in spans {
            let cap = if key == "content" || key == "tools" {
                8192
            } else {
                4096
            };
            file.seek(SeekFrom::Start(offset + start)).map_err(err)?;
            let mut bytes = vec![0; ((end - start) as usize).min(cap)];
            file.read_exact(&mut bytes).map_err(err)?;
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim_start().trim_start_matches(':').trim_start();
            if let Some(Ok(v)) = serde_json::Deserializer::from_str(text)
                .into_iter::<Value>()
                .next()
            {
                out[key] = v;
            } else if key == "taskId" {
                // An oversized task stamp cannot match a task ID. Do not treat
                // it as an unstamped record belonging to the primary session.
                out[key] = Value::Bool(true);
            } else if key == "tools" {
                out["toolsExcerpt"] = json!(text);
            } else if key == "content" {
                // End at a complete escape and UTF-8 character for string previews.
                let mut prefix = text.to_string();
                if prefix.starts_with('"') {
                    while !prefix.is_empty() {
                        if let Ok(v) = serde_json::from_str::<String>(&format!("{prefix}\"")) {
                            out["content"] = json!(v);
                            break;
                        }
                        prefix.pop();
                    }
                } else {
                    out["content"] = json!(prefix);
                }
            }
        }
        Ok(out)
    })();
    file.seek(SeekFrom::Start(resume)).map_err(err)?;
    result
}
