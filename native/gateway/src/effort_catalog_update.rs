//! 网关是 GitHub 强度目录的下载者。兼容宿主从同一份原子替换的本地文件热加载。
use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{
    app::App,
    outbound::{Outbound, Request},
};
use multicc_core::effort_catalog;
use url::Url;

const SOURCE: &str =
    "https://raw.githubusercontent.com/lsjwzh/MultiCC/main/native/core/src/cli_efforts.json";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(15 * 60);

pub async fn refresh(outbound: &Outbound, file: PathBuf, source: Url) -> Result<(), String> {
    let mut request = Request::get(source, Duration::from_secs(10));
    request.max_body = Some(effort_catalog::MAX_BYTES);
    let reply = outbound.send(request).await.map_err(|e| e.message())?;
    if reply.status != 200 {
        return Err(format!("HTTP {}", reply.status));
    }
    tokio::task::spawn_blocking(move || effort_catalog::install(&file, &reply.body))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) async fn start(app: Arc<App>) -> tokio::task::JoinHandle<()> {
    let root = if app.data_root == app.package_root {
        app.home_dir.join(".multicc")
    } else {
        app.data_root.clone()
    };
    let file = root.join("catalogs/cli-efforts.json");
    let cached = file.clone();
    // 服务就绪前只读本地缓存。首次安装、缓存损坏或网络不可用时均有随包快照。
    if let Ok(Err(reason)) =
        tokio::task::spawn_blocking(move || effort_catalog::reload(&cached)).await
    {
        eprintln!("[multicc] 强度目录缓存不可用：{reason}");
    }
    tokio::spawn(async move {
        let url = Url::parse(SOURCE).expect("official GitHub catalog URL");
        loop {
            let delay = match refresh(&app.outbound, file.clone(), url.clone()).await {
                Ok(()) => CHECK_INTERVAL,
                Err(error) => {
                    eprintln!("[multicc] 强度目录更新失败，继续使用本地版本：{error}");
                    RETRY_INTERVAL
                }
            };
            tokio::time::sleep(delay).await;
        }
    })
}
