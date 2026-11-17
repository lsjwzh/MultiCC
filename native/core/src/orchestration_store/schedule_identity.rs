//! Fail-closed checks for experimental scheduler SQLite connections.
use super::{err, Result};
#[cfg(unix)]
use rusqlite::ffi;
use rusqlite::Connection;
#[cfg(unix)]
use std::ffi::c_void;
use std::fs::File;
use std::path::Path;

#[cfg(unix)]
pub(super) fn anchor_matches(anchor: &File, path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let original = anchor.metadata().map_err(err)?;
    let current = std::fs::metadata(path).map_err(err)?;
    if !original.is_file()
        || !current.is_file()
        || original.nlink() != 1
        || original.dev() != current.dev()
        || original.ino() != current.ino()
    {
        return Err(err("scheduler background database identity changed"));
    }
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn anchor_matches(_anchor: &File, _path: &Path) -> Result<()> {
    Err(err("scheduler background database identity unavailable"))
}

/// Check SQLite's own file handle, not just the path. The bundled Unix VFS
/// compares the inode of its open descriptor with its current filename.
/// An unsupported VFS must fail closed. This and anchor_matches are separate
/// observations, not an atomic defense against adversarial concurrent renames.
#[cfg(unix)]
pub(super) fn sqlite_matches(connection: &Connection) -> Result<()> {
    let mut moved: std::ffi::c_int = -1;
    // SAFETY: the connection is live, `main` is a terminated schema name,
    // and HAS_MOVED writes exactly one integer to `moved` synchronously.
    let status = unsafe {
        ffi::sqlite3_file_control(
            connection.handle(),
            c"main".as_ptr(),
            ffi::SQLITE_FCNTL_HAS_MOVED,
            (&mut moved as *mut std::ffi::c_int).cast::<c_void>(),
        )
    };
    if status != ffi::SQLITE_OK || moved != 0 {
        return Err(err("scheduler SQLite file identity changed or unavailable"));
    }
    Ok(())
}

/// Reject a valid SQLite connection to a different file as well as a moved
/// connection. `sqlite3_db_filename` identifies the VFS filename; the anchor
/// comparison is still a separate observation and is not an atomic pin.
#[cfg(unix)]
pub(super) fn sqlite_matches_anchor(connection: &Connection, anchor: &File) -> Result<()> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    sqlite_matches(connection)?;
    // SAFETY: the connection is live and SQLite owns the returned string for
    // the connection's lifetime. It is read before any further SQLite call.
    let raw = unsafe { ffi::sqlite3_db_filename(connection.handle(), c"main".as_ptr()) };
    if raw.is_null() {
        return Err(err("scheduler SQLite database filename unavailable"));
    }
    // SAFETY: SQLite documents a NUL-terminated filename for a live database.
    let name = unsafe { CStr::from_ptr(raw) }.to_bytes();
    if name.is_empty() {
        return Err(err("scheduler SQLite database filename unavailable"));
    }
    anchor_matches(anchor, Path::new(OsStr::from_bytes(name)))
}

#[cfg(not(unix))]
pub(super) fn sqlite_matches_anchor(_connection: &Connection, _anchor: &File) -> Result<()> {
    Err(err("scheduler background database identity unavailable"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn sqlite_detects_opening_replacement_even_after_original_path_is_restored() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-scheduler-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let original = dir.join("original.sqlite");
        let replacement = dir.join("replacement.sqlite");
        let parked = dir.join("parked.sqlite");
        Connection::open(&original)
            .unwrap()
            .execute_batch("CREATE TABLE origin(v)")
            .unwrap();
        Connection::open(&replacement)
            .unwrap()
            .execute_batch("CREATE TABLE foreign_db(v)")
            .unwrap();
        let anchor = File::open(&original).unwrap();
        std::fs::rename(&original, &parked).unwrap();
        std::fs::rename(&replacement, &original).unwrap();
        let foreign = Connection::open(&original).unwrap();
        std::fs::rename(&original, &replacement).unwrap();
        std::fs::rename(&parked, &original).unwrap();
        assert!(anchor_matches(&anchor, &original).is_ok());
        assert!(sqlite_matches(&foreign)
            .unwrap_err()
            .contains("identity changed"));
        drop(foreign);
        drop(anchor);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unmoved_connection_to_a_different_database_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-scheduler-other-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let original = dir.join("original.sqlite");
        let other = dir.join("other.sqlite");
        Connection::open(&original)
            .unwrap()
            .execute_batch("CREATE TABLE origin(v)")
            .unwrap();
        let foreign = Connection::open(&other).unwrap();
        foreign.execute_batch("CREATE TABLE other(v)").unwrap();
        let anchor = File::open(&original).unwrap();
        assert!(sqlite_matches(&foreign).is_ok());
        assert!(sqlite_matches_anchor(&foreign, &anchor)
            .unwrap_err()
            .contains("identity changed"));
        drop(foreign);
        drop(anchor);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
