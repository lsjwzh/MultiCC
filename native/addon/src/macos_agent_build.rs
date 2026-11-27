use multicc_core::macos_agent_build;
use napi::bindgen_prelude::{Buffer, Function};
use napi::{Error, Result};
use napi_derive::napi;
use std::path::Path;

#[napi]
pub fn macos_agent_shipped_build(
    directory: String,
    read_metadata: Option<Function<(), String>>,
) -> Result<f64> {
    match read_metadata {
        Some(read) => Ok(macos_agent_build::build_number(&read.call(())?)),
        None => Ok(macos_agent_build::shipped_build(Path::new(&directory))),
    }
}

#[napi]
pub fn macos_agent_source_hash(
    directory: String,
    read_source: Option<Function<String, Buffer>>,
) -> Result<String> {
    match read_source {
        Some(read) => macos_agent_build::hash_sources(|file| read.call(file.to_owned())),
        None => macos_agent_build::shipped_hash(Path::new(&directory))
            .map_err(|error| Error::from_reason(error.to_string())),
    }
}
