//! The OS owns the secret. Policy only needs its type and UTF-16 length.
use napi_derive::napi;

const SERVICE: &str = "com.multicc.agent.unlock";

#[napi]
pub fn unlock_password_error(available: bool, length: f64) -> Option<String> {
    let message = if !available {
        "This setting is only available on macOS"
    } else if length <= 0.0 {
        "unlock password is required"
    } else if length > 2048.0 {
        "unlock password is too long"
    } else {
        return None;
    };
    Some(message.into())
}

#[napi]
pub fn unlock_keychain_prefix(operation: String) -> Vec<String> {
    let args = match operation.as_str() {
        "set" => vec!["add-generic-password", "-U"],
        "clear" => vec!["delete-generic-password"],
        _ => vec!["find-generic-password"],
    };
    args.into_iter()
        .chain(["-s", SERVICE, "-a"])
        .map(String::from)
        .collect()
}

#[napi]
pub fn unlock_keychain_error(operation: String, ok: bool, missing: bool) -> Option<String> {
    if ok || (missing && operation != "set") {
        return None;
    }
    Some(
        match operation.as_str() {
            "set" => "密码未能保存到本机钥匙串，请在这台 Mac 上重试。",
            "clear" => "未能删除已保存的密码，请重试。",
            _ => "暂时无法读取已保存的密码状态，请重试。",
        }
        .into(),
    )
}
