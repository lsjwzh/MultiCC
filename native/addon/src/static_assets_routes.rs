//! The one rule `src/routes/static-assets.js` still runs in Node: the
//! cache-busting `?v=<mtime>` rewrite its `serveHtml` export applies. The
//! front door answers every public static path itself
//! (`native/gateway/src/app/static_web_root.rs`); the share page is still an
//! Express render on the share host port, so it calls the same kernel function
//! through here instead of growing a second copy of the regexp and the mtime
//! lookup.
use multicc_core::static_assets_routes::version_html;
use napi_derive::napi;
use std::path::Path;

/// `_serveVersionedHtml`'s document: the file read as UTF-8 with every local
/// `.js`/`.css` reference stamped with `Math.floor(stat.mtimeMs)`. `None` is
/// the retired `fs.readFile` error branch (`res.status(500).end()`); a missing
/// or unreadable *asset* keeps its reference verbatim, like the retired
/// `catch`.
#[napi]
pub fn static_versioned_html(file: String, public_dir: String) -> Option<String> {
    let bytes = std::fs::read(&file).ok()?;
    let html = String::from_utf8_lossy(&bytes);
    let root = Path::new(&public_dir);
    let mtime = |asset: &str| {
        let meta = std::fs::metadata(root.join(asset)).ok()?;
        let elapsed = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        Some(elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1e6)
    };
    Some(version_html(&html, &mtime))
}
