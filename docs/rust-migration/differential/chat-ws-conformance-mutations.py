#!/usr/bin/env python3
"""Mutation proof for tests/test-chat-ws-conformance.js.

The conformance test is an end-to-end oracle: it drives a real gateway, a real
Node server and a fake CLI. A mutation therefore has to change production
behaviour that a client can observe, and the test has to turn red. Each
mutation edits one production file in place, runs the test and restores the
original bytes in a finally block, so the working tree is left untouched even
if the run is interrupted by an exception.

    python3 docs/rust-migration/differential/chat-ws-conformance-mutations.py

Exit status is 0 only when the baseline passes and every mutation is detected.
After the /ws/chat upgrade moves into the front door the Node-side targets
below disappear with their code; the mutations then move to the Rust sources
with the same observable effect (close code/reason, ticket path binding, share
scope, pong, session_not_found).
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
TEST = 'tests/test-chat-ws-conformance.js'
ROUTER = 'src/ws/connection-router.js'
ENGINE = 'src/chat/turn-engine.js'

MUTATIONS = [
    ('external-deny-reason-changes', ROUTER,
     "        ws.close(4003, 'Forbidden');\n        return;\n      }\n    }\n\n    if (addressedSessionId",
     "        ws.close(4003, 'Forbidden!');\n        return;\n      }\n    }\n\n    if (addressedSessionId"),
    ('ticket-loses-path-binding', ROUTER,
     "authSecurity?.consumeWsTicket?.(urlObj.searchParams.get('ticket'), urlObj.pathname)",
     "authSecurity?.consumeWsTicket?.(urlObj.searchParams.get('ticket'), '/ws/meta')"),
    ('share-no-longer-scoped-to-its-session', ROUTER,
     "if (access && access.sessionId === urlObj.searchParams.get('session')) {",
     "if (access) {"),
    ('heartbeat-reply-renamed', ENGINE,
     "try { sendWs(ws, { type: 'pong' }); } catch (_) {}",
     "try { sendWs(ws, { type: 'pong2' }); } catch (_) {}"),
    ('missing-session-code-changes', ENGINE,
     "sendWs(ws, { type: 'error', code: 'session_not_found', error:\n        `Chat session",
     "sendWs(ws, { type: 'error', code: 'session_gone', error:\n        `Chat session"),
]


def run_test():
    return subprocess.run(['node', '--test', TEST], cwd=ROOT, capture_output=True, text=True, timeout=600)


def main():
    baseline = run_test()
    print('baseline:', 'passed' if baseline.returncode == 0 else 'FAILED')
    if baseline.returncode != 0:
        print(baseline.stdout[-3000:], baseline.stderr[-1500:])
        return 1
    escaped = []
    for name, relative, old, new in MUTATIONS:
        target = ROOT / relative
        original = target.read_bytes()
        text = original.decode('utf-8')
        if text.count(old) != 1:
            print(f'{name}: target text matched {text.count(old)} times; the mutation is stale')
            return 2
        try:
            target.write_bytes(text.replace(old, new).encode('utf-8'))
            result = run_test()
        finally:
            target.write_bytes(original)
        detected = result.returncode != 0
        print(f'{name}: mutation {"detected" if detected else "NOT detected"}')
        if not detected:
            escaped.append(name)
    return 1 if escaped else 0


if __name__ == '__main__':
    sys.exit(main())
