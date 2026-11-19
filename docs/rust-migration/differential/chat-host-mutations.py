#!/usr/bin/env python3
"""Mutate the native chat session layer and require its tests to fail.

The layer is the part of `RustWsHost` (native/addon/src/ws_host.rs) that owns
the /ws/chat replay buffer, the ordered client membership, the OPEN-filtered
fan-out, the reconnect burst and the destroy/detach lifecycle. The pure
bookkeeping kernel has its own mutation set (chat-replay-buffer-mutations.py);
this one covers the host glue around it. Each variant breaks exactly one rule
the retired Node implementation enforced, rebuilds the addon in an isolated
copy and runs tests/test-chat-replay-hub.js against the mutated binary. The
baseline must pass and every mutation must be detected.

    python3 docs/rust-migration/differential/chat-host-mutations.py

The first run compiles the addon dependencies into a temp target directory, so
it takes several minutes; later variants only rebuild the changed crates.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "native/addon/src/ws_host.rs"
source = SOURCE.read_text()


def must_replace(text, old, new, label):
    if old not in text:
        raise SystemExit(f"{label}: anchor not found in ws_host.rs")
    return text.replace(old, new, 1)


variants = [
    ("baseline", source, True),
    # A closed or closing socket would be sent to.
    ("fan-out-skips-the-open-check",
     must_replace(source,
                  """            if socket.get(c"readyState")?.number()? != 1.0 {
                continue;
            }
            attempted += 1;""",
                  """            attempted += 1;""", "open-check"), False),
    # Members are visited newest first instead of in membership order.
    ("fan-out-reversed",
     must_replace(source, "        for id in members {", "        for id in members.into_iter().rev() {", "reversed"), False),
    # NOTE: removing the `ports.catch(...)` around the per-member send is
    # deliberately NOT a variant. A transport throw is already absorbed by the
    # send-queue kernel (JsTransport::send maps it to the close/terminate path
    # the retired wrapper took), so `enqueue_live` cannot return an error for
    # a throwing socket and no test can observe the outer catch. It stays as
    # defence in depth for napi-level failures; claiming it covered would be
    # false coverage.
    # The replay burst goes through the message-count tripwire.
    ("burst-uses-the-bounded-send",
     # The anchor is the formatted (rustfmt --edition 2021) call: the burst's
     # `bounded` argument is the last one, on its own line.
     must_replace(source,
                  """                    connection_ports,
                    false,
                )""",
                  """                    connection_ports,
                    true,
                )""",
                  "bounded-burst"), False),
    # A closed socket stays a member of its sessions.
    ("detach-keeps-membership",
     must_replace(source, "        self.chat.borrow_mut().detach(&(id as u64));\n", "", "detach"), False),
    # Destroying a session forgets it but leaves the sockets open.
    ("drop-does-not-terminate",
     must_replace(source, """            call_catch(ports, c"terminate", &[socket])?;
            terminated += 1;""", """            let _ = socket;
            terminated += 1;""", "drop-terminate"), False),
    # A discarded chat state keeps its buffer and members.
    ("reset-is-a-noop",
     must_replace(source, "        self.chat.borrow_mut().remove(&session);\n    }\n\n    /// Session destroy",
                  "        let _ = &session;\n    }\n\n    /// Session destroy", "reset"), False),
]

with tempfile.TemporaryDirectory(prefix="multicc-chat-host-mutations-") as tmp:
    tmp = Path(tmp)
    workspace = tmp / "native"
    shutil.copytree(ROOT / "native", workspace,
                    ignore=shutil.ignore_patterns("target", "prebuilt"))
    # Only the crates the addon needs; the others add nothing to this check.
    (workspace / "Cargo.toml").write_text(
        '[workspace]\nmembers=["core","addon","cpr"]\nresolver="2"\n')
    shutil.copy2(ROOT / "native/Cargo.lock", workspace / "Cargo.lock")
    target = Path(os.environ.get("CHAT_HOST_MUTATION_TARGET", tmp / "target"))
    env = dict(os.environ, CARGO_TARGET_DIR=str(target))
    node = tmp / "multicc_core.node"
    for name, variant, should_pass in variants:
        if name != "baseline" and variant == source:
            raise SystemExit(f"{name}: mutation did not apply")
        (workspace / "addon/src/ws_host.rs").write_text(variant)
        build = subprocess.run(
            ["cargo", "build", "--offline", "--manifest-path",
             str(workspace / "Cargo.toml"), "-p", "multicc-addon"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if build.returncode != 0:
            raise SystemExit(f"{name}: the mutated addon did not build\n{build.stdout[-3000:]}")
        shutil.copy2(target / "debug/libmulticc_addon.dylib" if sys.platform == "darwin"
                     else target / "debug/libmulticc_addon.so", node)
        run = subprocess.run(
            ["node", "--test", "tests/test-chat-replay-hub.js"],
            cwd=ROOT, env=dict(os.environ, MULTICC_RUST_ADDON=str(node),
                               MULTICC_RUST_PREBUILT_DIR=str(tmp)),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if (run.returncode == 0) != should_pass:
            raise SystemExit(f"{name}: unexpected result\n{run.stdout[-4000:]}")
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)
