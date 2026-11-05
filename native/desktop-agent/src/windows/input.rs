use multicc_desktop_agent::{key, modifiers, Input};
use serde_json::Value;
use std::time::{Duration, Instant};
use windows_sys::Win32::UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*};

pub(super) struct Pointer {
    pub owner: String,
    viewer: String,
    pub at: Instant,
    x: i32,
    y: i32,
}
#[derive(Default)]
pub(super) struct HeldInput {
    keys: Vec<u16>,
    buttons: Vec<u8>,
    pub pointer: Option<Pointer>,
}

fn emit(event: INPUT) -> Result<(), &'static str> {
    if unsafe { SendInput(1, &event, std::mem::size_of::<INPUT>() as i32) } != 1 {
        Err("inject-failed")
    } else {
        Ok(())
    }
}
fn keyboard(vk: u16, scan: u16, flags: u32) -> Result<(), &'static str> {
    let flags = flags
        | if matches!(vk,0x21..=0x28 | 0x2d..=0x2e | 0x5b) {
            KEYEVENTF_EXTENDEDKEY
        } else {
            0
        };
    emit(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}
fn mouse(flags: u32, data: u32, x: i32, y: i32) -> Result<(), &'static str> {
    emit(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}
fn move_to(x: i32, y: i32) -> Result<(), &'static str> {
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w <= 1 || h <= 1 {
            return Err("no-display");
        }
        mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            0,
            (((x - left) as i64 * 65535) / (w - 1) as i64) as i32,
            (((y - top) as i64 * 65535) / (h - 1) as i64) as i32,
        )
    }
}
fn flags(button: u8, down: bool) -> u32 {
    match (button, down) {
        (1, true) => MOUSEEVENTF_LEFTDOWN,
        (1, false) => MOUSEEVENTF_LEFTUP,
        (2, true) => MOUSEEVENTF_MIDDLEDOWN,
        (2, false) => MOUSEEVENTF_MIDDLEUP,
        (3, true) => MOUSEEVENTF_RIGHTDOWN,
        _ => MOUSEEVENTF_RIGHTUP,
    }
}

impl HeldInput {
    pub fn conflicts(&self, action: &Input, owner: &str) -> bool {
        self.pointer.as_ref().is_some_and(|p| !matches!(action,Input::Pointer(_,_,_,viewer) if p.owner==owner && p.viewer==*viewer))
    }
    fn key_down(&mut self, k: u16) -> Result<(), &'static str> {
        if self.keys.contains(&k) {
            return Ok(());
        }
        // Do not release a physical key that was already held by the local user.
        if unsafe { GetAsyncKeyState(k as i32) } < 0 {
            return Err("busy");
        }
        keyboard(k, 0, 0)?;
        self.keys.push(k);
        Ok(())
    }
    fn button_down(&mut self, b: u8) -> Result<(), &'static str> {
        if !self.buttons.contains(&b) {
            mouse(flags(b, true), 0, 0, 0)?;
            self.buttons.push(b);
        }
        Ok(())
    }
    pub fn release(&mut self) {
        for b in self.buttons.drain(..).rev() {
            let _ = mouse(flags(b, false), 0, 0, 0);
        }
        for k in self.keys.drain(..).rev() {
            let _ = keyboard(k, 0, KEYEVENTF_KEYUP);
        }
        self.pointer = None;
    }
    pub fn perform(
        &mut self,
        action: Input,
        req: &Value,
        owner: &str,
        check: &dyn Fn() -> Result<(), &'static str>,
        sent: &mut usize,
    ) -> Result<(), &'static str> {
        check()?;
        if let Some(p) = self.pointer.as_ref() {
            match &action {
                Input::Pointer(_, _, _, v) if p.owner == owner && p.viewer == *v => {}
                _ => return Err("busy"),
            }
        }
        if self.pointer.is_none() && !matches!(action, Input::Type(_) | Input::Press(_)) {
            for name in modifiers(req) {
                check()?;
                self.key_down(key(name).unwrap())?;
                *sent += 1;
            }
        }
        match action {
            Input::Move(x, y) => {
                move_to(x, y)?;
                *sent += 1;
            }
            Input::Click(x, y, b, count) => {
                move_to(x, y)?;
                *sent += 1;
                for _ in 0..count {
                    check()?;
                    self.button_down(b)?;
                    *sent += 1;
                    std::thread::sleep(Duration::from_millis(15));
                    mouse(flags(b, false), 0, 0, 0)?;
                    self.buttons.retain(|n| *n != b);
                    std::thread::sleep(Duration::from_millis(30));
                }
            }
            Input::Scroll(x, y, v, h) => {
                move_to(x, y)?;
                *sent += 1;
                for (amount, flag, sign) in [(v, MOUSEEVENTF_WHEEL, 1), (h, MOUSEEVENTF_HWHEEL, -1)]
                {
                    for _ in 0..amount.unsigned_abs() {
                        check()?;
                        mouse(flag, (amount.signum() * sign * 120) as u32, 0, 0)?;
                        *sent += 1;
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
            Input::Drag(x, y, x2, y2, ms) => {
                move_to(x, y)?;
                *sent += 1;
                check()?;
                self.button_down(1)?;
                let steps = (ms / 10).max(1);
                for i in 1..=steps {
                    check()?;
                    move_to(
                        x + ((x2 - x) as i64 * i as i64 / steps as i64) as i32,
                        y + ((y2 - y) as i64 * i as i64 / steps as i64) as i32,
                    )?;
                    *sent += 1;
                    std::thread::sleep(Duration::from_millis(ms / steps));
                }
            }
            Input::Type(text) => {
                for ch in text.chars() {
                    check()?;
                    if super::sensitive_focus() {
                        return Err("protected-app");
                    }
                    // UTF-16 surrogate pairs are delivered as one uninterrupted character.
                    for unit in ch.encode_utf16(&mut [0; 2]).iter().copied() {
                        keyboard(0, unit, KEYEVENTF_UNICODE)?;
                        *sent += 1;
                        keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)?;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            Input::Press(keys) => {
                for k in keys {
                    check()?;
                    self.key_down(k)?;
                    *sent += 1;
                }
            }
            Input::Pointer(x, y, down, viewer) => {
                if down {
                    if let Some(pointer) = self.pointer.as_mut() {
                        if pointer.x == x && pointer.y == y {
                            pointer.at = Instant::now();
                            return Ok(());
                        }
                    }
                }
                move_to(x, y)?;
                *sent += 1;
                if down {
                    check()?;
                    self.button_down(1)?;
                    self.pointer = Some(Pointer {
                        owner: owner.into(),
                        viewer,
                        at: Instant::now(),
                        x,
                        y,
                    });
                    return Ok(());
                }
            }
        }
        self.release();
        Ok(())
    }
}
impl Drop for HeldInput {
    fn drop(&mut self) {
        self.release();
    }
}
