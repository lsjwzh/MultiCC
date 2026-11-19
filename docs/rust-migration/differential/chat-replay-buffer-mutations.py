#!/usr/bin/env python3
"""Require the replay/membership differential to reject isolated kernel mutations."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
source = (ROOT / 'native/core/src/chat_replay_buffer.rs').read_text()
variants = [
    ('baseline', source, True),
    ('capacity', source.replace('REPLAY_CAPACITY: usize = 500', 'REPLAY_CAPACITY: usize = 499', 1), False),
    ('evict-newest', source.replace('self.replay.pop_front();', 'self.replay.pop_back();', 1), False),
    ('duplicate-client', source.replace('if !self.clients.contains(&client) {', 'if true {', 1), False),
    ('leave-noop', source.replace('self.clients.retain(|entry| entry != client);', 'let _ = client;', 1), False),
    ('clear-replay-noop', source.replace('self.replay.clear();', 'let _ = &self.replay;', 1), False),
]
with tempfile.TemporaryDirectory(prefix='multicc-replay-mutations-') as tmp_name:
    tmp = Path(tmp_name)
    workspace = tmp / 'native'
    (workspace / 'core/src').mkdir(parents=True)
    docs = tmp / 'docs/rust-migration'
    docs.mkdir(parents=True)
    shutil.copytree(ROOT / 'docs/rust-migration/differential', docs / 'differential')
    helpers = tmp / 'tests/helpers'
    helpers.mkdir(parents=True)
    shutil.copy2(ROOT / 'tests/helpers/legacy-chat-replay-buffer.js', helpers)
    (workspace / 'core/Cargo.toml').write_text(
        '[package]\nname="replay-mutations"\nversion="0.1.0"\nedition="2021"\n'
        '[dependencies]\nserde_json={version="1",features=["preserve_order"]}\nbase64="0.22"\nsha2="0.10"\n')
    env = dict(os.environ, CARGO_TARGET_DIR=str(tmp / 'target'))
    for name, variant, expected in variants:
        if name != 'baseline' and variant == source:
            raise SystemExit(f'{name}: mutation did not apply')
        (workspace / 'core/src/lib.rs').write_text(variant)
        result = subprocess.run(
            ['cargo', 'test', '--offline', '--manifest-path', str(workspace / 'core/Cargo.toml'),
             '--lib', 'replay_and_client_membership_match_frozen_node_corpus'],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if (result.returncode == 0) != expected or (not expected and 'final case' not in result.stdout):
            raise SystemExit(f'{name}: unexpected result\n{result.stdout[-4000:]}')
        print(f'{name}: {"passed" if expected else "mutation detected"}', flush=True)
