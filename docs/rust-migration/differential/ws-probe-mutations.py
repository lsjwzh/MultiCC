#!/usr/bin/env python3
"""Mutate an isolated probe source copy and require the real frame test to fail."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
TARGET = ROOT / "native/target"
gateway_name = "multicc-gateway.exe" if sys.platform == "win32" else "multicc-gateway"
addon_name = ("multicc_addon.dll" if sys.platform == "win32" else
              "libmulticc_addon.dylib" if sys.platform == "darwin" else "libmulticc_addon.so")
ADDON = TARGET / "debug" / addon_name
if not ADDON.is_file():
    raise SystemExit("Build the debug addon before running this check")

source = (ROOT / "native/gateway/src/ws_probe.rs").read_text()
core_source = (ROOT / "native/core/src/api_contract.rs").read_text()
variants = [
    ("baseline", source, True, "Rust WS probe emits|Rust WS probe fans out", ""),
    ("wrong-pong", source.replace('probe_event("pong")',
                                  'probe_event("PONG")', 1), False, "Rust WS probe emits", "opcode 1"),
    ("ignore-binary", source.replace(
        'Some(Ok(Message::Binary(bytes))) => if !dispatch_probe(&registry, id, &bytes) { break; },',
        'Some(Ok(Message::Binary(_))) => {},', 1), False, "Rust WS probe emits", "raw WS frame timed out"),
    ("cross-session-fanout", source.replace(
        'registry.register_session(session, 64, 1024 * 1024)',
        'registry.register_session(String::new(), 64, 1024 * 1024)', 1), False, "Rust WS probe fans out", "cross-session broadcast leaked"),
    ("wrong-envelope-version", source, False, "Rust WS probe emits", "opcode 1"),
]
with tempfile.TemporaryDirectory(prefix="multicc-ws-probe-mutations-") as tmp:
    tmp = Path(tmp)
    workspace = tmp / "native"
    workspace.mkdir()
    shutil.copytree(ROOT / "native/gateway", workspace / "gateway")
    shutil.copytree(ROOT / "native/core", workspace / "core")
    shutil.copytree(ROOT / "native/cpr", workspace / "cpr")
    (workspace / "Cargo.toml").write_text('[workspace]\nmembers=["gateway"]\nresolver="2"\n')
    shutil.copy2(ROOT / "native/Cargo.lock", workspace / "Cargo.lock")
    fixture = tmp / "fixture"
    fixture.mkdir()
    shutil.copy2(ADDON, fixture / "multicc_core.node")
    target = tmp / "target"
    env = dict(os.environ, CARGO_TARGET_DIR=str(target), MULTICC_RUST_ADDON=str(fixture / "multicc_core.node"))
    for name, variant, should_pass, pattern, expected_failure in variants:
        core_variant = core_source
        if name == "wrong-envelope-version":
            core_variant = core_source.replace(
                'crate::quota_guard::set(&mut envelope, "apiVersion", V::string("v1"));',
                'crate::quota_guard::set(&mut envelope, "apiVersion", V::string("v2"));', 1)
        if name != "baseline" and variant == source and core_variant == core_source:
            raise SystemExit(f"{name}: mutation did not apply")
        (workspace / "gateway/src/ws_probe.rs").write_text(variant)
        (workspace / "core/src/api_contract.rs").write_text(core_variant)
        build = subprocess.run(["cargo", "build", "--offline", "--manifest-path", str(workspace / "Cargo.toml"), "-p", "multicc-gateway"],
                               env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if build.returncode:
            raise SystemExit(f"{name}: build failed\n{build.stdout[-5000:]}")
        shutil.copy2(target / "debug" / gateway_name, fixture / gateway_name)
        test = subprocess.run(["node", "--test", "--test-name-pattern=" + pattern,
                               "tests/test-gateway-auth-native.js"], cwd=ROOT, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if (test.returncode == 0) != should_pass or (not should_pass and expected_failure not in test.stdout):
            raise SystemExit(f"{name}: unexpected test result\n{test.stdout[-5000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
