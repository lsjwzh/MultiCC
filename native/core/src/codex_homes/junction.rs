//! Windows mount-point reparse buffer. A junction, unlike a symbolic link,
//! needs no developer mode or elevated symlink privilege.
use std::{
    ffi::c_void,
    fs, io,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA0000003;
const FSCTL_SET_REPARSE_POINT: u32 = 0x900A4;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
#[link(name = "kernel32")]
extern "system" {
    fn DeviceIoControl(
        handle: *mut c_void,
        control: u32,
        input: *const c_void,
        input_size: u32,
        output: *mut c_void,
        output_size: u32,
        returned: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}
pub(super) fn create(target: &Path, link: &Path) -> io::Result<()> {
    let display: Vec<u16> = target.as_os_str().encode_wide().collect();
    let extended: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc: Vec<u16> = r"\\".encode_utf16().collect();
    let mut substitute: Vec<u16> = r"\??\".encode_utf16().collect();
    if let Some(t) = display.strip_prefix(extended.as_slice()) {
        substitute.extend_from_slice(t)
    } else if let Some(t) = display.strip_prefix(unc.as_slice()) {
        substitute.extend("UNC\\".encode_utf16());
        substitute.extend_from_slice(t)
    } else {
        substitute.extend_from_slice(&display)
    }
    let data_size = 8 + (substitute.len() + 1 + display.len() + 1) * 2;
    if data_size + 8 > 16 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "junction target is too long",
        ));
    }
    let mut data = Vec::with_capacity(data_size + 8);
    data.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    for n in [
        data_size,
        0,
        0,
        substitute.len() * 2,
        (substitute.len() + 1) * 2,
        display.len() * 2,
    ] {
        data.extend_from_slice(&(n as u16).to_le_bytes())
    }
    for unit in substitute.into_iter().chain([0]).chain(display).chain([0]) {
        data.extend_from_slice(&unit.to_le_bytes())
    }
    fs::create_dir(link)?;
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(link)?;
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                data.as_ptr().cast(),
                data.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir(link);
    }
    result
}
