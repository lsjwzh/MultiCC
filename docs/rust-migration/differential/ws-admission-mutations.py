#!/usr/bin/env python3
"""Mutate the WS admission kernel and require the corpus test to fail.

Each variant breaks exactly one rule the retired admission block enforced. A
green differential only means something if every rule is load bearing, so a
mutation that the corpus cannot tell apart is recorded as a NOTE rather than
counted as coverage.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "native/core/src/ws_admission.rs"
source = SOURCE.read_text()
CORPUS = ROOT / "docs/rust-migration/differential/ws-admission-corpus.json"

variants = [
    ("baseline", source, True),
    # The shutdown gate stops answering: a connection arriving during a
    # graceful shutdown would be admitted instead of closed with 1012.
    ("admits-during-shutdown",
     source.replace("""    if facts.shutting_down {
        steps.push(close(1012, "server shutting down"));
        return steps;
    }
""", "", 1), False),
    # A peer the public-access policy rejects is let through.
    ("admits-a-rejected-peer",
     source.replace("    if !facts.peer_allowed {", "    if false {", 1), False),
    # The share table is consulted on every path, so a non-chat socket could
    # authorize itself with a chat share token.
    ("share-record-needed-on-every-path",
     source.replace("    facts.path == PATH_CHAT && !facts.share_param.is_empty()",
                    "    !facts.share_param.is_empty()", 1), False),
    # A second send queue is installed over the native workspace owner's.
    ("send-queue-over-the-workspace-owner",
     source.replace("""    if !facts.native_socket {
        steps.push(Step::InstallSendQueue);
    }
