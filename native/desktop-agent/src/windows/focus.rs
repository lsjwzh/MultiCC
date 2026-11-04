//! UI Automation covers password controls that do not expose a Win32 ES_PASSWORD style.
use windows::Win32::{System::Com::*, UI::Accessibility::*};

pub(super) struct FocusGuard {
    automation: Option<IUIAutomation>,
}

impl FocusGuard {
    pub fn new() -> Result<Self, &'static str> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|_| "protected-app")?;
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(automation) => Ok(Self {
                    automation: Some(automation),
                }),
                Err(_) => {
                    CoUninitialize();
                    Err("protected-app")
                }
            }
        }
    }
    pub fn check(&self) -> Result<(), &'static str> {
        unsafe {
            let element = self
                .automation
                .as_ref()
                .unwrap()
                .GetFocusedElement()
                .map_err(|_| "protected-app")?;
            let password = element.CurrentIsPassword().map_err(|_| "protected-app")?;
            if password.as_bool() {
                Err("protected-app")
            } else {
                Ok(())
            }
        }
    }
}

impl Drop for FocusGuard {
    fn drop(&mut self) {
        drop(self.automation.take());
        unsafe {
            CoUninitialize();
        }
    }
}
