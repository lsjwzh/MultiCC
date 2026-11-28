//! 一个桥对应一个 MultiCC 会话。宿主管道关闭（包括 Node 被强杀）会打断
//! 整个驱动循环，包括能力探测、阻塞的投递和没有任何输出的在途回合。
use multicc_core::agy_stream::{effort, resident};
use serde_json::{json, Value};
use std::{io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};
mod guard;

fn error(message: &str) -> Value {
    json!({"event":"result","result":{"status":"ERROR","error":message,"finished_reason":"error"}})
}

struct Launch {
    bin: String,
    args: Vec<String>,
    conversation: Option<String>,
    remote: bool,
    egress: bool,
}

impl Launch {
    fn command(&self) -> io::Result<Command> {
        if self.remote || self.egress {
            let mut cmd = Command::new(std::env::current_exe()?);
            if self.remote {
                cmd.arg("agy-remote-bridge")
                    .arg("--local-cwd")
                    .arg(std::env::current_dir()?);
            } else {
                cmd.args(["agy-egress-exec", "--bin", &self.bin]);
            }
            cmd.arg("--");
            Ok(cmd)
        } else {
            Ok(Command::new(&self.bin))
        }
    }

    async fn supports_stream(&self) -> bool {
        if self.remote || std::env::var("MULTICC_AGY_RESIDENT").as_deref() == Ok("0") {
            return false;
        }
        // 帮助不登录，也不提交 prompt。探测失败时还没有执行用户操作。
        let probe = Command::new(&self.bin)
            .args([
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--help",
            ])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let Ok(Ok(output)) = timeout(Duration::from_secs(4), probe).await else {
            return false;
        };
        output.status.success()
            && [output.stdout, output.stderr]
                .iter()
                .any(|bytes| resident::advertises_input(&String::from_utf8_lossy(bytes)))
    }
}

struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<(bool, String)>,
}

async fn collect(stream: impl AsyncRead + Unpin, stderr: bool, tx: mpsc::Sender<(bool, String)>) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tx.send((stderr, line)).await.is_err() {
            break;
        }
    }
}

