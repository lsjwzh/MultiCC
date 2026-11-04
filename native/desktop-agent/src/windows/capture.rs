use multicc_desktop_agent::{failure, number};
use serde_json::{json, Value};
use std::io::BufWriter;
use std::path::{Component, Path};
use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};

pub(super) fn size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

// Drop order matters: deselect the bitmap before deleting it, then release both DCs.
struct Frame {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
}
impl Drop for Frame {
    fn drop(&mut self) {
        unsafe {
            if !self.old.is_null() {
                SelectObject(self.memory, self.old);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            if !self.screen.is_null() {
                ReleaseDC(std::ptr::null_mut(), self.screen);
            }
        }
    }
}

pub(super) fn snap(req: &Value) -> Value {
    match capture(req) {
        Ok(v) => v,
        Err(e) => failure(e),
    }
}
fn capture(req: &Value) -> Result<Value, &'static str> {
    if !super::desktop_ready() {
        return Err("screen-locked");
    }
    let path = Path::new(req["path"].as_str().ok_or("path-required")?);
    // Refuse device/UNC paths, alternate data streams and traversal.
    let text = path.to_string_lossy();
    if !path.is_absolute()
        || text.starts_with(r"\\")
        || text.get(2..).is_some_and(|s| s.contains(':'))
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err("bad-path");
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg"].contains(&ext.as_str()) {
        return Err("bad-path");
    }
    let (sw, sh) = size();
    if sw <= 0 || sh <= 0 {
        return Err("no-display");
    }
    let (x, y, w, h) = if req.get("crop").is_some_and(|v| !v.is_null()) {
        let c = &req["crop"];
        let x =
            number(c, "x", None, 0., (sw - 1) as f64).map_err(|_| "region-outside-screen")? as i32;
        let y =
            number(c, "y", None, 0., (sh - 1) as f64).map_err(|_| "region-outside-screen")? as i32;
        (
            x,
            y,
            (number(c, "width", None, 1., 100000.)? as i32).min(sw - x),
            (number(c, "height", None, 1., 100000.)? as i32).min(sh - y),
        )
    } else {
        (0, 0, sw, sh)
    };
    if (w as u64) * (h as u64) > 64 * 1024 * 1024 {
        return Err("snap-failed");
    }
    let rgb = unsafe {
        let mut frame = Frame {
            screen: GetDC(std::ptr::null_mut()),
            memory: std::ptr::null_mut(),
            bitmap: std::ptr::null_mut(),
            old: std::ptr::null_mut(),
        };
        if frame.screen.is_null() {
            return Err("no-display");
        }
        frame.memory = CreateCompatibleDC(frame.screen);
        if frame.memory.is_null() {
            return Err("snap-failed");
        }
        frame.bitmap = CreateCompatibleBitmap(frame.screen, w, h);
        if frame.bitmap.is_null() {
            return Err("snap-failed");
        }
        frame.old = SelectObject(frame.memory, frame.bitmap);
        if frame.old.is_null() || frame.old as isize == -1 {
            frame.old = std::ptr::null_mut();
            return Err("snap-failed");
        }
        if BitBlt(
            frame.memory,
            0,
            0,
            w,
            h,
            frame.screen,
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        ) == 0
        {
            return Err("snap-failed");
        }
        SelectObject(frame.memory, frame.old);
        frame.old = std::ptr::null_mut();
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bgra = vec![0u8; w as usize * h as usize * 4];
        if GetDIBits(
            frame.screen,
            frame.bitmap,
            0,
            h as u32,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        ) != h
        {
            return Err("snap-failed");
        }
        let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
        for p in bgra.as_chunks::<4>().0 {
            rgb.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        rgb
    };
    if !super::desktop_ready() {
        return Err("screen-locked");
    }
    let quality = number(req, "quality", Some(60.), 1., 100.)? as u8;
    // Encode into a new sibling, then replace the directory entry atomically.
    // Annotation refresh overwrites an existing PNG; never follow that PNG's links.
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        use std::os::windows::fs::MetadataExt;
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
            return Err("bad-path");
        }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temporary = path.with_file_name(format!(
        ".multicc-snap-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "bad-path")?;
    let mut writer = BufWriter::new(file);
    let encoded = if req["jpeg"] == true || ext != "png" {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality).encode(
            &rgb,
            w as u32,
            h as u32,
            image::ExtendedColorType::Rgb8,
        )
    } else {
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut writer).write_image(
            &rgb,
            w as u32,
            h as u32,
            image::ExtendedColorType::Rgb8,
        )
    };
    use std::io::Write;
    if encoded.is_err() || writer.flush().is_err() {
        drop(writer);
        let _ = std::fs::remove_file(&temporary);
        return Err("snap-failed");
    }
    drop(writer);
    if std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("snap-failed");
    }
    Ok(
        json!({"ok":true,"path":text,"width":sw,"height":sh,"crop":if req.get("crop").is_some_and(|v| !v.is_null()) { json!({"x":x,"y":y,"width":w,"height":h}) } else { Value::Null }}),
    )
}
