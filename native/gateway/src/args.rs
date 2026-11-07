use std::path::PathBuf;

/// `multicc-gateway serve --cwd <目录> --node <node 可执行文件>
/// [--stdin-lifeline] [--] <脚本> [参数…]`, 脚本缺省为 `server.js`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeOptions {
    pub cwd: PathBuf,
    pub node: String,
    pub script: String,
    pub script_args: Vec<String>,
    /// docs/gateway.md §7: EOF on our own stdin is a stop request. Only a
    /// parent that holds the write end may ask for it (`nohup` hands a
    /// terminal-less process an stdin that reads EOF at once).
    pub stdin_lifeline: bool,
}

pub fn parse(raw: &[String]) -> Result<ServeOptions, String> {
    let mut cwd = None;
    let mut node = None;
    let mut stdin_lifeline = false;
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
        if arg == "--stdin-lifeline" {
            stdin_lifeline = true;
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
    let node = node.ok_or("serve needs --node <node executable>")?;
    let (script, script_args) = match rest.split_first() {
        Some((first, tail)) => (first.clone(), tail.to_vec()),
        None => ("server.js".to_string(), Vec::new()),
    };
    Ok(ServeOptions {
        cwd,
        node,
        script,
        script_args,
        stdin_lifeline,
    })
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
    }

    #[test]
    fn rejects_missing_values_and_unknown_switches() {
        assert_eq!(
            parse(&args(&["--node", "n"])).unwrap_err(),
            "serve needs --cwd <dir>"
        );
        assert_eq!(
            parse(&args(&["--cwd", "c"])).unwrap_err(),
            "serve needs --node <node executable>"
        );
        assert_eq!(parse(&args(&["--cwd"])).unwrap_err(), "--cwd needs a value");
        assert_eq!(
            parse(&args(&["--wat", "x"])).unwrap_err(),
            "unknown option: --wat"
        );
    }
}
