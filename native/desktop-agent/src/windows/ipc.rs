use super::State;
use multicc_desktop_agent::{failure, MAX_LINE};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::Threading::*,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn user_sid() -> io::Result<String> {
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        // usize backing preserves TOKEN_USER alignment.
        let mut buffer = vec![0usize; (len as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut sid = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0;
        while *sid.add(n) != 0 {
            n += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(sid, n));
        LocalFree(sid.cast());
        Ok(result)
    }
}

fn instance(name: &str, first: bool, sid: &str) -> io::Result<NamedPipeServer> {
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        // Protected DACL: no inherited ACEs, no Everyone/Authenticated Users access.
        let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                (&mut security as *mut SECURITY_ATTRIBUTES).cast(),
            );
        LocalFree(descriptor);
        result
    }
}

pub(super) async fn serve(name: &str, state: Arc<State>) -> io::Result<()> {
    if !name.starts_with(r"\\.\pipe\") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local pipe required",
        ));
    }
    let sid = user_sid()?;
    let mut next = instance(name, true, &sid)?;
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        let permit = slots
            .clone()
            .acquire_owned()
            .await
            .map_err(io::Error::other)?;
        next.connect().await?;
        let stream = std::mem::replace(&mut next, instance(name, false, &sid)?);
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = connection(stream, state).await;
        });
    }
}

struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
async fn connection(mut stream: NamedPipeServer, state: Arc<State>) -> io::Result<()> {
    let read = async {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if stream.read(&mut byte).await? == 0 {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            if byte[0] == b'\n' {
                return Ok(buf);
            }
            if buf.len() == MAX_LINE {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request too large",
                ));
            }
            buf.push(byte[0]);
        }
    };
    let bytes = tokio::time::timeout(Duration::from_secs(10), read).await??;
    let response = if let Ok(req) = serde_json::from_slice(&bytes) {
        let cancel = Cancel(Arc::new(AtomicBool::new(false)));
        let flag = cancel.0.clone();
        let mut job = tokio::task::spawn_blocking(move || state.dispatch(req, flag));
        let mut byte = [0; 1];
        tokio::select! {
            result=&mut job=>result.map_err(io::Error::other)?,
            _=stream.read(&mut byte)=>{
                cancel.0.store(true,Ordering::Release);
                let _=job.await; return Ok(());
            }
        }
    } else {
        failure("bad-json")
    };
    tokio::time::timeout(
        Duration::from_secs(3),
        stream.write_all(format!("{response}\n").as_bytes()),
    )
    .await??;
    // Keep the pipe instance alive until the caller has consumed the reply.
    // Closing a Windows pipe with unread buffered output can discard that output.
    let mut end = [0u8; 1];
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut end)).await;
    Ok(())
}

pub(super) async fn client(name: &str, req: &str) -> io::Result<String> {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut stream = loop {
            match ClientOptions::new().open(name) {
                Ok(s) => break s,
                Err(e) if e.raw_os_error() == Some(231) => {
                    tokio::time::sleep(Duration::from_millis(20)).await
                }
                Err(e) => return Err(e),
            }
        };
        stream.write_all(format!("{req}\n").as_bytes()).await?;
        let mut out = Vec::new();
        let mut byte = [0; 1];
        while stream.read(&mut byte).await? != 0 {
            if byte[0] == b'\n' {
                return String::from_utf8(out).map_err(io::Error::other);
            }
            if out.len() == MAX_LINE {
                return Err(io::Error::other("response too large"));
            }
            out.push(byte[0]);
        }
        Err(io::Error::from(io::ErrorKind::UnexpectedEof))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;

    #[tokio::test]
    async fn pipe_acl_grants_only_the_current_user_and_prevents_second_server() {
        let name = format!(r"\\.\pipe\multicc-agent-acl-test-{}", std::process::id());
        let sid = user_sid().unwrap();
        let server = instance(&name, true, &sid).unwrap();
        assert!(instance(&name, true, &sid).is_err());
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            let mut acl = std::ptr::null_mut();
            assert_eq!(
                GetSecurityInfo(
                    server.as_raw_handle(),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut acl,
                    std::ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            assert!(!acl.is_null());
            assert_eq!((*acl).AceCount, 1);
            let mut ace = std::ptr::null_mut();
            assert_ne!(GetAce(acl, 0, &mut ace), 0);
            let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
            assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
            let mut actual = std::ptr::null_mut();
            assert_ne!(
                ConvertSidToStringSidW(
                    (&ace.SidStart as *const u32).cast_mut().cast(),
                    &mut actual
                ),
                0
            );
            let mut n = 0;
            while *actual.add(n) != 0 {
                n += 1;
            }
            assert_eq!(
                String::from_utf16_lossy(std::slice::from_raw_parts(actual, n)),
                sid
            );
            LocalFree(actual.cast());
            LocalFree(descriptor);
        }
    }

    #[tokio::test]
    async fn real_pipe_server_handles_valid_and_malformed_requests() {
        let name = format!(r"\\.\pipe\multicc-agent-wire-test-{}", std::process::id());
        let state = Arc::new(State {
            control: Arc::new(std::sync::Mutex::new(Default::default())),
            input: std::sync::Mutex::new(Default::default()),
            watching: AtomicBool::new(false),
        });
        let server_name = name.clone();
        let server = tokio::spawn(async move { serve(&server_name, state).await });
        let ready = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(r) = client(&name, r#"{"op":"ping"}"#).await {
                    break r;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&ready).unwrap()["pong"],
            true
        );
        let bad = client(&name, "{bad").await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&bad).unwrap()["reason"],
            "bad-json"
        );
        server.abort();
        let _ = server.await;
    }
}
