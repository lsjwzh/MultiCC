use super::*;
use napi::bindgen_prelude::{JsValue as _, ToNapiValue};

pub(crate) fn bytes(input: L<'_>) -> Result<Vec<u8>> {
    let mut data = std::ptr::null_mut();
    let mut len = 0;
    napi::check_status!(unsafe {
        sys::napi_get_buffer_info(input.env(), input.raw(), &mut data, &mut len)
    })?;
    if len == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec())
}
pub(crate) fn buffer<'a>(p: L<'a>, raw: &[u8]) -> Result<L<'a>> {
    let mut value = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_buffer_copy(
            p.env(),
            raw.len(),
            raw.as_ptr().cast(),
            std::ptr::null_mut(),
            &mut value,
        )
    })?;
    Ok(L::from_raw(p.env(), value))
}
pub(crate) fn background<'a>(
    p: L<'a>,
    work: impl FnOnce() -> std::result::Result<(), String> + Send + 'static,
) -> Result<L<'a>> {
    let env = crate::host_methods::env(p);
    let task = env.spawn_future_with_callback(
        async move {
            tokio::task::spawn_blocking(work)
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
                .map_err(napi::Error::from_reason)
        },
        |env, _| Ok(().into_unknown(env)?.raw()),
    )?;
    Ok(L::from_raw(p.env(), task.raw()))
}
