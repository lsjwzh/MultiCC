//! Shared request validation and control ownership. OS calls live in the Windows adapter.
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const MAX_LINE: usize = 64 * 1024;
pub const IDLE: Duration = Duration::from_secs(120);
// Clients refresh a held gesture every 3 seconds; do not release between heartbeats.
pub const POINTER_IDLE: Duration = Duration::from_secs(10);

pub fn failure(reason: &str) -> Value {
    json!({"ok":false,"error":reason,"reason":reason})
}

pub fn partial(reason: &str, sent: usize) -> Value {
    let mut r = failure(reason);
    r["outcome"] = json!("partial");
    r["dispatched"] = json!(if sent == 0 { "none" } else { "dispatched" });
    r["retrySafe"] = json!(sent == 0);
    r["sent"] = json!(sent);
    r
}

pub fn session(req: &Value) -> Result<&str, &'static str> {
    req["session"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128 && !s.contains('\0'))
        .ok_or("session-required")
}

pub fn number(
    req: &Value,
    key: &str,
    default: Option<f64>,
    min: f64,
    max: f64,
) -> Result<f64, &'static str> {
    let n = if req.get(key).is_none() {
        default
    } else {
        req[key].as_f64()
    };
    n.filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or("bad-arguments")
}

pub fn modifiers(req: &Value) -> Vec<&'static str> {
    ["shift", "ctrl", "alt", "cmd"]
        .into_iter()
        .filter(|name| {
            req["mods"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(name)))
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub enum Input {
    Move(i32, i32),
    Click(i32, i32, u8, usize),
    Scroll(i32, i32, i32, i32),
    Drag(i32, i32, i32, i32, u64),
    Pointer(i32, i32, bool, String),
    Type(String),
    Press(Vec<u16>),
}

pub fn key(name: &str) -> Option<u16> {
    Some(match name.to_ascii_lowercase().as_str() {
        "shift" => 0x10,
        "ctrl" | "control" => 0x11,
        "alt" | "option" => 0x12,
        "cmd" | "win" | "super" | "meta" => 0x5b,
        "delete" | "backspace" => 8,
        "forwarddelete" => 0x2e,
        "tab" => 9,
        "return" | "enter" => 13,
        "escape" | "esc" => 27,
        "space" => 32,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "page_up" => 0x21,
        "pagedown" | "page_down" => 0x22,
        "insert" => 0x2d,
        n if n.len() == 1 && n.as_bytes()[0].is_ascii_alphanumeric() => {
            n.as_bytes()[0].to_ascii_uppercase() as u16
        }
        n if n.starts_with('f') => {
            let f: u16 = n[1..].parse().ok()?;
            if !(1..=24).contains(&f) {
                return None;
            }
            0x6f + f
        }
        _ => return None,
    })
}

pub fn parse_input(req: &Value, width: i32, height: i32) -> Result<Input, &'static str> {
    let xy = |a, b| -> Result<(i32, i32), &'static str> {
        Ok((
            number(req, a, None, 0., (width - 1) as f64)?.round() as i32,
            number(req, b, None, 0., (height - 1) as f64)?.round() as i32,
        ))
    };
    Ok(match req["op"].as_str().unwrap_or("") {
        "move" => {
            let (x, y) = xy("x", "y")?;
            Input::Move(x, y)
        }
        "click" => {
            let (x, y) = xy("x", "y")?;
            let button = match req["button"].as_str().unwrap_or("left") {
                "left" => 1,
                "middle" => 2,
                "right" => 3,
                _ => return Err("bad-arguments"),
            };
            Input::Click(
                x,
                y,
                button,
                number(req, "count", Some(1.), 1., 3.)? as usize,
            )
        }
        "scroll" => {
            let (x, y) = xy("x", "y")?;
            Input::Scroll(
                x,
                y,
                number(req, "amount", Some(0.), -50., 50.)? as i32,
                number(req, "amountX", Some(0.), -50., 50.)? as i32,
            )
        }
        "drag" => {
            let (x, y) = xy("x", "y")?;
            let (x2, y2) = xy("x2", "y2")?;
            Input::Drag(
                x,
                y,
                x2,
                y2,
                number(req, "ms", Some(300.), 80., 3000.)? as u64,
            )
        }
        "pointer" => {
            let (x, y) = xy("x", "y")?;
            let mask = req["mask"]
                .as_u64()
                .filter(|m| *m <= 1)
                .ok_or("bad-arguments")?;
            let viewer = req["viewer"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or("bad-arguments")?;
            Input::Pointer(x, y, mask == 1, viewer.into())
        }
        "type" => {
            let s = req["text"]
                .as_str()
                .filter(|s| s.chars().count() <= 4000 && !s.contains('\0'))
                .ok_or("bad-arguments")?;
            Input::Type(s.into())
        }
        "press" => {
            let s = req["keys"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 40)
                .ok_or("bad-arguments")?;
            let mut keys = Vec::new();
            for name in modifiers(req).into_iter().chain(s.split('+')) {
                let k = key(name).ok_or("bad-arguments")?;
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
            Input::Press(keys)
        }
        _ => return Err("unknown-op"),
    })
}

/// A generation makes release/resume irrevocable for an already-running request,
/// even when another request immediately reacquires the same session name.
#[derive(Default)]
pub struct Control {
    holder: Option<String>,
    until: Option<Instant>,
    pub halted: bool,
    generation: u64,
}

impl Control {
    pub fn holder(&self, now: Instant) -> Option<&str> {
        self.holder
            .as_deref()
            .filter(|_| self.until.is_some_and(|end| now < end))
    }
    pub fn acquire(
        &mut self,
        owner: &str,
        now: Instant,
        duration: Duration,
    ) -> Result<u64, &'static str> {
        if self.halted {
            return Err("user-stopped");
        }
        if self.holder(now).is_some_and(|s| s != owner) {
            return Err("busy");
        }
        if self.holder(now).is_none() {
            self.generation = self.generation.wrapping_add(1);
        }
        self.holder = Some(owner.into());
        self.until = Some(now + duration);
        Ok(self.generation)
    }
    pub fn check(
        &mut self,
        owner: &str,
        generation: u64,
        now: Instant,
    ) -> Result<(), &'static str> {
        if self.halted {
            return Err("user-stopped");
        }
        if generation != self.generation || self.holder(now) != Some(owner) {
            return Err("interrupted");
        }
        self.until = Some(now + IDLE);
        Ok(())
    }
    pub fn release(&mut self, owner: &str) {
        if self.holder.as_deref() == Some(owner) {
            self.invalidate();
        }
    }
    fn invalidate(&mut self) {
        self.holder = None;
        self.until = None;
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn stop(&mut self, now: Instant) {
        if self.holder(now).is_some() {
            self.halted = true;
            self.invalidate();
        }
    }
    pub fn resume(&mut self) {
        self.halted = false;
        self.invalidate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_reacquire_never_revives_old_input() {
        let mut c = Control::default();
        let t = Instant::now();
        let g = c.acquire("a", t, IDLE).unwrap();
        c.release("a");
        c.acquire("a", t, IDLE).unwrap();
        assert_eq!(c.check("a", g, t), Err("interrupted"));
    }
    #[test]
    fn stop_requires_explicit_resume_and_keeps_old_work_cancelled() {
        let mut c = Control::default();
        let t = Instant::now();
        c.stop(t);
        assert!(!c.halted);
        let g = c.acquire("a", t, IDLE).unwrap();
        c.stop(t);
        assert_eq!(c.check("a", g, t), Err("user-stopped"));
        assert_eq!(c.acquire("b", t, IDLE), Err("user-stopped"));
        c.resume();
        c.acquire("a", t, IDLE).unwrap();
        assert_eq!(c.check("a", g, t), Err("interrupted"));
    }
    #[test]
    fn ownership_and_expiry() {
        let mut c = Control::default();
        let t = Instant::now();
        let g = c.acquire("a", t, IDLE).unwrap();
        c.release("b");
        assert_eq!(c.acquire("b", t, IDLE), Err("busy"));
        assert_eq!(c.check("a", g, t + IDLE), Err("interrupted"));
        assert!(c.acquire("b", t + IDLE, IDLE).is_ok());
    }
    #[test]
    fn validates_input_before_any_injection() {
        for req in [
            json!({"op":"click","x":999,"y":5}),
            json!({"op":"type","text":"a\u{0}b"}),
            json!({"op":"press","keys":"ctrl+unknown"}),
            json!({"op":"pointer","x":0,"y":0,"mask":2,"viewer":"v"}),
            json!({"op":"scroll","x":0,"y":0,"amount":1e30}),
        ] {
            assert!(parse_input(&req, 800, 600).is_err(), "{req}");
        }
        assert_eq!(key("delete"), Some(8));
        assert_eq!(key("forwarddelete"), Some(46));
        assert_eq!(
            parse_input(
                &json!({"op":"press","keys":"ctrl+c","mods":["ctrl","shift","bad"]}),
                800,
                600
            ),
            Ok(Input::Press(vec![16, 17, 67]))
        );
        assert!(parse_input(&json!({"op":"type","text":"中文🙂"}), 800, 600).is_ok());
        assert_eq!(partial("interrupted", 1)["retrySafe"], false);
    }
}