impl Process {
    fn start(launch: &Launch, prompt: Option<&str>) -> io::Result<Self> {
        let mut cmd = launch.command()?;
        cmd.args(&launch.args);
        if let Some(id) = &launch.conversation {
            cmd.args(["--conversation", id]);
        }
        if let Some(text) = prompt {
            cmd.args(["-p", text]).stdin(Stdio::null());
        } else {
            cmd.args(["--input-format", "stream-json"])
                .stdin(Stdio::piped());
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let (tx, lines) = mpsc::channel(32);
        tokio::spawn(collect(child.stdout.take().unwrap(), false, tx.clone()));
        tokio::spawn(collect(child.stderr.take().unwrap(), true, tx));
        Ok(Self {
            stdin: child.stdin.take(),
            child,
            lines,
        })
    }

    async fn read_turn(&mut self, launch: &mut Launch, resumed: bool) -> io::Result<Option<Value>> {
        let mut diagnostic = String::new();
        let mut rejection = None;
        let mut result = None;
        let mut input_flag_rejected = false;
        let mut observed = false;
        while let Some((stderr, line)) = self.lines.recv().await {
            if stderr {
                eprintln!("{line}");
            }
            if stderr || !line.trim_start().starts_with('{') {
                if input_option_rejected(&line) {
                    input_flag_rejected = true;
                } else if effort::unsupported(&line) {
                    rejection = Some(line.clone());
                } else if !stderr
                    && !line.trim().is_empty()
                    && line.trim() != "Fetching available models..."
                {
                    observed = true;
                    println!("{}", json!({"event":"multicc_plain_output"}));
                }
                if !line.trim().is_empty() {
                    diagnostic = line.chars().take(2048).collect();
                }
                continue;
            }
            observed = true;
            let Ok(mut evt) = serde_json::from_str::<Value>(&line) else {
                println!("{}", json!({"event":"multicc_plain_output"}));
                continue;
            };
            let kind = evt["event"].as_str().unwrap_or("");
            if matches!(kind, "init" | "result") {
                let id = [
                    evt["conversation_id"].as_str(),
                    evt[kind]["conversation_id"].as_str(),
                ]
                .into_iter()
                .flatten()
                .find(|v| !v.is_empty());
                if let Some(id) = id {
                    if launch
                        .conversation
                        .as_deref()
                        .is_some_and(|expected| expected != id)
                    {
                        return Ok(Some(error("agy 返回的会话 ID 与请求不一致，已终止进程")));
                    }
                    if launch.conversation.is_none()
                        && kind == "result"
                        && evt["result"]["status"] == "SUCCESS"
                    {
                        println!(
                            "{}",
                            json!({"event":"multicc_conversation","conversation_id":id})
                        );
                    }
                    launch.conversation = Some(id.to_owned());
                }
            }
            if kind == "result" {
                // 第二轮没有 step usage 时，累计的 result.usage 也不能填入本轮。
                if resumed {
                    if let Some(r) = evt["result"].as_object_mut() {
                        r.remove("usage");
                    }
                }
                if self.stdin.is_some() {
                    return Ok(Some(evt));
                }
                result = Some(evt);
            } else {
                println!("{evt}");
            }
        }
        let status = self.child.wait().await?;
        if self.stdin.is_some() && !status.success() && input_flag_rejected && !observed {
            // 只有解析器明确拒绝启动开关且两个输出流已排空，才能安全重投。
            return Ok(None);
        }
        Ok(Some(result.unwrap_or_else(|| {
            error(
                &rejection
                    .unwrap_or_else(|| format!("agy 在 result 前退出（{status}） {diagnostic}")),
            )
        })))
    }
}

fn input_option_rejected(line: &str) -> bool {
    let diagnostic = line.trim().to_ascii_lowercase();
    [
        "unknown flag:",
        "unknown option:",
        "flag provided but not defined:",
        "unrecognized option",
    ]
    .iter()
    .any(|prefix| {
        diagnostic.strip_prefix(prefix).is_some_and(|flag| {
            flag.trim()
                .trim_matches(['\'', '"'])
                .trim_start_matches('-')
                == "input-format"
        })
    })
}

async fn drive(
    mut launch: Launch,
    mut incoming: mpsc::UnboundedReceiver<String>,
    idle: Duration,
) -> io::Result<()> {
    let Some(mut text) = incoming.recv().await else {
        return Ok(());
    };
    // 进程的启动模式在投递前决定。一次性及失败的物理进程连同 MCP 一起回收。
    let mut warm = !text.trim_start().starts_with('/') && launch.supports_stream().await;
    let mut p = Process::start(&launch, (!warm).then_some(text.as_str()))?;
    let mut resumed = launch.conversation.is_some();
    let mut first_submission = true;
    loop {
        if let Some(stdin) = &mut p.stdin {
            if let Err(err) = stdin.write_all(resident::user_line(&text).as_bytes()).await {
                if err.kind() != io::ErrorKind::BrokenPipe {
                    return Err(err);
                }
                // 子进程可能在读取任何输入前就拒绝了启动开关，仍须排空诊断。
            }
        }
        let mut result = match p.read_turn(&mut launch, resumed).await? {
            Some(result) => result,
            None if first_submission => {
                warm = false;
                p = Process::start(&launch, Some(&text))?;
                p.read_turn(&mut launch, resumed)
                    .await?
                    .ok_or_else(|| io::Error::other("agy 未返回本轮结果"))?
            }
            None => error("已运行的 agy 不再接受流输入"),
        };
        first_submission = false;
        if !warm || result["result"]["status"] != "SUCCESS" {
            result["multicc_retire"] = Value::Bool(true);
            println!("{result}");
            break;
        }
        println!("{result}");
        resumed = true;
        tokio::select! {
            _ = p.child.wait() => break,
            next = timeout(idle, incoming.recv()) => match next {
                Ok(Some(message)) => text = message,
                _ => break,
            },
        }
    }
    Ok(())
}

async fn listen(tx: mpsc::UnboundedSender<String>, eof: oneshot::Sender<()>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        let Some(text) = v["text"].as_str() else {
            break;
        };
        if tx.send(text.to_string()).is_err() {
            break;
        }
    }
    let _ = eof.send(());
}

pub async fn serve(args: &[String]) -> i32 {
    let Some((bin, args)) = args.split_first() else {
        return 2;
    };
    let _guard = match guard::install() {
        Ok(v) => v,
        Err(err) => {
            eprintln!("agy 宿主监护初始化失败：{err}");
            return 1;
        }
    };
    let launch = Launch {
        bin: bin.clone(),
        args: resident::base_args(args),
        conversation: effort::flag_value(args, "--conversation").map(String::from),
        remote: std::env::var_os("MULTICC_AGY_REMOTE_ACCOUNT_JSON").is_some_and(|v| !v.is_empty()),
        egress: std::env::var_os("MULTICC_AGY_EGRESS_JSON").is_some_and(|v| !v.is_empty()),
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let (eof, closed) = oneshot::channel();
    tokio::spawn(listen(tx, eof));
    tokio::select! {
        biased;
        _ = closed => 0,
        result = drive(launch, rx, Duration::from_secs(600)) => match result {
            Ok(()) => 0,
            Err(err) => {
                println!("{}", error(&format!("agy 进程通信失败：{err}")));
                1
            }
        },
    }
}

#[cfg(unix)]
pub use guard::watch;

#[cfg(all(test, unix))]
mod tests;
