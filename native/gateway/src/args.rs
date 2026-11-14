use std::path::PathBuf;

/// `multicc-gateway serve --cwd <目录> (--no-node | --node <node 可执行文件>)
/// [--stdin-lifeline] [--ephemeral-loopback] [--] [脚本] [参数…]`.
///
/// Exactly one runtime mode must be chosen: `--node` spawns and supervises the
/// Node server exactly as before, while `--no-node` never spawns a child and
/// answers every route the Rust front door does not own with 503
/// `node_runtime_absent` (docs/gateway.md §8.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeOptions {
    pub cwd: PathBuf,
    /// `--node <executable>`: the runtime to spawn and supervise. `None` with
    /// `--no-node`: no child process at all.
    pub node: Option<String>,
    pub script: String,
    pub script_args: Vec<String>,
    /// docs/gateway.md §7: EOF on our own stdin is a stop request. Only a
    /// parent that holds the write end may ask for it (`nohup` hands a
    /// terminal-less process an stdin that reads EOF at once).
    pub stdin_lifeline: bool,
    /// Isolated local launches bind 127.0.0.1:0 and report the chosen port.
    pub ephemeral_loopback: bool,
}

impl ServeOptions {
    /// `--node` was given: a Node child exists (or is being restarted).
    pub fn node_enabled(&self) -> bool {
        self.node.is_some()
    }
}

/// The error text for "neither runtime mode was given"; `main.rs` prefixes it
/// with `[multicc-gateway] ` and exits 2.
pub const MISSING_RUNTIME: &str =
    "serve needs --no-node (Rust-only, unmigrated routes fail closed) or --node <node executable>";

