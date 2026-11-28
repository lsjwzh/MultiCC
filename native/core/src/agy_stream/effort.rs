//! A startup rejection applies only to the exact account, model and flag value.
use crate::agy_models;
use regex::Regex;
use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
};

type Selection = (String, String, String);
static REJECTED: LazyLock<Mutex<HashSet<Selection>>> = LazyLock::new(Default::default);
static UNSUPPORTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"--effort(?:=(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+))? is not supported for model\b"#)
        .expect("valid agy diagnostic")
});

pub fn unsupported(message: &str) -> bool {
    UNSUPPORTED.is_match(message)
}

pub fn concrete(
    models: Option<&agy_models::Models>,
    model: Option<&str>,
    effort: &str,
) -> Option<String> {
    let family = model?;
    if crate::cli_capability::effort_of("agy")?
        .tier_suffixes
        .iter()
        .any(|s| family.ends_with(s))
    {
        return None;
    }
    let id = format!("{family}-{effort}");
    models?.contains_key(&id).then_some(id)
}

pub fn rejected(account: &str, model: &str, effort: &str) -> bool {
    REJECTED
        .lock()
        .unwrap()
        .contains(&(account.into(), model.into(), effort.into()))
}

pub fn flag_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].as_str())
}

/// Only called for an actual CLI diagnostic. Rebuild from the original argv so
/// prompt, conversation id and any other switches survive the second launch.
pub fn recover(
    args: &[String],
    account: &str,
    effective: &str,
    already_retried: bool,
    has_output: bool,
) -> Option<Vec<String>> {
    let effort = flag_value(args, "--effort")?;
    let model = flag_value(args, "--model");
    REJECTED.lock().unwrap().insert((
        account.into(),
        model.unwrap_or(effective).into(),
        effort.into(),
    ));
    if already_retried || has_output {
        return None;
    }
    let mut retry = args.to_vec();
    let index = retry.iter().position(|arg| arg == "--effort")?;
    retry.drain(index..index + 2);
    if let Some(id) = concrete(agy_models::cached(account).as_ref(), model, effort) {
        let index = retry.iter().position(|arg| arg == "--model")?;
        retry[index + 1] = id;
    }
    Some(retry)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_retries_rejected_effort_once_before_output() {
        assert!(unsupported(
            r#"invalid model selection (--model "m" --effort "high"): --effort is not supported for model "m""#
        ));
        assert!(unsupported("--effort=high is not supported for model m"));
        assert!(!unsupported("invalid model selection: unknown model"));
        let args = [
            "--model",
            "m",
            "--effort",
            "high",
            "--conversation",
            "cid",
            "-p",
        ]
        .map(String::from);
        let retry = recover(&args, "test-retry", "", false, false).unwrap();
        assert_eq!(retry, ["--model", "m", "--conversation", "cid", "-p"]);
        assert!(rejected("test-retry", "m", "high"));
        assert!(!rejected("other", "m", "high"));
        assert!(recover(&retry, "test-retry", "", false, false).is_none());
        assert!(recover(&args, "test-retry", "", true, false).is_none());
        assert!(recover(&args, "test-retry", "", false, true).is_none());
    }
}
