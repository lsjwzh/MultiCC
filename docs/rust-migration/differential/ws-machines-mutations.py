#!/usr/bin/env python3
"""Mutate the machines bridge and require the differential test to catch it.

A green differential only means something if each rule it checks is
load-bearing. Every variant below breaks exactly one rule the retired
`src/ws/machines.js` enforced and names the test that must go red.
"""
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

bridge_path = ROOT / "native/gateway/src/ws_machines.rs"
forward_path = ROOT / "native/gateway/src/forward.rs"
bridge = bridge_path.read_text()
forward = forward_path.read_text()

RELAY = "relays both directions"
CLOSE = "upstream close maps"
MISMATCH = "machine id does not match"
CEILING = "queue ceiling"
PLAIN = "plain GET on the bridge path"

# (name, bridge source, forward source, should_pass, test pattern, expected text)
variants = [
    ("baseline", bridge, forward, True, f"{RELAY}|{CLOSE}|{MISMATCH}|{CEILING}|{PLAIN}", ""),
    ("upstream-close-code",
     bridge.replace('const UPSTREAM_CLOSED: (u16, &str) = (1012,', 'const UPSTREAM_CLOSED: (u16, &str) = (1011,', 1),
     forward, False, CLOSE, "client-visible frames"),
    ("drops-the-4003-passthrough",
     bridge.replace(
         "let code = if code == TICKET_INVALID.0 { TICKET_INVALID.0 } else { UPSTREAM_CLOSED.0 };",
         "let code = UPSTREAM_CLOSED.0;", 1),
     forward, False, CLOSE, "client-visible frames"),
    ("ignores-the-path-binding",
     bridge.replace(
         "if machine_id.is_empty() || path != format!(\"{PREFIX}{machine_id}\") {",
         "if machine_id.is_empty() {", 1),
     forward, False, MISMATCH, ""),
    ("raises-the-queue-ceiling",
     bridge.replace(
         "let mut kernel = Wrapper::new(Limits::default());",
         "let mut kernel = Wrapper::new(Limits { max_frame_bytes: 64 * 1024 * 1024, "
         "max_queue_bytes: 64 * 1024 * 1024, ..Limits::default() });", 1),
     forward, False, CEILING, ""),
    ("claims-a-plain-get", bridge,
     forward.replace(
         "if crate::ws_machines::claims(request.uri().path()) && is_websocket_upgrade(request.headers()) {",
         "if crate::ws_machines::claims(request.uri().path()) {", 1),
     False, PLAIN, ""),
]

with tempfile.TemporaryDirectory(prefix="multicc-ws-machines-mutations-") as tmp:
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
    env = dict(os.environ, CARGO_TARGET_DIR=str(target),
               MULTICC_RUST_ADDON=str(fixture / "multicc_core.node"))
    for name, bridge_variant, forward_variant, should_pass, pattern, expected in variants:
        if name != "baseline" and bridge_variant == bridge and forward_variant == forward:
            raise SystemExit(f"{name}: mutation did not apply")
        (workspace / "gateway/src/ws_machines.rs").write_text(bridge_variant)
        (workspace / "gateway/src/forward.rs").write_text(forward_variant)
        build = subprocess.run(
            ["cargo", "build", "--offline", "--manifest-path", str(workspace / "Cargo.toml"),
             "-p", "multicc-gateway"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if build.returncode:
            raise SystemExit(f"{name}: build failed\n{build.stdout[-5000:]}")
        shutil.copy2(target / "debug" / gateway_name, fixture / gateway_name)
        test = subprocess.run(
            ["node", "--test", "--test-name-pattern=" + pattern,
             "tests/test-ws-machines-differential.js"],
            cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            check=False)
        if (test.returncode == 0) != should_pass or (not should_pass and expected not in test.stdout):
            raise SystemExit(f"{name}: unexpected test result\n{test.stdout[-5000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
