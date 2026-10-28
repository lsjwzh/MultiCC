//! 逐行 JSON 分帧。CDP 帧可能很大（截图 base64 到几 MB），所以按上限读而不是
//! 按字节读，也不让单帧无限增长。

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    TooLong,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(error) => write!(f, "{error}"),
            FrameError::TooLong => write!(f, "frame exceeds the size limit"),
        }
    }
}

pub struct LineReader<R> {
    inner: BufReader<R>,
    limit: usize,
}

impl<R: tokio::io::AsyncRead + Unpin> LineReader<R> {
    pub fn new(reader: R, limit: usize) -> Self {
        Self {
            inner: BufReader::new(reader),
            limit,
        }
    }

    /// 一行（不含行尾），EOF 时返回 None。空行返回空串 —— 调用方自己决定跳过。
    pub async fn next_line(&mut self) -> Result<Option<String>, FrameError> {
        match read_until(&mut self.inner, b'\n', self.limit).await? {
            None => Ok(None),
            Some(mut bytes) => {
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
            }
        }
    }
}

async fn read_until<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    delimiter: u8,
    limit: usize,
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut out = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(FrameError::Io)?;
        if available.is_empty() {
            return Ok(if out.is_empty() { None } else { Some(out) });
        }
        if let Some(position) = available.iter().position(|byte| *byte == delimiter) {
            out.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            return Ok(Some(out));
        }
        out.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
        if out.len() > limit {
            return Err(FrameError::TooLong);
        }
    }
}

pub async fn write_line<W: AsyncWrite + Unpin>(writer: &mut W, line: &str) -> io::Result<()> {
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

/// 一行控制消息（握手应答、上游断开通知）。它们和 CDP 帧走同一条流，靠「有 ok、
/// 没有 id/method」区分。
pub fn error_body(error: &str, detail: &str) -> String {
    let mut body = serde_json::Map::new();
    body.insert("ok".into(), serde_json::Value::Bool(false));
    body.insert("error".into(), serde_json::Value::String(error.into()));
    if !detail.is_empty() {
        body.insert("detail".into(), serde_json::Value::String(detail.into()));
    }
    serde_json::Value::Object(body).to_string()
}

/// CDP 形状的错误响应：调用方的 CDP 库会把它当普通命令失败处理，而不是协议错乱。
pub fn cdp_error(id: &serde_json::Value, code: i64, message: &str) -> String {
    serde_json::json!({ "id": id, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_split_on_newline_and_survive_partial_writes() {
        let input = b"{\"a\":1}\r\n\n{\"b\":2}".to_vec();
        let mut reader = LineReader::new(std::io::Cursor::new(input), 1024);
        assert_eq!(reader.next_line().await.unwrap().unwrap(), "{\"a\":1}");
        assert_eq!(reader.next_line().await.unwrap().unwrap(), "");
        assert_eq!(reader.next_line().await.unwrap().unwrap(), "{\"b\":2}");
        assert!(reader.next_line().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn oversized_frames_are_refused_instead_of_growing() {
        let input = vec![b'x'; 64];
        let mut reader = LineReader::new(std::io::Cursor::new(input), 16);
        assert!(matches!(reader.next_line().await, Err(FrameError::TooLong)));
    }
}
