//! multicc-gateway: Rust front door. `serve` owns the public port, spawns the
//! Node server on a loopback internal port and forwards each connection with a
//! PROXY v1 header. See docs/gateway.md.

fn usage() {
    println!(
        "usage:
  multicc-gateway serve --cwd <dir> --no-node [--stdin-lifeline] [--ephemeral-loopback]
  multicc-gateway serve --cwd <dir> --node <node executable> [--stdin-lifeline] [--ephemeral-loopback] [--] <script> [args...]
  multicc-gateway --version

Exactly one runtime mode is required. With --node the front door spawns the
script (default server.js) on 127.0.0.1 with MULTICC_GATEWAY_CHILD=1 and
MULTICC_GATEWAY_INTERNAL_PORT set, and forwards to it. With --no-node no child
is spawned: routes it would have forwarded, and native routes that need the
authentication snapshot Node owns, answer 503 node_runtime_absent. Both
modes read .env from --cwd and bind the port their bind policy selects.
--stdin-lifeline makes EOF on stdin stop the front door the way SIGINT does.
--ephemeral-loopback binds 127.0.0.1 on an OS-assigned port for isolated local
launches; the listening log reports the actual port."
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("{}", multicc_gateway::version_line());
        return;
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        usage();
        return;
    }
    match args.first().map(String::as_str) {
        // Experimental private stdin/stdout protocol. The host does not use
        // this path until lifecycle, packaging and compatibility are verified.
        Some("orchestration-owner") if args.len() == 1 => {
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            if multicc_core::orchestration_owner::serve(stdin.lock(), stdout.lock(), u64::MAX)
                .is_err()
            {
                eprintln!("[orchestration-owner] transport failed");
                std::process::exit(1);
            }
        }
        Some("serve") => {
            let options = match multicc_gateway::args::parse(&args[1..]) {
                Ok(options) => options,
                Err(message) => {
                    eprintln!("[multicc-gateway] {message}");
                    std::process::exit(2);
                }
            };
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            let code = runtime.block_on(multicc_gateway::daemon::serve(options));
            std::process::exit(code);
        }
        Some("help") | None => {
            usage();
            std::process::exit(if args.is_empty() { 2 } else { 0 });
        }
        Some(_) => {
            usage();
            std::process::exit(2);
        }
    }
}
