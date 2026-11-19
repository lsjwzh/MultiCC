#!/usr/bin/env python3
"""Run real hub-source mutations against isolated concurrency and replay tests."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
source = (ROOT / 'native/gateway/src/ws_chat_hub.rs').read_text()
variants = [
    ('baseline', source, True),
    ('discard-replay', source.replace('state.push(event.clone());', 'let _ = &event;', 1), False),
    ('buffer-transient', source.replace('if replay {', 'if true {', 1), False),
    ('skip-registration', source.replace('state.join(connection.id);', 'let _ = connection.id;', 1), False),
    ('lose-snapshot', source.replace('let replay = state.replay().iter().cloned().collect();', 'let replay = Vec::new();', 1), False),
    ('skip-detach', source.replace('sessions.session(&self.session).leave(&self.connection.id);', 'let _ = &self.connection.id;', 1), False),
]
with tempfile.TemporaryDirectory(prefix='multicc-chat-hub-mutations-') as tmp_name:
    tmp = Path(tmp_name)
    (tmp / 'core/src').mkdir(parents=True)
    (tmp / 'gateway/src').mkdir(parents=True)
    core_source = (ROOT / 'native/core/src/chat_replay_buffer.rs').read_text().split('#[cfg(test)]', 1)[0]
    (tmp / 'core/Cargo.toml').write_text('[package]\nname="multicc-core"\nversion="0.1.0"\nedition="2021"\n')
    (tmp / 'core/src/lib.rs').write_text('pub mod chat_replay_buffer;\n')
    (tmp / 'core/src/chat_replay_buffer.rs').write_text(core_source)
    (tmp / 'gateway/Cargo.toml').write_text(
        '[package]\nname="chat-hub-mutations"\nversion="0.1.0"\nedition="2021"\n'
        '[dependencies]\nmulticc-core={path="../core"}\nhyper="1"\n'
        'tokio={version="1",features=["rt-multi-thread","macros","sync"]}\n')
    (tmp / 'gateway/src/lib.rs').write_text('mod ws_registry;\nmod ws_chat_hub;\n')
    shutil.copy2(ROOT / 'native/gateway/src/ws_registry.rs', tmp / 'gateway/src/ws_registry.rs')
    env = dict(os.environ, CARGO_TARGET_DIR=str(tmp / 'target'))
    for name, variant, expected in variants:
        if name != 'baseline' and variant == source:
            raise SystemExit(f'{name}: mutation did not apply')
        (tmp / 'gateway/src/ws_chat_hub.rs').write_text(variant)
        result = subprocess.run(
            ['cargo', 'test', '--offline', '--manifest-path', str(tmp / 'gateway/Cargo.toml'),
             '--lib', 'ws_chat_hub::tests'], env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if (result.returncode == 0) != expected or (not expected and 'test result: FAILED' not in result.stdout):
            raise SystemExit(f'{name}: unexpected result\n{result.stdout[-5000:]}')
        print(f'{name}: {"passed" if expected else "mutation detected"}', flush=True)
