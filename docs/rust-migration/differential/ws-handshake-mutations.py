#!/usr/bin/env python3
"""Check real handshake-source mutations against the frozen Node ws corpus."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
source = (ROOT / "native/gateway/src/ws_handshake.rs").read_text()
fixture = str(ROOT / "docs/rust-migration/differential/ws-handshake-golden.json")
source = source.replace(
    '"../../../docs/rust-migration/differential/ws-handshake-golden.json"',
    json.dumps(fixture),
)
variants = [
    ("baseline", source, True),
    ("accept-post", source.replace('request.method != "GET"',
                                  'request.method != "GET" && request.method != "POST"', 1), False),
    ("alter-accept-key", source.replace('258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
                                       '258EAFA5-E914-47DA-95CA-C5AB0DC85B12', 1), False),
    ("duplicate-protocol", source.replace('if !seen.insert(last) {',
                                          'if false && !seen.insert(last) {', 1), False),
]

with tempfile.TemporaryDirectory(prefix="multicc-ws-handshake-mutations-") as tmp:
    tmp = Path(tmp)
    (tmp / "src").mkdir()
    (tmp / "Cargo.toml").write_text(
        '[workspace]\n[package]\nname="ws_handshake_mutation"\nversion="0.0.0"\nedition="2021"\n'
        '[dependencies]\nbase64="0.22"\nsha1="0.10"\nserde_json="1"\nmulticc-core={path='
        + json.dumps(str(ROOT / "native/core")) + '}\n'
    )
    env = dict(os.environ, CARGO_TARGET_DIR=os.environ.get("CARGO_TARGET_DIR", str(ROOT / "native/target")))
    for name, variant, should_pass in variants:
        if name != "baseline" and variant == source:
            raise SystemExit(f"{name}: mutation did not apply")
        (tmp / "src/lib.rs").write_text(variant)
        result = subprocess.run(
            ["cargo", "test", "--offline", "--manifest-path", str(tmp / "Cargo.toml"),
             "--lib", "frozen_node_ws_handshakes_match_byte_for_byte"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False,
        )
        if (result.returncode == 0) != should_pass or (not should_pass and "oracle case" not in result.stdout):
            raise SystemExit(f"{name}: unexpected result\n{result.stdout[-5000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
