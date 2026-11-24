//! 随包编译同一份 GitHub 数据。schemaVersion 约束格式，revision 单调递增。
//! 规则变化时只更新 cli_efforts.json 并递增 revision，改变参数协议则需要新程序。
use crate::{cli_capability::EffortSpec, provider_store};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::sync::{Arc, LazyLock, RwLock};

pub const MAX_BYTES: usize = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub revision: u64,
    pub efforts: BTreeMap<String, EffortSpec>,
}

fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

fn distinct(values: &[String]) -> bool {
    let set: HashSet<_> = values.iter().collect();
    set.len() == values.len()
}

fn parse(bytes: &[u8]) -> Result<Catalog, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("强度目录过大");
    }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|_| "强度目录格式无效")?;
    if catalog.schema_version != 2 || catalog.revision == 0 || catalog.efforts.is_empty() {
        return Err("不支持的强度目录版本或空目录");
    }
    for (cli, spec) in &catalog.efforts {
        if !token(cli)
            || spec.label.trim().is_empty()
            || !distinct(&spec.levels)
            || spec.levels.iter().any(|s| !s.is_empty() && !token(s))
            || !(spec.levels.contains(&spec.default)
                || (spec.levels.is_empty() && spec.default.is_empty()))
            || spec
                .disabled_model_family
                .as_ref()
                .is_some_and(|s| s.trim().is_empty())
            || spec
                .tier_suffixes
                .iter()
                .any(|s| !s.strip_prefix('-').is_some_and(token))
            || spec.model_levels.iter().any(|(model, levels)| {
                model.trim().is_empty()
                    || !distinct(levels)
                    || levels.iter().any(|v| !spec.levels.contains(v))
            })
        {
            return Err("强度目录中的 CLI、档位或模型规则无效");
        }
    }
    Ok(catalog)
}

static BUNDLED: LazyLock<Arc<Catalog>> = LazyLock::new(|| {
    Arc::new(parse(include_bytes!("cli_efforts.json")).expect("valid bundled effort catalog"))
});
static ACTIVE: LazyLock<RwLock<Arc<Catalog>>> = LazyLock::new(|| RwLock::new(BUNDLED.clone()));

pub fn snapshot() -> Arc<Catalog> {
    ACTIVE.read().unwrap().clone()
}

fn activate(mut catalog: Catalog) {
    // 缓存保留完整目录以供新版程序读取。本机只公布已经实现启动协议的车道。
    catalog
        .efforts
        .retain(|cli, _| BUNDLED.efforts.contains_key(cli));
    let mut active = ACTIVE.write().unwrap();
    if catalog.revision > active.revision {
        *active = Arc::new(catalog);
    }
}

fn complete(bytes: &[u8]) -> Result<Catalog, &'static str> {
    let catalog = parse(bytes)?;
    if !BUNDLED
        .efforts
        .keys()
        .all(|key| catalog.efforts.contains_key(key))
    {
        return Err("强度目录缺少内置 CLI");
    }
    Ok(catalog)
}

fn read_cache(file: &Path) -> Result<Option<Catalog>, &'static str> {
    let handle = match File::open(file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("读取强度目录失败"),
    };
    let mut bytes = Vec::new();
    handle
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取强度目录失败")?;
    complete(&bytes).map(Some)
}

// 网关和宿主分别持有内存快照。读取完成前或出错时继续使用上一次有效规则。
pub fn reload(file: &Path) -> Result<(), &'static str> {
    if let Some(catalog) = read_cache(file)? {
        activate(catalog);
    }
    Ok(())
}

pub fn install(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let candidate = complete(bytes)?;
    if candidate.revision <= snapshot().revision {
        return Ok(());
    }
    let _lock = provider_store::lock(file)?;
    // 共用数据目录的网关不能用较慢的响应覆盖较新的快照。损坏的缓存可由有效下载修复。
    if let Ok(Some(cached)) = read_cache(file) {
        if cached.revision >= candidate.revision {
            activate(cached);
            return Ok(());
        }
    }
    if candidate.revision > snapshot().revision {
        let value = serde_json::to_value(&candidate).map_err(|err| err.to_string())?;
        // atomic_write 将 JSON 美化后落盘，落盘形式也必须能在下次启动时读回。
        if serde_json::to_vec_pretty(&value)
            .map_err(|e| e.to_string())?
            .len()
            + 1
            > MAX_BYTES
        {
            return Err("强度目录缓存过大".into());
        }
        provider_store::atomic_write(file, &value)?;
        activate(candidate);
    }
    Ok(())
}