""", "    steps.push(Step::InstallSendQueue);\n", 1), False),
    # The send queue is installed before the early refusals, so a socket that
    # is closed immediately gets one anyway.
    ("send-queue-before-the-early-refusals",
     source.replace("""    let mut steps = Vec::new();
    if facts.shutting_down {""",
                    """    let mut steps = Vec::new();
    if !facts.native_socket {
        steps.push(Step::InstallSendQueue);
    }
    if facts.shutting_down {""", 1)
     .replace("""    if !facts.native_socket {
        steps.push(Step::InstallSendQueue);
    }
    let share_permission = match share(facts) {""",
              "    let share_permission = match share(facts) {", 1), False),
    # A refused share falls through to the auth phase instead of closing. This
    # also burns a one-use ticket the retired path left alone.
    ("share-refusal-falls-through",
     source.replace("""        Share::Refused => {
            steps.push(close(4003, "Forbidden"));
            return steps;
        }
""", "        Share::Refused => None,\n", 1), False),
    # An empty permission string is falsy in the retired code, so a record that
    # carries one is a refusal, not a view-only grant.
    ("empty-share-permission-admits",
     source.replace("""        .map(|access| access.access.clone())
        .filter(|access| !access.is_empty());""",
                    "        .map(|access| access.access.clone());", 1), False),
    # The share record is accepted for a session it was not issued for.
    ("share-ignores-the-session",
     source.replace("        .filter(|access| access.session_id == facts.session_param)\n", "", 1),
     False),
    # `!machines?.active(id)`: with no machines port installed the optional
    # call is undefined, so a machine-granted ticket must be refused. Reading
    # only `machine_active` would admit it.
    ("missing-machines-port-admits",
     source.replace("if !(facts.machines_present && facts.machine_active) {",
                    "if !facts.machine_active {", 1), False),
    # The grant is annotated onto the socket before it is known to be active,
    # so a revoked grant names itself in the close log.
    ("annotates-a-revoked-grant",
     source.replace("""                if !(facts.machines_present && facts.machine_active) {
                    steps.push(close(4003, "电脑授权已撤销"));
                    return steps;
                }
                steps.push(Step::MachineGrant(ticket.machine_grant_id.clone()));""",
                    """                steps.push(Step::MachineGrant(ticket.machine_grant_id.clone()));
                if !(facts.machines_present && facts.machine_active) {
                    steps.push(close(4003, "电脑授权已撤销"));
                    return steps;
                }""", 1), False),
    # An empty grant id is falsy, so it must not enter the machine gate at all.
    ("empty-grant-enters-the-machine-gate",
     source.replace("            if !ticket.machine_grant_id.is_empty() {", "            if true {", 1),
     False),
    # The correlation id loses its request-id fallback, so a ticket carrying
    # only a request id would log no correlation at all.
    ("correlation-id-loses-the-fallback",
     source.replace("""            let identity = [&ticket.correlation_id, &ticket.request_id]
                .into_iter()
                .find(|value| !value.is_empty())
                .cloned();""",
                    """            let identity = Some(ticket.correlation_id.clone())
                .filter(|value| !value.is_empty());""", 1), False),
    # Fleet scope stops covering the directory, so a directory-scoped ticket
    # could address another directory.
    ("fleet-scope-ignores-the-directory",
     source.replace("            if session_mismatch || directory_mismatch {",
                    "            if session_mismatch {", 1), False),
    # Fleet scope is not enforced at all.
    ("fleet-scope-is-not-enforced",
     source.replace("""            if session_mismatch || directory_mismatch {
                steps.push(Step::Metric(FLEET_DENIED));
                steps.push(close(4003, "Forbidden"));
                return steps;
            }
""", "            let _ = session_mismatch || directory_mismatch;\n", 1), False),
    # The legacy cookie chain stops requiring a configured ACCESS_TOKEN, so an
    # unconfigured server would accept a signed cookie as authentication.
    ("legacy-cookie-ignores-the-access-token",
     source.replace("""        let legacy_cookie = facts.access_token
            && facts.allow_legacy_cookie
            && facts.auth_cookie
            && facts.cookie_valid;""",
                    """        let legacy_cookie =
            facts.allow_legacy_cookie && facts.auth_cookie && facts.cookie_valid;""", 1), False),
    # The legacy query token stops honouring its opt-in flag.
    ("legacy-token-ignores-the-opt-in",
     source.replace("        let legacy_token = facts.access_token && facts.allow_legacy_token && facts.token_valid;",
                    "        let legacy_token = facts.access_token && facts.token_valid;", 1), False),
    # Legacy authentication stops being recorded, so the deprecation loses its
    # only signal.
    ("legacy-auth-is-not-recorded",
     source.replace("""        if legacy_cookie || legacy_token {
            steps.push(Step::Metric(LEGACY_AUTH));
            steps.push(Step::LegacyWarning {
                path: facts.path.clone(),
                mode: if legacy_token { "query" } else { "cookie" },
                ip: facts.ip.clone(),
            });
        }
""", "", 1), False),
    # The warning reports the wrong credential kind.
    ("legacy-warning-swaps-the-mode",
     source.replace("""                mode: if legacy_token { "query" } else { "cookie" },""",
                    """                mode: if legacy_token { "cookie" } else { "query" },""", 1), False),
    # The denial stops exempting local clients, so loopback would need a token.
    ("auth-denial-ignores-locality",
     source.replace("        if !facts.local && (!facts.access_token || no_credential) {",
                    "        if !facts.access_token || no_credential {", 1), False),
    # A configured token alone admits a remote client that presented nothing.
    ("auth-denial-accepts-a-bare-token",
     source.replace("        if !facts.local && (!facts.access_token || no_credential) {",
                    "        if !facts.local && !facts.access_token {", 1), False),
    # The legacy credentials stop counting as credentials, so a client the
    # retired path admitted on a signed cookie is refused.
    ("legacy-credentials-do-not-count",
     source.replace("        let no_credential = facts.ticket().is_none() && !legacy_cookie && !legacy_token;",
                    "        let no_credential = facts.ticket().is_none();", 1), False),
    # An internal execution slot is handed a live chat socket instead of the
    # `Session does not exist.` refusal.
    ("internal-slot-is-admitted",
     source.replace("""    if truthy(&facts.addressed_session_id) && facts.session_internal_slot {
        steps.push(Step::SessionMissing);
        steps.push(Step::Close {
            code: None,
            reason: None,
        });
        return steps;
    }
""", "", 1), False),
    # `ws.close()` takes no arguments there, so the client sees an empty close
    # frame rather than 1000 with a reason.
    ("internal-slot-closes-with-a-code",
     source.replace("""        steps.push(Step::Close {
            code: None,
            reason: None,
        });""", """        steps.push(close(1000, "Session does not exist."));""", 1), False),
    # An empty `session` parameter is falsy, so it must not reach the slot
    # lookup's refusal.
    ("empty-session-id-triggers-the-slot-gate",
     source.replace("    if truthy(&facts.addressed_session_id) && facts.session_internal_slot {",
                    "    if facts.addressed_session_id.is_some() && facts.session_internal_slot {", 1),
     False),
    # The admitted chat client stops carrying its share permission, so a
    # view-only guest would be treated as a full participant.
    ("share-permission-is-not-carried",
     source.replace("""    if facts.path == PATH_CHAT {
        steps.push(Step::SharePermission(share_permission));
    }
""", "", 1), False),
    # The permission is carried on every path, not just chat.
    ("share-permission-on-every-path",
     source.replace("    if facts.path == PATH_CHAT {\n        steps.push(Step::SharePermission(share_permission));\n    }",
                    "    steps.push(Step::SharePermission(share_permission));", 1), False),
    # `needs_ticket` stops honouring the share grant, so an authorized guest
    # would burn a one-use ticket the retired path never touched.
    ("needs-ticket-ignores-the-share-grant",
     source.replace("    matches!(share(facts), Share::Absent)",
                    "    !matches!(share(facts), Share::Granted(_)) || true", 1), False),
    # `needs_ticket` stops honouring the early gates.
    ("needs-ticket-ignores-the-early-gates",
     source.replace("""    if facts.shutting_down || !facts.peer_allowed {
        return false;
    }
""", "", 1), False),
]

failures = []
with tempfile.TemporaryDirectory(prefix="multicc-ws-admission-mutations-") as tmp:
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
    # `chat_replay_buffer` pins its own oracle with `include_str!`, which is
    # resolved at compile time, so the copy needs that file too or the whole
    # crate fails to build and every variant looks "detected".
    helpers = tmp / "tests/helpers"
    helpers.mkdir(parents=True)
    shutil.copy2(ROOT / "tests/helpers/legacy-chat-replay-buffer.js", helpers)
    (workspace / "Cargo.toml").write_text('[workspace]\nmembers=["core"]\nresolver="2"\n')
    shutil.copy2(ROOT / "native/Cargo.lock", workspace / "Cargo.lock")
    env = dict(os.environ, CARGO_TARGET_DIR=str(tmp / "target"))
    for name, variant, should_pass in variants:
        if name != "baseline" and variant == source:
            raise SystemExit(f"{name}: mutation did not apply")
        # The corpus is read through CARGO_MANIFEST_DIR, which now points at
        # the copy; keep it pointing at the frozen original.
        patched = variant.replace(
            'concat!(\n        env!("CARGO_MANIFEST_DIR"),\n        "/../../docs/rust-migration/differential/ws-admission-corpus.json"\n    )',
            f'"{CORPUS}"')
        if patched == variant:
            raise SystemExit(f"{name}: could not repoint the corpus path")
        (workspace / "core/src/ws_admission.rs").write_text(patched)
        run = subprocess.run(
            ["cargo", "test", "--offline", "--manifest-path", str(workspace / "Cargo.toml"),
             "-p", "multicc-core", "--lib", "ws_admission"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        passed = run.returncode == 0
        if passed != should_pass:
            failures.append(name)
            print(f"{name}: UNEXPECTED {'pass' if passed else 'failure'}\n{run.stdout[-3000:]}",
                  flush=True)
            continue
        print(f"{name}: {'passed' if should_pass else 'mutation detected'}", flush=True)

if failures:
    raise SystemExit(f"unexpected results: {', '.join(failures)}")
print(f"{len(variants) - 1} mutations, all detected", flush=True)