pub fn parse(raw: &[String]) -> Result<ServeOptions, String> {
    let mut cwd = None;
    let mut node = None;
    let mut no_node = false;
    let mut stdin_lifeline = false;
    let mut ephemeral_loopback = false;
    let mut rest: Vec<String> = Vec::new();
    let mut index = 0;
    while index < raw.len() {
        let arg = &raw[index];
        if arg == "--" {
            rest = raw[index + 1..].to_vec();
            break;
        }
        if arg == "--cwd" || arg == "--node" {
            let value = raw
                .get(index + 1)
                .ok_or_else(|| format!("{arg} needs a value"))?;
            if arg == "--cwd" {
                cwd = Some(PathBuf::from(value));
            } else {
                node = Some(value.clone());
            }
            index += 2;
            continue;
        }
        if arg == "--no-node" {
            no_node = true;
            index += 1;
            continue;
        }
        if arg == "--stdin-lifeline" {
            stdin_lifeline = true;
            index += 1;
            continue;
        }
        if arg == "--ephemeral-loopback" {
            ephemeral_loopback = true;
            index += 1;
            continue;
        }
        if arg.starts_with("--") {
            return Err(format!("unknown option: {arg}"));
        }
        // A bare token starts the script and its arguments, as if preceded by
        // the optional `--`.
        rest = raw[index..].to_vec();
        break;
    }
    let cwd = cwd.ok_or("serve needs --cwd <dir>")?;
    match (node, no_node) {
        // No silent default: the launcher must say which runtime it wants.
        (None, false) => Err(MISSING_RUNTIME.to_string()),
        (Some(_), true) => {
            Err("serve takes either --no-node or --node <node executable>, not both".to_string())
        }
        (None, true) => {
            if let Some(token) = rest.first() {
                return Err(format!(
                    "serve --no-node takes no script or arguments (unexpected: {token})"
                ));
            }
            Ok(ServeOptions {
                cwd,
                node: None,
                // The package root is still derived from the canonical server
                // entry so `public/` and the data root resolve like `--node`.
                script: "server.js".to_string(),
                script_args: Vec::new(),
                stdin_lifeline,
                ephemeral_loopback,
            })
        }
        (Some(node), false) => {
            let (script, script_args) = match rest.split_first() {
                Some((first, tail)) => (first.clone(), tail.to_vec()),
                None => ("server.js".to_string(), Vec::new()),
            };
            Ok(ServeOptions {
                cwd,
                node: Some(node),
                script,
                script_args,
                stdin_lifeline,
                ephemeral_loopback,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn defaults_to_server_js() {
        let parsed = parse(&args(&["--cwd", "/srv/app", "--node", "/usr/bin/node"])).unwrap();
        assert_eq!(parsed.script, "server.js");
        assert!(parsed.script_args.is_empty());
        assert_eq!(parsed.cwd, PathBuf::from("/srv/app"));
        assert_eq!(parsed.node.as_deref(), Some("/usr/bin/node"));
        assert!(parsed.node_enabled());
    }

    #[test]
    fn no_node_spawns_nothing_and_derives_the_package_root_from_server_js() {
        let parsed = parse(&args(&["--cwd", "/srv/app", "--no-node"])).unwrap();
        assert!(!parsed.node_enabled());
        assert_eq!(parsed.node, None);
        assert_eq!(parsed.script, "server.js");
        assert!(parsed.script_args.is_empty());
        let ordered = parse(&args(&[
            "--no-node",
            "--cwd",
            "/srv/app",
            "--ephemeral-loopback",
        ]))
        .unwrap();
        assert!(ordered.ephemeral_loopback);
        assert_eq!(ordered.cwd, PathBuf::from("/srv/app"));
    }

    #[test]
    fn accepts_an_optional_double_dash_and_passes_arguments_through() {
        let parsed = parse(&args(&[
            "--cwd", "c", "--node", "n", "--", "boot.js", "--port", "1",
        ]))
        .unwrap();
        assert_eq!(parsed.script, "boot.js");
        assert_eq!(parsed.script_args, args(&["--port", "1"]));
        let bare = parse(&args(&["--cwd", "c", "--node", "n", "boot.js", "x"])).unwrap();
        assert_eq!(bare.script, "boot.js");
        assert_eq!(bare.script_args, args(&["x"]));
    }

    #[test]
    fn exactly_one_runtime_mode_is_required() {
        assert_eq!(parse(&args(&["--cwd", "c"])).unwrap_err(), MISSING_RUNTIME);
        assert_eq!(
            parse(&args(&["--cwd", "c", "--node", "n", "--no-node"])).unwrap_err(),
            "serve takes either --no-node or --node <node executable>, not both"
        );
        assert_eq!(
            parse(&args(&["--cwd", "c", "--no-node", "--node", "n"])).unwrap_err(),
            "serve takes either --no-node or --node <node executable>, not both"
        );
        assert_eq!(
            parse(&args(&["--cwd", "c", "--no-node", "server.js"])).unwrap_err(),
            "serve --no-node takes no script or arguments (unexpected: server.js)"
        );
        assert_eq!(
            parse(&args(&["--cwd", "c", "--no-node", "--", "server.js"])).unwrap_err(),
            "serve --no-node takes no script or arguments (unexpected: server.js)"
        );
        // A bare `--` with nothing after it is still fine.
        assert!(parse(&args(&["--cwd", "c", "--no-node", "--"])).is_ok());
    }

    #[test]
    fn the_stdin_lifeline_is_opt_in() {
        let plain = parse(&args(&["--cwd", "c", "--node", "n"])).unwrap();
        assert!(!plain.stdin_lifeline);
        let held = parse(&args(&[
            "--stdin-lifeline",
            "--cwd",
            "c",
            "--node",
            "n",
            "s.js",
        ]))
        .unwrap();
        assert!(held.stdin_lifeline);
        assert_eq!(held.script, "s.js");
        // After the script it belongs to the script.
        let passed = parse(&args(&[
            "--cwd",
            "c",
            "--node",
            "n",
            "s.js",
            "--stdin-lifeline",
        ]))
        .unwrap();
        assert!(!passed.stdin_lifeline);
        assert_eq!(passed.script_args, args(&["--stdin-lifeline"]));
        let rust_only = parse(&args(&["--cwd", "c", "--no-node", "--stdin-lifeline"])).unwrap();
        assert!(rust_only.stdin_lifeline);
    }

    #[test]
    fn ephemeral_loopback_is_opt_in_and_stops_at_the_script() {
        let plain = parse(&args(&["--cwd", "c", "--node", "n"])).unwrap();
        assert!(!plain.ephemeral_loopback);
        let local = parse(&args(&[
            "--cwd",
            "c",
            "--node",
            "n",
            "--ephemeral-loopback",
            "s.js",
        ]))
        .unwrap();
        assert!(local.ephemeral_loopback);
        assert_eq!(local.script, "s.js");
        let passed = parse(&args(&[
            "--cwd",
            "c",
            "--node",
            "n",
            "s.js",
            "--ephemeral-loopback",
        ]))
        .unwrap();
        assert!(!passed.ephemeral_loopback);
        assert_eq!(passed.script_args, args(&["--ephemeral-loopback"]));
    }

    #[test]
    fn rejects_missing_values_and_unknown_switches() {
        assert_eq!(
            parse(&args(&["--node", "n"])).unwrap_err(),
            "serve needs --cwd <dir>"
        );
        assert_eq!(
            parse(&args(&["--no-node"])).unwrap_err(),
            "serve needs --cwd <dir>"
        );
        assert_eq!(parse(&args(&["--cwd"])).unwrap_err(), "--cwd needs a value");
        assert_eq!(
            parse(&args(&["--node"])).unwrap_err(),
            "--node needs a value"
        );
        assert_eq!(
            parse(&args(&["--wat", "x"])).unwrap_err(),
            "unknown option: --wat"
        );
    }
}
