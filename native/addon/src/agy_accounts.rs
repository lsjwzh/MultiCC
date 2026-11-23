//! 反重力(agy) 账号存储的原生入口。
//!
//! 存储规则（`active.json` 解析、16hex id 校验、目录存在性）只有一份，在
//! [`multicc_core::agy_accounts`]。Node 侧 spawn 与会话绑定校验都经由这里
//! 询问 Rust，不做任何 JS 复写。

use multicc_core::agy_accounts as store;
use napi_derive::napi;
use std::path::Path;

/// 活动账号的 HOME；没有钉账号（本机登录）或目录不存在时返回 `null`。
#[napi]
pub fn agy_account_home(home: String) -> Option<String> {
    store::active_home(Path::new(&home)).map(|dir| dir.to_string_lossy().into_owned())
}

/// 校验某个 agy 账号是否存在且拥有独立 HOME 目录。
#[napi]
pub fn agy_has_account(home: String, id: String) -> bool {
    store::has_account(Path::new(&home), &id)
}

/// 按绑定解析 agy 的 HOME：显式传入 `account_id` 时严格校验（不存在即报错，
/// 绝不静默退回全局或本机登录）；未传或为空时沿用全局活动账号。
#[napi]
pub fn agy_resolve_account_home(
    home: String,
    account_id: Option<String>,
) -> napi::Result<Option<String>> {
    store::resolve_home(Path::new(&home), account_id.as_deref())
        .map(|dir| dir.map(|path| path.to_string_lossy().into_owned()))
        .map_err(napi::Error::from_reason)
}
