#[cfg(windows)]
mod windows;

fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("multicc-desktop-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    #[cfg(windows)]
    if let Err(e) = windows::run() {
        eprintln!("multicc-desktop-agent: {e}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Use scripts/linux-agent/install.sh on Linux; this binary requires Windows.");
        std::process::exit(2);
    }
}
