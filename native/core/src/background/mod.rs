//! Rust owner of the background-task runtime kernels.
//!
//! The napi class in `native/addon/src/background_tasks.rs` keeps the state and
//! calls host ports; these modules hold the parts that are pure JavaScript
//! semantics: ordered stores, metadata merging, native sub-task records,
//! coalescer windows and output text rules.
pub mod coalescer;
pub mod metadata;
pub mod native_tasks;
pub mod snippet;
pub mod state;
