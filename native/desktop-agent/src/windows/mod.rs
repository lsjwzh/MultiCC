//! Windows runs in the signed-in user's desktop, never as a session-0 service.
mod capture;
mod focus;
mod input;
mod ipc;

use multicc_desktop_agent::{
    failure, number, parse_input, partial, session, Control, Input, IDLE, POINTER_IDLE,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::*,
    System::StationsAndDesktops::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

pub(super) struct State {
    control: Arc<Mutex<Control>>,
    input: Mutex<input::HeldInput>,
    watching: AtomicBool,
}

static STATE: OnceLock<Arc<State>> = OnceLock::new();

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pipe =
        std::env::var("MULTICC_AGENT_PIPE").unwrap_or_else(|_| r"\\.\pipe\multicc-agent".into());
    let runtime = tokio::runtime::Runtime::new()?;
    if args.first().map(String::as_str) != Some("serve") {
        let req = if args.first().map(String::as_str) == Some("--raw") {
            args.get(1).cloned().ok_or("--raw needs a JSON request")?
        } else {
            json!({"op":args.first().map(String::as_str).unwrap_or("status"),"session":"cli"})
                .to_string()
        };
        let reply = runtime.block_on(ipc::client(&pipe, &req))?;
        println!("{reply}");
        if serde_json::from_str::<Value>(&reply)?["ok"] == false {
            return Err("agent refused request".into());
        }
        return Ok(());
    }
    // All coordinates and screenshots use primary-monitor physical pixels, regardless of scaling.
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let state = Arc::new(State {
        control: Arc::new(Mutex::new(Control::default())),
        input: Mutex::new(input::HeldInput::default()),
        watching: AtomicBool::new(false),
    });
    STATE.set(state.clone()).map_err(|_| "already started")?;
    watch(state.clone());
    runtime.block_on(ipc::serve(&pipe, state))?;
    Ok(())
}

/// A locked desktop, UAC secure desktop or inaccessible input desktop is refused.
pub(super) fn desktop_ready() -> bool {
    unsafe {
        let mut session_id = 0;
        if windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
            windows_sys::Win32::System::Threading::GetCurrentProcessId(),
            &mut session_id,
        ) == 0
            || session_id == 0
        {
            return false;
        }
        let d = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if d.is_null() {
            return false;
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok =
            GetUserObjectInformationW(d, UOI_NAME, name.as_mut_ptr().cast(), 512, &mut needed) != 0;
        CloseDesktop(d);
        ok && String::from_utf16_lossy(&name[..name.iter().position(|v| *v == 0).unwrap_or(256)])
            .eq_ignore_ascii_case("default")
    }
}

fn sensitive_focus() -> bool {
    unsafe {
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if GetGUIThreadInfo(0, &mut info) == 0 || info.hwndFocus.is_null() {
            return true;
        }
        let mut class = [0u16; 256];
        let n = GetClassNameW(info.hwndFocus, class.as_mut_ptr(), 256);
        let name = String::from_utf16_lossy(&class[..n.max(0) as usize]).to_ascii_lowercase();
        (name.contains("edit") && GetWindowLongW(info.hwndFocus, GWL_STYLE) & ES_PASSWORD != 0)
            || name.contains("credential")
            || name.contains("password")
    }
}

unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 && (w == WM_KEYDOWN as usize || w == WM_SYSKEYDOWN as usize) {
        let event = &*(l as *const KBDLLHOOKSTRUCT);
        // Injected Escape must not silence the physical Esc emergency stop.
        if event.vkCode == 27 && event.flags & LLKHF_INJECTED == 0 {
            if let Some(state) = STATE.get() {
                state.control.lock().unwrap().stop(Instant::now());
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}

fn watch(state: Arc<State>) {
    let keys = state.clone();
    std::thread::spawn(move || unsafe {
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard),
            windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null()),
            0,
        );
        if hook.is_null() {
            return;
        }
        keys.watching.store(true, Ordering::Release);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        keys.watching.store(false, Ordering::Release);
        UnhookWindowsHookEx(hook);
    });
    // A lost pointer-up, expired lease, local Esc or lock releases only our own held input.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(20));
        if let Ok(mut input) = state.input.try_lock() {
            if let Some(pointer) = input.pointer.as_ref() {
                let now = Instant::now();
                let c = state.control.lock().unwrap();
                if c.halted
                    || c.holder(now) != Some(pointer.owner.as_str())
                    || now.duration_since(pointer.at) > POINTER_IDLE
                    || !desktop_ready()
                {
                    drop(c);
                    input.release();
                }
            }
        }
    });
}

