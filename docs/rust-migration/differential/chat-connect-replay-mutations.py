#!/usr/bin/env python3
"""Mutate the connect-replay kernel and require the corpus test to fail.

Each variant breaks exactly one rule the retired connect path enforced. A
green differential only means something if every rule is load-bearing.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "native/core/src/chat_connect_replay.rs"
source = SOURCE.read_text()
GOLDEN = ROOT / "docs/rust-migration/differential/chat-connect-replay-golden.json"

variants = [
    ("baseline", source, True),
    # NOTE: removing the `replay_messages > 0` conjunct is deliberately NOT a
    # variant here. `last_message_is_assistant` can only be true when there is
    # a last message, so the corpus cannot express the combination that would
    # tell the two apart; claiming it as covered would be false coverage.
    #
    # Clearing the buffer without checking that it has anything in it: the
    # client sees the same frames, but an empty-buffer connect gains a step.
    ("clears-an-empty-buffer",
     source.replace("&& facts.buffered_events > 0\n        {", "{", 1), False),
    # Skipping the burst instead of clearing the session buffer: the client
    # sees the same frames, but the session keeps a stale buffer.
    ("skips-instead-of-clearing",
     source.replace("""    let buffered = if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    };""", "    let buffered = facts.buffered_events;", 1)
     .replace("""pub fn buffer_after(facts: &Facts, steps: &[Step]) -> usize {
    if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    }
}""", """pub fn buffer_after(facts: &Facts, _steps: &[Step]) -> usize {
    facts.buffered_events
}""", 1), False),
    # The streaming gate is dropped from the burst: a stale buffer left by a
    # finished turn would be replayed to the new client.
    ("replays-a-finished-turns-buffer",
     source.replace("if facts.is_streaming && buffered > 0 {", "if buffered > 0 {", 1), False),
    # The token-usage-only case loses its history frame.
    ("requires-messages-for-the-history-frame",
     source.replace("if facts.replay_messages > 0 || facts.has_token_usage {",
                    "if facts.replay_messages > 0 {", 1), False),
    # The seed is emitted before the history frame.
    ("reorders-the-seed",
     source.replace("""        steps.push(Step::ChatHistory);
        if facts.has_task_state_seed {
            steps.push(Step::TaskStateSeed);
        }""", """        if facts.has_task_state_seed {
            steps.push(Step::TaskStateSeed);
        }
        steps.push(Step::ChatHistory);""", 1), False),
]

with tempfile.TemporaryDirectory(prefix="multicc-connect-replay-mutations-") as tmp:
    tmp = Path(tmp)
    workspace = tmp / "native"
    workspace.mkdir()
    shutil.copytree(ROOT / "native/core", workspace / "core")
    shutil.copytree(ROOT / "native/cpr", workspace / "cpr")
    # Other kernels in this crate read their own frozen corpora through
    # relative include_str! paths, so the copy needs the same docs tree.
    corpora = tmp / "docs/rust-migration/differential"
    corpora.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "docs/rust-migration/differential", corpora)
    (workspace / "Cargo.toml").write_text('[workspace]\nmembers=["core"]\nresolver="2"\n')
    shutil.copy2(ROOT / "native/Cargo.lock", workspace / "Cargo.lock")
    env = dict(os.environ, CARGO_TARGET_DIR=str(tmp / "target"))
    for name, variant, should_pass in variants:
        if name != "baseline" and variant == source:
            raise SystemExit(f"{name}: mutation did not apply")
        # The corpus is read through CARGO_MANIFEST_DIR, which now points at
        # the copy; keep it pointing at the frozen original.
        patched = variant.replace(
            'concat!(\n        env!("CARGO_MANIFEST_DIR"),\n        "/../../docs/rust-migration/differential/chat-connect-replay-golden.json"\n    )',
            f'"{GOLDEN}"')
        if patched == variant:
            raise SystemExit(f"{name}: could not repoint the corpus path")
        (workspace / "core/src/chat_connect_replay.rs").write_text(patched)
        run = subprocess.run(
            ["cargo", "test", "--offline", "--manifest-path", str(workspace / "Cargo.toml"),
             "-p", "multicc-core", "--lib", "chat_connect_replay"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if (run.returncode == 0) != should_pass:
            raise SystemExit(f"{name}: unexpected result\n{run.stdout[-4000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
