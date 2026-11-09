//! Bounded, mutually authenticated private control stream. The gateway binds
//! before spawning its child; the addon connects out, so no released-port race.
//! Neither the capability nor credential-bearing messages may be logged.
use crate::auth_security::{random_base64url, sign, timing_safe_equal_text};
use serde::{de::DeserializeOwned, Serialize};
use std::io;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub const MAX_FRAME: usize = 64 * 1024;
pub const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

pub async fn read<T: DeserializeOwned>(stream: &mut TcpStream) -> io::Result<T> {
    let size = stream.read_u32().await? as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData.into())
}
pub async fn write<T: Serialize>(stream: &mut TcpStream, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| io::ErrorKind::InvalidData)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(&bytes).await
}

/// Bulk replies on the separate workspace channel. Each allocation from the
/// wire is bounded by MAX_FRAME; zero terminates the message. There is no new
/// record-count limit on an existing share list. The caller bounds elapsed time
/// and concurrency and must discard the connection on cancellation or failure.
pub async fn read_chunks<T: DeserializeOwned>(stream: &mut TcpStream) -> io::Result<T> {
    let mut bytes = Vec::new();
    loop {
        let size = stream.read_u32().await? as usize;
        if size == 0 {
            return serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData.into());
        }
        if size > MAX_FRAME {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let start = bytes.len();
        bytes
            .try_reserve(size)
            .map_err(|_| io::ErrorKind::OutOfMemory)?;
        bytes.resize(start + size, 0);
        stream.read_exact(&mut bytes[start..]).await?;
    }
}
pub async fn write_chunks<T: Serialize>(stream: &mut TcpStream, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| io::ErrorKind::InvalidData)?;
    for chunk in bytes.chunks(MAX_FRAME) {
        stream.write_u32(chunk.len() as u32).await?;
        stream.write_all(chunk).await?;
    }
    stream.write_u32(0).await
}
pub async fn accept(stream: &mut TcpStream, capability: &str) -> io::Result<()> {
    let nonce = random_base64url(24).map_err(|_| io::ErrorKind::Other)?;
    write(stream, &nonce).await?;
    let proof: String = read(stream).await?;
    if !timing_safe_equal_text(&proof, &sign(capability, &format!("child:{nonce}"))) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    write(stream, &sign(capability, &format!("parent:{nonce}"))).await
}
pub async fn connect(stream: &mut TcpStream, capability: &str) -> io::Result<()> {
    let nonce: String = read(stream).await?;
    if nonce.len() != 32 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    write(stream, &sign(capability, &format!("child:{nonce}"))).await?;
    let proof: String = read(stream).await?;
    if !timing_safe_equal_text(&proof, &sign(capability, &format!("parent:{nonce}"))) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