impl State {
    pub(super) fn dispatch(&self, req: Value, cancel: Arc<AtomicBool>) -> Value {
        let op = req["op"].as_str().unwrap_or("");
        if op == "ping" {
            return json!({"ok":true,"pong":true,"version":env!("CARGO_PKG_VERSION")});
        }
        if op == "status" {
            let c = self.control.lock().unwrap();
            let (w, h) = capture::size();
            return json!({"ok":true,"backend":"win32-gdi","screenLocked":!desktop_ready(),"accessibility":self.watching.load(Ordering::Acquire),"screenRecording":desktop_ready(),
                "screen":{"width":w,"height":h},"control":{"halted":c.halted,"leaseHolder":c.holder(Instant::now()),"escWatch":self.watching.load(Ordering::Acquire)}});
        }
        if op == "snap" {
            return capture::snap(&req);
        }
        if op == "unlock" {
            return failure("unlock-unsupported");
        }
        if op == "resume" {
            self.control.lock().unwrap().resume();
            if let Ok(mut input) = self.input.try_lock() {
                input.release();
            }
            return json!({"ok":true});
        }
        if op.is_empty() {
            return failure("op-required");
        }
        if ![
            "release", "lease", "move", "click", "scroll", "drag", "pointer", "type", "press",
        ]
        .contains(&op)
        {
            return failure("unknown-op");
        }
        let owner = match session(&req) {
            Ok(s) => s,
            Err(e) => return failure(e),
        };
        if op == "release" {
            self.control.lock().unwrap().release(owner);
            if let Ok(mut input) = self.input.try_lock() {
                if input.pointer.as_ref().is_some_and(|p| p.owner == owner) {
                    input.release();
                }
            }
            return json!({"ok":true});
        }
        if !self.watching.load(Ordering::Acquire) {
            return failure("no-display");
        }
        if !desktop_ready() {
            return failure("screen-locked");
        }
        if op == "lease" {
            if ["anonymous", "remote-screen"].contains(&owner) {
                return failure("not-allowed");
            }
            let secs = match number(&req, "seconds", Some(120.), 5., 120.) {
                Ok(n) => n,
                Err(e) => return failure(e),
            };
            return match self.control.lock().unwrap().acquire(
                owner,
                Instant::now(),
                Duration::from_secs_f64(secs),
            ) {
                Ok(_) => json!({"ok":true}),
                Err(e) => failure(e),
            };
        }
        if req["allowSystem"] != true {
            return failure("not-allowed");
        }
        let (w, h) = capture::size();
        let action = match parse_input(&req, w, h) {
            Ok(a) => a,
            Err(e) => return failure(e),
        };
        let started = Instant::now();
        let mut held = loop {
            if cancel.load(Ordering::Acquire) {
                return partial("interrupted", 0);
            }
            if let Ok(lock) = self.input.try_lock() {
                break lock;
            }
            if started.elapsed() > Duration::from_secs(3) {
                return failure("busy");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if !desktop_ready() {
            return failure("screen-locked");
        }
        if held.conflicts(&action, owner) {
            return failure("busy");
        }
        if matches!(&action, Input::Type(_) | Input::Press(_)) && sensitive_focus() {
            return failure("protected-app");
        }
        let focus = if matches!(&action, Input::Type(_) | Input::Press(_)) {
            match focus::FocusGuard::new() {
                Ok(f) => Some(f),
                Err(e) => return failure(e),
            }
        } else {
            None
        };
        let generation = match self
            .control
            .lock()
            .unwrap()
            .acquire(owner, Instant::now(), IDLE)
        {
            Ok(g) => g,
            Err(e) => return failure(e),
        };
        let check = || {
            if cancel.load(Ordering::Acquire) {
                return Err("interrupted");
            }
            if !self.watching.load(Ordering::Acquire) {
                return Err("no-display");
            }
            if !desktop_ready() {
                return Err("screen-locked");
            }
            if let Some(focus) = &focus {
                focus.check()?;
            }
            self.control
                .lock()
                .unwrap()
                .check(owner, generation, Instant::now())
        };
        let mut sent = 0;
        match held.perform(action, &req, owner, &check, &mut sent) {
            Ok(()) => json!({"ok":true,"op":op}),
            Err(e) => {
                held.release();
                partial(e, sent)
            }
        }
    }
}
