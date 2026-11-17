use multicc_core::publication::release_notes;
use std::{env, fs};

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("用法：release-notes 版本 CHANGELOG.md 输出文件".into());
    }
    let changelog = fs::read_to_string(&args[1]).map_err(|_| "无法读取 CHANGELOG.md")?;
    let notes = release_notes(&changelog, &args[0])?;
    fs::write(&args[2], notes).map_err(|_| "无法写入发布说明文件")?;
    println!("已提取当前版本的发布说明");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
