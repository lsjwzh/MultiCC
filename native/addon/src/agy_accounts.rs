//! 反重力(agy) 账号存储的原生入口。
//!
//! 存储规则（`active.json` 解析、16hex id 校验、目录存在性）只有一份，在
//! [`multicc_core::agy_accounts`]。Node 侧 spawn 时只需问一句「活动账号的 HOME
//! 是哪个」，因此这里只暴露 `active_home`，不做任何 JS 复写。

use multicc_core::agy_accounts as store;
use napi_derive::napi;
use std::path::Path;

/// 活动账号的 HOME；没有钉账号（本机登录）或目录不存在时返回 `null`。
#[napi]
pub fn agy_account_home(home: String) -> Option<String> {
    store::active_home(Path::new(&home)).map(|dir| dir.to_string_lossy().into_owned())
}
