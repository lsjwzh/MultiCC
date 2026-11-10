//! One Rust owner for the four turn-progress modules with private state:
//! the silent-period heartbeat (`src/chat/progress-heartbeat.js`), the turn
//! timing recorder (`src/chat/turn-timing.js`), the per-turn model timeline
//! (`src/chat/turn-timeline.js`) and the delivery-handoff probe
//! (`src/chat/delivery-probe.js`).
//!
//! The kernels here are pure state machines. Host I/O (the clock, the
//! heartbeat callback, the timing log sink) is supplied by the addon owner
//! `native/addon/src/turn_progress.rs` on every call; no host function is
//! retained. The JavaScript facade `src/chat/turn-progress.js` only forwards
//! arguments and owns the single unref'd timer.
//!
//! Timeline state is keyed by session name (not hung on the live `cs` object)
//! and is cleared by `Timelines::forget` from the chat-session delete path.
pub mod heartbeat;
pub mod probe;
pub mod timeline;
pub mod timing;
