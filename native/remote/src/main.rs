//! multicc-remote：远控服务端进程（docs/remote-screen-process.md）。
//!
//! 生命周期由 Node 完全掌握：stdin 第一行是配置，**stdin 读到 EOF 就退出**
//! （1 秒内），所以 Node 退出或崩溃都不会留下孤儿进程。就绪行只打印一次，
//! 日志一律走 stderr —— stdout 是控制通道，混进别的字节 Node 就读不懂了。

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use multicc_remote::agent::{self, AgentClient, UnixAgentClient};
use multicc_remote::config;
use multicc_remote::host::{self, Host};
use multicc_remote::routes::{self, AppState};
use multicc_remote::stats;

fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        // 构建脚本用这一行确认二进制能跑；`1` 是协议版本，不是 crate 版本。
        println!("{}", config::version_line());
        return;
    }
    let config = match read_config() {
        Some(config) => config,
        None => std::process::exit(2),
    };
    // stdin 之后保持打开：读到 EOF 说明 Node 没了，立刻退出。
    watch_stdin();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("multicc-remote: runtime: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(serve(config)) {
        eprintln!("multicc-remote: {error}");
        std::process::exit(1);
    }
}

fn read_config() -> Option<config::Config> {
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) => {
            eprintln!("multicc-remote: stdin closed before config");
            None
        }
        Ok(_) => match config::parse_config_line(line.trim_end()) {
            Ok(config) => Some(config),
            Err(error) => {
                eprintln!("multicc-remote: {}", error.message);
                None
            }
        },
        Err(error) => {
            eprintln!("multicc-remote: stdin: {error}");
            None
        }
    }
}

/// 第一行之后继续读：Node 关掉管道（或崩溃）时这里的 read 返回 0。
fn watch_stdin() {
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(_) => {}
            }
        }
    });
}

async fn serve(config: config::Config) -> std::io::Result<()> {
    // 平台画像由进程自己按编译目标与环境推导；Agent socket 也从画像来。
    let env = host::process_env();
    let profile = host::profile_for(&host::target_platform(), &host::home_dir(&env), &env);
    let agent: Arc<dyn AgentClient> =
        Arc::new(UnixAgentClient::new(profile.agent_sock.as_ref().map(PathBuf::from)));
    let host = Arc::new(Host::new(profile, host::default_exec(), Some(agent::host_call(agent.clone()))));
    let secret = config::random_secret();
    let state = AppState::new(config.dir, host, agent, secret.clone());
    if let Some(path) = stats::stats_file_from_env() {
        tokio::spawn(stats::run_writer(state.stats.clone(), path));
    }
    // 只监听回环，端口由系统分配：Node 从就绪行读端口。
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    println!("{}", config::ready_line(port, &secret));
    std::io::stdout().flush().ok();
    axum::serve(listener, routes::router(state)).await
}
