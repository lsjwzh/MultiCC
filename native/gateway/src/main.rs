//! multicc-gateway: Rust front door. `serve` owns the public port, spawns the
//! Node server on a loopback internal port and forwards each connection with a
//! PROXY v1 header. See docs/gateway.md.

fn usage() {
    println!(
        "usage:
  multicc-gateway serve --cwd <dir> --node <node executable> [--stdin-lifeline] [--ephemeral-loopback] [--] <script> [args...]
  multicc-gateway --version

The script defaults to server.js. The front door reads .env from --cwd, binds
the port its bind policy selects, then starts Node on 127.0.0.1 with
MULTICC_GATEWAY_CHILD=1 and MULTICC_GATEWAY_INTERNAL_PORT set. With
--stdin-lifeline, EOF on stdin stops it the way SIGINT does.
--ephemeral-loopback binds 127.0.0.1 on an OS-assigned port for isolated local
launches; the listening log and the child's PORT report the actual port."
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
