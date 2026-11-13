# Linux x64 CPU compatibility

Linux x64 native builds use the generic `x86-64` CPU baseline. AVX and AVX2
are optional optimizations, not startup requirements. Dependencies may retain
specialized SIMD functions when guarded by runtime CPU detection.

## Why both Rust and C flags matter

The v2.20.2 Linux x64 standalone archive with SHA-256
`d4a6eca0a1c799fe580c093b82d7483208cdb6439522c69d71f24411fd783b18`
contains unguarded AVX2 instructions in C code linked into `multicc_core.node`.
Disassembly includes `vpbroadcastd` in a decimal zero-scanning loop consistent
with bundled SQLite's `sqlite3Atoi64`. This explains a compatibility risk on
VMs without AVX2; it does not identify the exact remote crash instruction
without that machine's fault offset. The compiler's original default CPU
configuration has not been established.

`.cargo/config.toml` pins Rust's target CPU and the target-specific C/C++
compiler flags for GNU and musl Linux x64. Setting only Rust's `target-cpu`
does not constrain bundled SQLite's C compilation. Cargo must run inside the
checkout for this policy to be discovered, including plugin builds and Docker
build contexts. The source-cache fingerprint includes this configuration and
compiler environment changes so previously built modules are not reused.

Explicit feature overrides such as `RUSTFLAGS=-Ctarget-feature=+avx2` or
`CFLAGS=-mavx2` are not portable release configurations. The runtime gate must
remain enabled; do not infer compatibility solely from the configured flags,
and do not ban every AVX instruction in disassembly.

## CI acceptance

`rust-kernels.yml` checks the actual Node/addon pair under QEMU user-mode
emulation with two CPU models:

- `Nehalem`: no AVX or AVX2.
- `IvyBridge`: AVX and F16C, no AVX2, matching the relevant VM constraint.

The baseline Rust probe checks exposed CPU features and deliberately executes
an AVX2 instruction as a negative control. That control must receive SIGILL;
otherwise the emulator cannot establish compatibility and the gate fails.
The positive checks load the real N-API module and exercise SQLite numeric
parsing, UTF-8/UTF-16 databases, WAL, CRUD, transactions, FTS5 and task storage.
The remote, CDP and gateway companions must also report their versions.

The optional `compare_v2_20_2` workflow-dispatch input downloads the pinned
official archive, verifies its digest and requires the old Node/addon pair to
fail with SIGILL under the same checks. A download, loader, assertion or
timeout failure does not count as reproducing the CPU bug. Reports record
binary digests, CPU features, subprocess outcomes and completion status.

`desktop-release.yml` repeats the positive checks using Node and native
binaries extracted from the final Linux x64 standalone archive before upload.
Its existing dependency on the standalone job blocks publication on failure.
These checks establish CPU compatibility for the exercised paths, not every
possible instruction path or Linux libc version.

All compilation and emulator validation run on GitHub CI. Local checks can
validate JavaScript/YAML syntax and mocked build/cache behavior without
compiling. No service restart, existing tag replacement or remote upgrade is
part of this repair.
