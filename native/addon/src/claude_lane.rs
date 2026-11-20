//! 将原生 Claude 进程事件转交给现有 Node 调用方。
use multicc_core::claude_process::{ClaudeProcess, Event, LaneError};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Result, Status};
use napi_derive::napi;
use serde_json::json;

type LaneEvent =
    ThreadsafeFunction<(String, String, String), (), (String, String, String), Status, false, true>;

fn host_error(error: LaneError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi]
pub struct RustClaudeLane {
    lane: ClaudeProcess,
}

#[napi]
impl RustClaudeLane {
    #[napi(constructor)]
    pub fn new(callback: LaneEvent) -> Self {
        let lane = ClaudeProcess::new(move |event| {
            let (kind, a, b) = match event {
                Event::Message(line) => ("message", line, String::new()),
                Event::Error(error) => ("error", error, String::new()),
                Event::HookCallback { request_id, input } => {
                    ("hook_callback", request_id, input.to_string())
                }
                Event::ControlCancel { request_id } => {
                    ("control_cancel", request_id, String::new())
                }
                Event::Exit {
                    code,
                    signal,
                    stderr_tail,
                } => (
                    "exit",
                    code.map(|value| value.to_string()).unwrap_or_default(),
                    json!({ "signal": signal, "stderrTail": stderr_tail }).to_string(),
                ),
            };
            let _ = callback.call(
                (kind.to_string(), a, b),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        });
        Self { lane }
    }

    #[napi(getter)]
    pub fn pid(&self) -> i32 {
        self.lane.pid()
    }

    #[napi(getter)]
    pub fn alive(&self) -> bool {
        self.lane.alive()
    }

    #[napi]
    pub fn stderr_tail(&self) -> String {
        self.lane.stderr_tail()
    }

    #[napi]
    pub async fn start(&self, config: String) -> Result<String> {
        self.lane.start(&config).await.map_err(host_error)
    }

    #[napi]
    pub async fn send_user(&self, line: String) -> Result<()> {
        self.lane.send_user(line).await.map_err(host_error)
    }

    #[napi]
    pub async fn interrupt(&self) -> Result<()> {
        self.lane.interrupt().await.map_err(host_error)
    }

    #[napi]
    pub async fn set_model(&self, model: Option<String>) -> Result<()> {
        self.lane.set_model(model).await.map_err(host_error)
    }

    #[napi]
    pub async fn get_task_output(&self, task_id: String) -> Result<String> {
        self.lane.get_task_output(task_id).await.map_err(host_error)
    }

    #[napi]
    pub async fn stop_task(&self, task_id: String) -> Result<()> {
        self.lane.stop_task(task_id).await.map_err(host_error)
    }

    #[napi]
    pub fn respond_control(&self, request_id: String, response_json: String) -> Result<()> {
        self.lane
            .respond_control(request_id, response_json)
            .map_err(host_error)
    }

    #[napi]
    pub fn respond_control_error(&self, request_id: String, message: String) -> Result<()> {
        self.lane
            .respond_control_error(request_id, message)
            .map_err(host_error)
    }

    #[napi]
    pub fn close_input(&self) {
        self.lane.close_input();
    }

    #[napi]
    pub fn kill(&self, signal: Option<String>) {
        self.lane.kill(signal);
    }
}
