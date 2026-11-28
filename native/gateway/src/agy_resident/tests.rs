use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};
fn fixture(name: &str) -> (Launch, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "multicc-agy-{name}-{:?}.log",
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/helpers/fake-agy-stream.cjs");
    (
        Launch {
            bin: bin.to_string_lossy().into(),
            args: vec!["--test-log".into(), path.to_string_lossy().into()],
            conversation: None,
            remote: false,
            egress: false,
        },
        path,
    )
}
fn records(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
#[tokio::test]
async fn 多轮同进程且空闲后回收() {
    let (launch, path) = fixture("idle");
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send("一".into()).unwrap();
    tx.send("二".into()).unwrap();
    timeout(
        Duration::from_secs(10),
        drive(launch, rx, Duration::from_millis(80)),
    )
    .await
    .unwrap()
    .unwrap();
    let rows = records(&path);
    assert_eq!(rows.iter().filter(|r| r["argv"].is_array()).count(), 1);
    assert_eq!(rows.last().unwrap()["content"], "二");
    let pid = rows[0]["pid"].as_i64().unwrap() as i32;
    timeout(Duration::from_secs(3), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn 取消挂起轮次后按会话恢复() {
    let (mut launch, path) = fixture("cancel");
    let mut child = Process::start(&launch, None).unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(resident::user_line("一").as_bytes())
        .await
        .unwrap();
    assert_eq!(
        child.read_turn(&mut launch, false).await.unwrap().unwrap()["result"]["status"],
        "SUCCESS"
    );
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(resident::user_line("等待取消").as_bytes())
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while !records(&path).iter().any(|r| r["content"] == "等待取消") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    child.child.kill().await.unwrap();
    let mut next = Process::start(&launch, None).unwrap();
    next.stdin
        .as_mut()
        .unwrap()
        .write_all(resident::user_line("无输出崩溃").as_bytes())
        .await
        .unwrap();
    assert_eq!(
        next.read_turn(&mut launch, true).await.unwrap().unwrap()["result"]["status"],
        "ERROR"
    );
    let mut resumed = Process::start(&launch, Some("三")).unwrap();
    assert_eq!(
        resumed.read_turn(&mut launch, true).await.unwrap().unwrap()["result"]["status"],
        "SUCCESS"
    );
    let rows = records(&path);
    let args = rows
        .iter()
        .rev()
        .find_map(|r| r["argv"].as_array())
        .unwrap();
    assert!(args
        .windows(2)
        .any(|p| p[0] == "--conversation" && p[1] == "模拟会话"));
    fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn 旧版帮助回退后只在命令行投递一次() {
    let (mut launch, path) = fixture("fallback");
    let old = path.with_extension("old.cjs");
    fs::copy(&launch.bin, &old).unwrap();
    launch.bin = old.to_string_lossy().into_owned();
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send("旧版本".into()).unwrap();
    drive(launch, rx, Duration::from_secs(2)).await.unwrap();
    let logs = records(&path);
    assert_eq!(logs.iter().filter(|r| r["content"] == "旧版本").count(), 1);
    assert!(logs[0]["argv"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "-p"));
    fs::remove_file(old).unwrap();
    fs::remove_file(path).unwrap();
}
