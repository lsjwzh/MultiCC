//! Two independent probes. Their JS Map owners retain arbitrary host keys and
//! in-flight Promises for exactly the lifetime of the returned callbacks.
mod process;
mod rollout;
