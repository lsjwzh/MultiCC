//! Directory memo operations over the live registries, filesystem and turn engine.
use crate::{host_methods::method, route_response::*};
use napi::{check_status, Error};
use napi_derive::napi;

#[napi]
pub const MEMO_MAX_BYTES: u32 = multicc_core::docs_memory_routes::MEMO_MAX_BYTES as u32;
#[napi]
pub const MEMO_FILENAME: &str = "memo.md";
#[napi]
pub const LEGACY_PROJECT_MEMO_FILENAME: &str = "multicc.memo.md";

fn domain<T>(p: L<'_>, kind: &str, message: &str, code: &str) -> Result<T> {
    let msg = text(p, message)?;
    let options = fields(p, &[("code", text(p, code)?), ("publicMessage", msg)])?;
    Err(p
        .get(c"DomainError")?
        .construct(&[text(p, kind)?, msg, options])?
        .throw_error())
}

fn infrastructure<T>(p: L<'_>, message: &str, cause: L<'_>) -> Result<T> {
    let options = fields(p, &[("cause", cause)])?;
    Err(p
        .get(c"InfrastructureError")?
        .construct(&[text(p, message)?, options])?
        .throw_error())
}

fn wrap_io<'a>(p: L<'a>, message: &str, action: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    match action() {
        Ok(value) => Ok(value),
        Err(e) => infrastructure(p, message, p.exception_value()?.ok_or(e)?),
    }
}

fn directory<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let value = call(p.get(c"directories")?, c"get", &[id])?;
    if !value.truthy()? {
        return domain(
            p,
            "not_found",
            "directory not found",
            "memo_directory_not_found",
        );
    }
    Ok(value)
}

fn memo_dir<'a>(p: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    let id = string(fallback(dir.get(c"id")?, "".into())?)?;
    let s = id
        .string()?
        .ok_or_else(|| Error::from_reason("expected directory id string"))?;
    let s = s.as_str_lossy();
    if s.is_empty()
        || s == "."
        || s == ".."
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return infrastructure(
            p,
            "memo directory id is not path safe",
            p.from_value(&V::Undefined)?,
        );
    }
    wrap_io(p, "memo path resolution failed", || {
        call(p.get(c"pathPort")?, c"join", &[p.get(c"memoRoot")?, id])
    })
}

fn memo_path<'a>(p: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    wrap_io(p, "memo path resolution failed", || {
        let path = p.get(c"pathPort")?;
        path.get(c"join")?
            .call(path, &[memo_dir(p, dir)?, text(p, MEMO_FILENAME)?])
    })
}

fn read<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let file = memo_path(p, directory(p, id)?)?;
    let files = p.get(c"files")?;
    let result = (|| {
        let body = call(files, c"readText", &[file])?;
        let time = call(files, c"stat", &[file])?.get(c"mtimeMs")?;
        fields(
            p,
            &[
                ("path", file),
                ("text", body),
                ("mtime", time),
                ("exists", flag(p, true)?),
            ],
        )
    })();
    match result {
        Ok(value) => Ok(value),
        Err(e) => {
            let cause = p.exception_value()?.ok_or(e)?;
            if cause.truthy()? && cause.get(c"code")?.is_string("ENOENT")? {
                fields(
                    p,
                    &[
                        ("path", file),
                        ("text", text(p, "")?),
                        ("mtime", num(p, 0.)?),
                        ("exists", flag(p, false)?),
                    ],
                )
            } else {
                infrastructure(p, "memo read failed", cause)
            }
        }
    }
}

