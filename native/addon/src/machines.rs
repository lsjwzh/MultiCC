use napi::threadsafe_function::ThreadsafeFunction;
use napi::Result;
use napi_derive::napi;

#[napi]
pub async fn machine_operation(root: String, operation: String, input: String) -> Result<String> {
    Ok(multicc_core::machines::operate(&root, &operation, &input).await)
}

#[napi]
pub fn authorize_machine_request(
    root: String,
    credential: String,
    method: String,
    path: String,
) -> Option<String> {
    multicc_core::machines::authorize(&root, &credential, &method, &path)
}

#[napi]
pub fn machine_grant_active(root: String, id: String) -> bool {
    multicc_core::machines::grant_active(&root, &id)
}

#[napi]
pub async fn machine_event_stream(
    root: String,
    input: String,
    callback: ThreadsafeFunction<String, bool>,
) -> Result<String> {
    Ok(
        multicc_core::machines::events(&root, &input, |event| async {
            callback.call_async(Ok(event)).await.unwrap_or(false)
        })
        .await,
    )
}
