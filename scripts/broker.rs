#!/usr/bin/env -S cargo +nightly-2026-10-11 -Zscript
---
[package]
edition = "2024"
---
// Cargo compiles and caches this helper; production uses the packaged binary.
use std::process::{Command, Stdio};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let binary = args.next().ok_or("Usage: cargo -Zscript scripts/broker.rs /absolute/path/heavenkey PORT COMMAND < request.json")?;
    let mut args = args.collect::<Vec<_>>();
    let mode = if args.first().is_some_and(|arg| arg == "--sandbox") {
        args.remove(0);
        "--broker-sandbox"
    } else { "--broker-agent" };
    let status = Command::new(binary).arg(mode).args(args)
        .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).status()?;
    std::process::exit(status.code().unwrap_or(1));
}
