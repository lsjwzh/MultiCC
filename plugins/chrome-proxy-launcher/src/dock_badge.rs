//! macOS Dock identity icons. APFS clones preserve Chrome's signed bundle and
//! share unchanged file blocks. Finder custom icons live outside signed resources.
use crate::store::Profile;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn appearance(profile: &Profile) -> Value {
    let label: String = profile
        .name
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .take(2)
        .collect();
    let hash = profile
        .id
        .bytes()
        .fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619));
    let colors = [
        "#2563eb", "#7c3aed", "#0f766e", "#b45309", "#be185d", "#4338ca",
    ];
    json!({"label": if label.is_empty() { "隔离" } else { &label }, "color": colors[hash as usize % colors.len()]})
}

/// Derived application bundles can be reclaimed without touching login data.
pub fn clear_cache(id: &str) {
    let _ = std::fs::remove_dir_all(crate::store::data_dir().join("dock-apps").join(id));
}

pub fn prepare(profile: &Profile, browser: &Path) -> (PathBuf, Value) {
    let mut badge = appearance(profile);
    #[cfg(target_os = "macos")]
    let prepared = macos::prepare(profile, browser, &badge);
    #[cfg(not(target_os = "macos"))]
    let prepared: Result<PathBuf, String> = Err("当前平台尚不支持运行栏身份角标".into());
    match prepared {
        Ok(path) => {
            badge["status"] = json!("applied");
            badge["appPath"] = json!(path.parent().unwrap().parent().unwrap().parent().unwrap());
            (path, badge)
        }
        Err(error) => {
            badge["status"] = json!("unavailable");
            badge["reason"] = json!(error);
            (browser.to_path_buf(), badge)
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        fs,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    // Only this adapter calls Cocoa. Paths/text are argv values, never script source.
    const ICON_SCRIPT: &str = include_str!("dock_badge_macos.js");

    fn run(command: &mut Command, timeout: Duration) -> Result<(), String> {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("角标工具启动失败：{e}"))?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err("角标准备失败（需要 APFS 克隆和 macOS 图标接口）".into())
                    }
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("角标准备超时，已使用原浏览器图标".into());
                }
            }
        }
    }

    pub(super) fn prepare(
        profile: &Profile,
        browser: &Path,
        badge: &Value,
    ) -> Result<PathBuf, String> {
        // Scripts/custom executables stay on their original launch path.
        let browser = browser.canonicalize().map_err(|e| e.to_string())?;
        let contents = browser
            .parent()
            .filter(|p| p.file_name().is_some_and(|n| n == "MacOS"))
            .and_then(Path::parent)
            .filter(|p| p.file_name().is_some_and(|n| n == "Contents"))
            .ok_or("自定义浏览器不是 macOS 应用包，未添加角标")?;
        let source = contents
            .parent()
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("浏览器不是 macOS 应用包，未添加角标")?;
        prepare_in(
            &browser,
            contents,
            source,
            badge,
            &crate::store::data_dir().join("dock-apps").join(&profile.id),
        )
    }

    fn prepare_in(
        browser: &Path,
        contents: &Path,
        source: &Path,
        badge: &Value,
        root: &Path,
    ) -> Result<PathBuf, String> {
        // Cache follows executable/plist changes (including browser updates) and identity renames.
        let info = contents.join("Info.plist");
        let executable_meta = fs::metadata(&browser).map_err(|e| e.to_string())?;
        let stamp = json!({"schema":1,"source":source,"info":fs::read(&info).map_err(|e| e.to_string())?,
            "modified":format!("{:?}", executable_meta.modified()),"size":executable_meta.len(),"badge":badge});
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let app = root.join("Isolated Chrome.app");
        let stamp_file = root.join("stamp.json");
        let executable = app
            .join("Contents/MacOS")
            .join(browser.file_name().unwrap());
        if executable.is_file()
            && fs::read_to_string(&stamp_file).ok().as_deref() == Some(&stamp.to_string())
        {
            return Ok(executable);
        }
        let pending = root.join("pending.app");
        if pending.exists() {
            fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
        }
        let result = (|| {
            // -c requires copy-on-write cloning; never silently duplicate gigabytes.
            run(
                Command::new("/bin/cp")
                    .arg("-cR")
                    .arg(&source)
                    .arg(&pending),
                Duration::from_secs(3),
            )?;
            run(
                Command::new("/usr/bin/osascript")
                    .args(["-l", "JavaScript", "-e", ICON_SCRIPT])
                    .arg(&source)
                    .arg(&pending)
                    .arg(badge["label"].as_str().unwrap())
                    .arg(badge["color"].as_str().unwrap()),
                Duration::from_secs(2),
            )?;
            if app.exists() {
                fs::remove_dir_all(&app).map_err(|e| e.to_string())?;
            }
            fs::rename(&pending, &app).map_err(|e| e.to_string())?;
            fs::write(&stamp_file, stamp.to_string()).map_err(|e| e.to_string())?;
            Ok(executable)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&pending);
        }
        result
    }

    #[test]
    fn signed_bundle_icon_and_cache_survive_real_browser_launch() {
        let Some(browser) = std::env::var_os("CHROME_TEST_BIN").map(PathBuf::from) else {
            return;
        };
        let browser = browser.canonicalize().unwrap();
        let contents = browser.parent().unwrap().parent().unwrap();
        let source = contents.parent().unwrap();
        let root = std::env::temp_dir().join(format!("multicc-dock-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let p = Profile {
            id: "dock-test".into(),
            name: "美区店铺".into(),
            proxy: None,
            subscription: None,
            note: String::new(),
            chrome_path: None,
            created_at: 0,
            updated_at: 0,
        };
        let badge = appearance(&p);
        let cache = root.join("cache");
        let executable = prepare_in(&browser, contents, source, &badge, &cache).unwrap();
        let modified = fs::metadata(&executable).unwrap().modified().unwrap();
        assert_eq!(
            prepare_in(&browser, contents, source, &badge, &cache).unwrap(),
            executable
        );
        assert_eq!(
            fs::metadata(&executable).unwrap().modified().unwrap(),
            modified
        );
        // Main executable and sealed Info.plist remain byte-identical; no re-signing.
        assert_eq!(fs::read(&browser).unwrap(), fs::read(&executable).unwrap());
        assert_eq!(
            fs::read(contents.join("Info.plist")).unwrap(),
            fs::read(cache.join("Isolated Chrome.app/Contents/Info.plist")).unwrap()
        );
        let mut child = Command::new(&executable)
            .arg(format!(
                "--user-data-dir={}",
                root.join("profile").display()
            ))
            .args([
                "--use-mock-keychain",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--remote-debugging-port=0",
                "about:blank",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        let ready = root.join("profile/DevToolsActivePort");
        while !ready.exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let started = ready.exists();
        let pid = child.id();
        let verify = r#"ObjC.import('AppKit');function run(a){
            var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0]));
            if(app.isNil())throw Error('Browser exited');
            if(ObjC.unwrap(app.bundleURL.path)!==a[1])throw Error('Wrong application bundle');
            var rep=$.NSBitmapImageRep.imageRepWithData(app.icon.TIFFRepresentation);
            rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$.NSDictionary.dictionary).writeToFileAtomically($(a[2]),true);
            var sample=rep.colorAtXY(Math.floor(rep.pixelsWide*0.79),Math.floor(rep.pixelsHigh*0.92)).colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
            // AppKit color conversion and small icon representations blend nearby white pixels.
            var hex=a[3].slice(1);
            if(Math.abs(sample.redComponent-parseInt(hex.slice(0,2),16)/255)>0.18 || Math.abs(sample.greenComponent-parseInt(hex.slice(2,4),16)/255)>0.18 || Math.abs(sample.blueComponent-parseInt(hex.slice(4,6),16)/255)>0.18)throw Error('Badge color missing: '+sample.redComponent+','+sample.greenComponent+','+sample.blueComponent+' vs '+a[3]);
        }"#;
        let verified = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", verify])
            .arg(pid.to_string())
            .arg(cache.join("Isolated Chrome.app"))
            .arg(root.join("runtime-icon.png"))
            .arg(badge["color"].as_str().unwrap())
            .output()
            .unwrap();
        let _ = child.kill(); // This is our disposable test browser, never a user instance.
        let _ = child.wait();
        assert!(started, "Signed Chrome clone did not start");
        assert!(
            verified.status.success(),
            "{}",
            String::from_utf8_lossy(&verified.stderr)
        );
        eprintln!(
            "Verified runtime identity icon: {}",
            root.join("runtime-icon.png").display()
        );
        // Keep only the small preview; remove browser data and cloned bundle.
        fs::remove_dir_all(cache).unwrap();
        fs::remove_dir_all(root.join("profile")).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_handle_unicode_and_colors_follow_identity() {
        let mut p = Profile {
            id: "shop-a".into(),
            name: " 美区店铺 ".into(),
            proxy: None,
            subscription: None,
            note: String::new(),
            chrome_path: None,
            created_at: 0,
            updated_at: 0,
        };
        let first = appearance(&p);
        assert_eq!(first["label"], "美区");
        p.name = "运营 B".into();
        assert_eq!(appearance(&p)["color"], first["color"]);
        assert_eq!(appearance(&p)["label"], "运营");
        p.name = " \n".into();
        assert_eq!(appearance(&p)["label"], "隔离");
    }
}
