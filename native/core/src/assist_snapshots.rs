//! Retention of the human-assist directory. Each top-level directory is a
//! session. Its immediate children expire individually, including nested trees.
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::sync::oneshot;

const RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
const PERIOD: Duration = Duration::from_secs(6 * 3600);

fn expired(metadata: &cap_std::fs::Metadata, cutoff: SystemTime) -> bool {
    metadata
        .modified()
        .is_ok_and(|time| time.into_std() < cutoff)
}

fn sweep_session(session: &Dir, cutoff: SystemTime) -> usize {
    let Ok(entries) = session.entries() else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Ok(metadata) = session.symlink_metadata(&name) else {
            continue;
        };
        if expired(&metadata, cutoff) {
            let result = if metadata.is_dir() {
                session.remove_dir_all(&name)
            } else {
                session.remove_file_or_symlink(&name)
            };
            if result.is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

pub fn validate_root(root: &Path) -> io::Result<()> {
    if root.is_absolute() && root.file_name().is_some() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "assist sweep requires a bounded absolute directory",
        ))
    }
}

fn sweep(root: &Path, cutoff: SystemTime) -> io::Result<usize> {
    validate_root(root)?;
    // Never traverse a link at either level. Relative operations stay anchored
    // to open directory handles even when another process replaces a pathname.
    let parent = Dir::open_ambient_dir(root.parent().unwrap(), ambient_authority())?;
    let root = parent.open_dir_nofollow(root.file_name().unwrap())?;
    let mut removed = 0;
    for entry in root.entries()?.flatten() {
        let name = entry.file_name();
        let Ok(metadata) = root.symlink_metadata(&name) else {
            continue;
        };
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if let Ok(session) = root.open_dir_nofollow(&name) {
                removed += sweep_session(&session, cutoff);
                // rmdir itself checks emptiness, including files added while scanning.
                drop(session);
                let _ = root.remove_dir(&name);
            }
        } else if expired(&metadata, cutoff) && root.remove_file(&name).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Run once at startup and every six hours thereafter. Stop waits for an
/// in-flight pass; no two passes of this worker can overlap.
pub async fn run(root: PathBuf, stop: oneshot::Receiver<()>) {
    run_periodic(root, stop, PERIOD).await;
}

async fn run_periodic(root: PathBuf, mut stop: oneshot::Receiver<()>, period: Duration) {
    let mut ticks = tokio::time::interval(period);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            _ = ticks.tick() => {}
        }
        let root = root.clone();
        let result =
            tokio::task::spawn_blocking(move || sweep(&root, SystemTime::now() - RETENTION)).await;
        if let Ok(Ok(count)) = result {
            if count > 0 {
                use std::io::Write;
                let _ = writeln!(
                    io::stderr(),
                    "[multicc/assist] cleaned up {count} expired assist screenshot(s)"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::time::UNIX_EPOCH;

    #[test]
    fn refuses_unbounded_roots() {
        assert!(validate_root(Path::new("relative/dir")).is_err());
        let absolute = std::env::current_dir().unwrap();
        assert!(validate_root(absolute.ancestors().last().unwrap()).is_err());
    }

    #[tokio::test]
    async fn cutoff_is_exclusive_and_a_later_tick_cleans_newly_expired_files() {
        let now = SystemTime::now();
        let root = std::env::temp_dir().join(format!(
            "multicc-assist-{}-{}",
            std::process::id(),
            now.duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let cutoff = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let path = root.join("frame");
        File::create(&path).unwrap().set_modified(cutoff).unwrap();
        assert_eq!(sweep(&root, cutoff).unwrap(), 0);
        assert_eq!(sweep(&root, cutoff + Duration::from_millis(1)).unwrap(), 1);
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(run_periodic(
            root.clone(),
            stopped,
            Duration::from_millis(15),
        ));
        // Each file is created after the previous pass has removed its predecessor.
        for _ in 0..2 {
            File::create(&path)
                .unwrap()
                .set_modified(now - RETENTION - Duration::from_secs(1))
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while path.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
        }
        stop.send(()).unwrap();
        task.await.unwrap();
        fs::remove_dir(root).unwrap();
    }
}