fn write<'a>(p: L<'a>, id: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let dir = directory(p, id)?;
    if body.kind()? != sys::ValueType::napi_string {
        return domain(
            p,
            "bad_request",
            "text must be a string",
            "memo_text_invalid",
        );
    }
    let mut bytes = 0;
    check_status!(unsafe {
        sys::napi_get_value_string_utf8(body.env(), body.raw(), std::ptr::null_mut(), 0, &mut bytes)
    })?;
    if bytes > MEMO_MAX_BYTES as usize {
        return domain(
            p,
            "payload_too_large",
            "memo too large (>5MB)",
            "memo_too_large",
        );
    }
    let files = p.get(c"files")?;
    if !files
        .get(c"exists")?
        .call(files, &[dir.get(c"path")?])?
        .truthy()?
    {
        return domain(
            p,
            "bad_request",
            "directory path missing",
            "memo_directory_path_missing",
        );
    }
    let file = memo_path(p, dir)?;
    wrap_io(p, "memo write failed", || {
        files.get(c"ensureDir")?.call(files, &[memo_dir(p, dir)?])?;
        call(files, c"writeAtomic", &[file, body])?;
        fields(
            p,
            &[
                ("path", file),
                ("mtime", call(files, c"stat", &[file])?.get(c"mtimeMs")?),
            ],
        )
    })
}

fn trimmed(value: L<'_>) -> Result<L<'_>> {
    let s = string(fallback(value, "".into())?)?;
    call(s, c"trim", &[])
}

fn prepare_send<'a>(p: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let dir = directory(p, args[0])?;
    let body = trimmed(args[1])?;
    let session_id = trimmed(args[2])?;
    if !body.truthy()? {
        return domain(p, "bad_request", "text required", "memo_text_required");
    }
    if !session_id.truthy()? {
        return domain(
            p,
            "bad_request",
            "sessionId required",
            "memo_session_required",
        );
    }
    let target = call(p.get(c"sessions")?, c"get", &[session_id])?;
    if !target.truthy()? {
        return domain(
            p,
            "not_found",
            "session not found",
            "memo_session_not_found",
        );
    }
    if !target.get(c"dirId")?.equals(dir.get(c"id")?)? {
        return domain(
            p,
            "bad_request",
            "session is not in this directory",
            "memo_session_mismatch",
        );
    }
    if !target.get(c"kind")?.is_string("chat")? {
        return domain(
            p,
            "bad_request",
            "只能发送到 chat 类型的会话",
            "memo_session_kind_invalid",
        );
    }
    fields(p, &[("sessionId", session_id), ("text", body)])
}

#[napi]
pub fn memo_controller(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    for (port, methods) in [
        (c"directories", &[c"get"][..]),
        (c"sessions", &[c"get"]),
        (c"runtime", &[c"getChatSession", c"runTurn"]),
        (
            c"files",
            &[
                c"readText",
                c"stat",
                c"exists",
                c"ensureDir",
                c"writeAtomic",
            ],
        ),
        (c"pathPort", &[c"join"]),
    ] {
        let service = p.get(port)?;
        for &name in methods {
            if !service.truthy()? || service.get(name)?.kind()? != sys::ValueType::napi_function {
                return Err(p.type_error(&format!(
                    "memo controller requires {}()",
                    name.to_string_lossy()
                )));
            }
        }
    }
    let root = p.get(c"memoRoot")?;
    if root.kind()? != sys::ValueType::napi_string || !root.truthy()? {
        return Err(p.type_error("memo controller requires memoRoot"));
    }
    let finish = method(&env, p, "finishSend", 3, 3, |p, a| {
        if a[1].is_false()? {
            return infrastructure(p, "memo turn start failed", a[2]);
        }
        fields(p, &[("ok", flag(p, true)?), ("sentTo", a[0])])
    })?;
    Ok(fields(
        p,
        &[
            ("read", method(&env, p, "read", 1, 1, |p, a| read(p, a[0]))?),
            (
                "write",
                method(&env, p, "write", 2, 2, |p, a| write(p, a[0], a[1]))?,
            ),
            (
                "prepareSend",
                method(&env, p, "prepareSend", 3, 3, |p, a| prepare_send(p, a))?,
            ),
            ("finishSend", finish),
        ],
    )?
    .raw())
}
