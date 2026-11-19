#!/usr/bin/env python3
"""Check real backpressure-kernel mutations against the frozen Node corpus.

Run from the repository root:
  python3 docs/rust-migration/differential/ws-backpressure-mutations.py
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
source = (ROOT / "native/core/src/ws_backpressure.rs").read_text()
fixture = str(ROOT / "docs/rust-migration/differential/ws-backpressure-golden.json")
source = source.replace(
    '"../../../docs/rust-migration/differential/ws-backpressure-golden.json"',
    json.dumps(fixture),
)
# The kernel lives inside multicc-core; a standalone copy reaches the same
# helpers through the published crate path.
source = source.replace("crate::js::", "multicc_core::js::").replace(
    "use crate::js::{self, coerce, JsValue};",
    "use multicc_core::js::{self, coerce, JsValue};",
)

TEST = "frozen_node_backpressure_decisions_match_effect_for_effect"
variants = [
    ("baseline", source, True),
    # The message-count tripwire must stay off the replay path only.
    ("count-cap-everywhere",
     source.replace("let over_messages = bounded && self.queue.len()",
                    "let over_messages = self.queue.len()", 1), False),
    # Coalescing must replace the queued frame in place, not append.
    ("coalesce-appends",
     source.replace("self.queue[index] = Item {", "self.queue.push(Item {", 1)
           .replace("""                    bytes,
                    key: Some(key),
                };""", """                    bytes,
                    key: Some(key),
                });""", 1), False),
    # `>=` is the high-water comparison: an exactly-at-threshold socket waits.
    ("high-water-strict",
     source.replace("if transport.buffered_amount() >= self.limits.high_water_bytes",
                    "if transport.buffered_amount() > self.limits.high_water_bytes", 1), False),
    # The congestion cut fires at exactly maxCongestionMs.
    ("congestion-strict",
     source.replace("if self.now - self.congested_at >= self.limits.max_congestion_ms as f64",
                    "if self.now - self.congested_at > self.limits.max_congestion_ms as f64", 1), False),
    # The queue ceiling is widened by one maximum frame.
    ("ceiling-without-frame",
     source.replace("let ceiling = self.limits.max_queue_bytes + self.limits.max_frame_bytes;",
                    "let ceiling = self.limits.max_queue_bytes;", 1), False),
    # Dropping below high water clears the congestion mark.
    ("congestion-never-clears",
     source.replace("        self.congested_at = 0.0;\n        let item = self.queue.remove(0);",
                    "        let item = self.queue.remove(0);", 1), False),
    # A disconnect must cancel the pending retry timer.
    ("keeps-the-timer",
     source.replace(
         'if self.timer {\n            self.effects.push(Effect::Cancel);\n'
         '            self.timer = false;\n        }\n'
         '        self.metric("multicc_ws_backpressure_disconnects_total"',
         '        self.metric("multicc_ws_backpressure_disconnects_total"', 1), False),
    # A throwing close must fall back to terminate.
    ("no-terminate-fallback",
     source.replace(
         'if transport.close(CODE, REASON).is_err() {\n'
         '            self.effects.push(Effect::Terminate);\n'
         '            transport.terminate();\n        }',
         'let _ = transport.close(CODE, REASON);', 1), False),
]

with tempfile.TemporaryDirectory(prefix="multicc-ws-backpressure-mutations-") as tmp:
    tmp = Path(tmp)
    (tmp / "src").mkdir()
    (tmp / "Cargo.toml").write_text(
        '[workspace]\n[package]\nname="ws_backpressure_mutation"\nversion="0.0.0"\nedition="2021"\n'
        '[dependencies]\nsha2="0.10"\nserde_json={version="1",features=["float_roundtrip"]}\n'
        'multicc-core={path=' + json.dumps(str(ROOT / "native/core")) + '}\n'
    )
    env = dict(os.environ, CARGO_TARGET_DIR=os.environ.get(
        "MULTICC_MUTATION_TARGET_DIR", str(tmp / "target")))
    for name, variant, should_pass in variants:
        if name != "baseline" and variant == source:
            raise SystemExit(f"{name}: mutation did not apply")
        (tmp / "src/lib.rs").write_text(variant)
        result = subprocess.run(
            ["cargo", "test", "--offline", "--manifest-path", str(tmp / "Cargo.toml"),
             "--lib", TEST],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False,
        )
        # A mutation is caught either by an effect mismatch or by the corpus
        # driving the mutated kernel into a panic (an underflowing queue
        # accounting, for instance). Both are this test failing on real data.
        detected = any(marker in result.stdout for marker in
                       ("diverged", "effect count", f"tests::{TEST} stdout"))
        if (result.returncode == 0) != should_pass or (not should_pass and not detected):
            raise SystemExit(f"{name}: unexpected result\n{result.stdout[-5000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
print("all backpressure mutations accounted for")
