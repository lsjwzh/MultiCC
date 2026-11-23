"""Run against a staged production directory, with an empty PATH and disposable stores."""
import concurrent.futures
import contextlib
import json
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

service = Path(sys.argv[1]).resolve()
binary = service / 'bin/multicc-gateway'
assert binary.is_file()
assert not any(p.name in {'node', 'npm', 'node_modules', 'package.json', 'server.js'} for p in service.rglob('*'))
def browser_asset(path):
    parts = path.relative_to(service).parts
    return parts[0] == 'public' or (len(parts) >= 4 and parts[0] == 'plugins' and parts[2] in {'ui', 'public'})


backend_js = [p for p in service.rglob('*') if p.suffix == '.node' or
              (p.suffix in {'.js', '.mjs', '.cjs'} and not browser_asset(p))]
assert not backend_js, backend_js
events = []
blocked = threading.Event()
release = threading.Event()


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.headers['Authorization'] == 'Bearer fixture-worker-only'
        if self.path.startswith('http://provider.invalid/v1/'):
            self.openai(body)
            return
        assert self.path == '/v1/messages?beta=true'
        assert body['model'] == 'fixture-model' and body['max_tokens'] == 128000
        prompt = body['messages'][0]['content']
        events.append(prompt)
        if prompt == 'inflight':
            blocked.set()
            release.wait(30)
        code, answer = 200, {'content': [{'type': 'text', 'text': 'answer-' + prompt}]}
        if prompt == 'fail':
            code, answer = 429, {'error': {'message': 'fixture limit'}}
        raw = json.dumps(answer).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        with contextlib.suppress(OSError):
            self.wfile.write(raw)

    def openai(self, body):
        if self.path.endswith('/chat/completions'):
            assert body == {'model': 'fixture-model', 'max_tokens': 128000, 'messages': [
                {'role': 'user', 'content': 'chat'}]}
            mime = 'application/json'
            raw = b'{"choices":[{"message":{"content":"chat answer"}}]}'
        else:
            assert self.path == 'http://provider.invalid/v1/responses'
            prompt = body['input'][0]['content'][0]['text']
            assert body == {'model': 'fixture-model', 'stream': True, 'instructions': '',
                            'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]}]}
            mime = 'text/event-stream'
            frame = {'type': 'response.completed', 'response': {'output_text': 'response answer'}}
            if prompt == 'failed':
                frame = {'type': 'response.failed', 'response': {'error': {'message': 'fixture failure'}}}
            if prompt == 'truncated':
                frame = {'type': 'response.created'}
            raw = ('data: ' + json.dumps(frame) + '\r\n\r\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


def eventually(probe, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('timeout waiting for ' + str(probe))


def write(path, body):
    path.write_text(json.dumps(body), encoding='utf-8')


class Gateway:
    def __init__(self, root, proxy):
        self.root = root
        self.proxy = proxy
        self.process = None

    def start(self):
        env = {'HOME': str(self.root / 'home'), 'PATH': '', 'HOST': '127.0.0.1', 'ACCESS_TOKEN': 'local-worker-probe',
               'MULTICC_ENV_FILE': str(self.root / 'empty.env'), 'MULTICC_DATA_DIR': str(self.root / 'data'),
               'MULTICC_AUX_CONCURRENCY': '1', 'MULTICC_CLAUDE_BIN': '/usr/bin/true',
               'http_proxy': self.proxy, 'no_proxy': '127.0.0.1,localhost'}
        self.process = subprocess.Popen([binary, 'serve', '--cwd', service, '--ephemeral-loopback', '--stdin-lifeline'],
                                        stdin=subprocess.PIPE, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, env=env)
        lines = queue.Queue()
        def drain(stream):
            for line in iter(stream.readline, b''):
                lines.put(line.decode(errors='replace'))
        threading.Thread(target=drain, args=(self.process.stderr,), daemon=True).start()
        while True:
            m = re.search(r'listening on 127\.0\.0\.1:(\d+)', lines.get(timeout=10))
            if m:
                self.url = 'http://127.0.0.1:' + m[1]
                break
        assert self.api('/readyz')[0] == 200

    def stop(self, crash=False):
        if self.process:
            if crash:
                self.process.kill()
            self.process.stdin.close()
            try:
                code = self.process.wait(timeout=10)
                if not crash:
                    assert code == 0, code
            finally:
                if self.process.poll() is None:
                    self.process.kill()
                    self.process.wait()
                self.process.stderr.close()
                self.process = None

    def api(self, route, body=None, method=None):
        req = urllib.request.Request(self.url + route, None if body is None else json.dumps(body).encode(),
                                     headers={'content-type': 'application/json'}, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=55)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def job(self, id, prompt):
        status, body = self.api('/api/aux/enqueue', {'id': id, 'type': 'manual', 'prompt': prompt, 'meta': {'sid': 'fixture'}})
        assert status == 200
        return body


def check_agent_recovery(gateway, data, agent_id):
    # Recreate the crash window between durable task admission and saving cron history.
    gateway.stop()
    store = data / 'scheduled_tasks.json'
    rules = json.loads(store.read_text(encoding='utf-8'))
    rule = next(row for row in rules if row['id'] == agent_id)
    at = int(time.time() * 1000)
    rule['_pendingFire'] = {'reason': 'manual', 'key': 'fixture-recovery', 'at': at}
    receipts = []
    for _ in range(2):
        write(store, rules)
        gateway.start()
        def recovered():
            status, body = gateway.api('/api/cron/' + agent_id + '/runs')
            assert status == 200
            return [run for run in body['runs'] if run['at'] == at]
        [run] = eventually(recovered)
        assert run['status'] in ('ok', 'queued') and run['receiptId'], run
        receipts.append(run['receiptId'])
        gateway.stop()
    assert receipts[0] == receipts[1], receipts
    print('PASS pending agent claim reuses its durable receipt across restarts', flush=True)


def main():
    with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(('127.0.0.1', 0), Upstream) as upstream:
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        root = Path(tmp)
        for name in ['home', 'data', 'work']:
            (root / name).mkdir()
        data, work = root / 'data', root / 'work'
        write(data / 'directories.json', [{'id': 'dir', 'name': 'test', 'path': str(work), 'baseBranch': 'main'}])
        write(data / 'provider-defaults.json', {'claude': 'fixture'})
        providers = [{'id': 'fixture', 'name': 'Fixture', 'appType': 'claude',
              'settingsConfig': {'env': {'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{upstream.server_port}',
                                          'ANTHROPIC_AUTH_TOKEN': 'fixture-worker-only'}}}]
        for wire in ['responses', 'chat_completions']:
            providers.append({'id': wire, 'name': wire, 'appType': 'codex', 'settingsConfig': {
                'auth': {'OPENAI_API_KEY': 'fixture-worker-only'},
                'config': f'model = "fixture-model"\nbase_url = "http://provider.invalid/v1"\nwire_api = "{wire}"'}})
        write(data / 'providers.json', {'providers': providers})
        g = Gateway(root, f'http://127.0.0.1:{upstream.server_port}')
        try:
            g.start()
            for route in ['/healthz', '/readyz', '/api/providers', '/api/aux/config', '/api/sessions',
                          '/api/cron', '/api/channels', '/api/secrets', '/api/update/status']:
                assert g.api(route)[0] == 200, route
            assert g.api('/api/aux/config', {'protocol': 'anthropic', 'providerId': 'fixture', 'model': 'fixture-model'})[1]['ok']
            assert g.api('/api/aux/enqueue', {}) == (400, {'error': 'prompt required'})
            assert g.job('one', 'ok') == {'ok': True, 'taskId': 'one', 'result': 'answer-ok'}
            assert g.job('one', 'ok')['ok'] and events == ['ok']
            assert g.api('/api/aux/enqueue', {'id': 'one', 'prompt': 'different'}) == (
                409, {'ok': False, 'error': 'task ID already used for another payload', 'taskId': 'one'})
            assert events == ['ok']
            assert g.job('two', 'fail') == {'ok': False, 'taskId': 'two', 'error': 'fixture limit'}
            assert g.api('/api/aux/health')[1]['health']['consecutiveFails'] == 1
            rule = {'name': 'scheduled', 'kind': 'script', 'dirId': 'dir', 'cron': '* * * * *',
                    'command': 'echo scheduled >> fired', 'enabled': True}
            status, schedule = g.api('/api/cron', rule)
            assert status == 200, schedule
            path = '/api/cron/' + schedule['id']
            eventually(lambda: (work / 'fired').exists(), 45)
            assert eventually(lambda: g.api(path + '/runs')[1]['runs'])[0]['reason'] == 'schedule'
            assert g.api(path, {'enabled': False}, method='PATCH')[1]['enabled'] is False
            code, manual = g.api('/api/cron', {**rule, 'name': 'manual', 'command': 'echo fixture-error; exit 7', 'enabled': False})
            assert code == 200
            receipt = g.api('/api/cron/' + manual['id'] + '/run', {})[1]
            assert receipt['exitCode'] == 7 and receipt['error'] == '脚本退出码 7：fixture-error', receipt
            slow = g.api('/api/cron', {**rule, 'name': 'slow', 'enabled': False, 'scriptTimeoutMs': 4000,
                                       'command': 'echo started > slow; echo timeout-output; exec /bin/sleep 20'})[1]
            with concurrent.futures.ThreadPoolExecutor(1) as client:
                slow_run = client.submit(g.api, '/api/cron/' + slow['id'] + '/run', {})
                eventually(lambda: (work / 'slow').exists())
                assert g.api('/api/cron/' + manual['id'] + '/run', {})[1] == receipt
                assert not slow_run.done(), 'a slow rule blocked an independent trigger'
                timed = slow_run.result(timeout=8)[1]
                assert timed['exitCode'] == 1 and timed['error'] == '脚本超时：timeout-output', timed
            agent = g.api('/api/cron', {'name': 'agent fixture', 'dirId': 'dir', 'cron': '1 1 1 1 *',
                                        'prompt': 'synthetic task', 'enabled': False})[1]
            delivered = g.api('/api/cron/' + agent['id'] + '/run', {})[1]
            assert delivered['ok'] and delivered['taskId'] == agent['taskId'] and delivered['receiptId'], delivered
            interrupted = g.api('/api/cron', {**rule, 'name': 'crash', 'enabled': False,
                                    'command': 'echo side-effect >> interrupted; exec /bin/sleep 3'})[1]
            print('PASS key APIs, scheduled shell, manual exit 7, concurrent rules, timeout output, agent receipt, Aux wire payload, success, 429 and stable ID', flush=True)
            with concurrent.futures.ThreadPoolExecutor(4) as clients:
                running = clients.submit(g.job, 'three', 'inflight')
                assert blocked.wait(8)
                waiting = clients.submit(g.job, 'four', 'queued')
                eventually(lambda: g.api('/api/aux/status')[1]['queueDepth'] == 1)
                cancelled = clients.submit(g.job, 'five', 'cancel')
                eventually(lambda: g.api('/api/aux/status')[1]['queueDepth'] == 2)
                assert g.api('/api/aux/cancel', {'id': 'five'})[1]['ok']
                assert cancelled.result(timeout=4)['error'] == 'cancelled'
                script = clients.submit(g.api, '/api/cron/' + interrupted['id'] + '/run', {})
                eventually(lambda: (work / 'interrupted').exists())
                g.stop(crash=True)
                release.set()
                for future in [running, waiting, script]:
                    with contextlib.suppress(OSError):
                        future.result(timeout=5)
            g.start()
            eventually(lambda: 'queued' in events)
            assert g.job('three', 'inflight')['error'] == 'Aux request interrupted by service restart'
            assert g.job('four', 'queued')['result'] == 'answer-queued'
            assert events == ['ok', 'fail', 'inflight', 'queued'], events
            assert g.api('/api/aux/status')[1]['active'] == 0
            history = g.api('/api/aux/history')[1]
            assert [row['taskId'] for row in history if row['role'] == 'assistant'] == ['one', 'two', 'three', 'four']
            assert (work / 'fired').read_text().splitlines() == ['scheduled']
            assert g.api(path + '/runs')[1]['runs'][0]['status'] == 'ok'
            interrupted_runs = eventually(lambda: g.api('/api/cron/' + interrupted['id'] + '/runs')[1]['runs'])
            assert interrupted_runs[0]['status'] == 'error' and '中断' in interrupted_runs[0]['error']
            assert (work / 'interrupted').read_text().splitlines() == ['side-effect']
            restored = g.api('/api/cron/' + agent['id'] + '/runs')[1]['runs']
            assert len(restored) == 1 and restored[0]['receiptId'] == delivered['receiptId']
            assert g.api(path, method='DELETE') == (200, {'ok': True})
            print('PASS queued job recovered, inflight error retained, cancelled job never sent, persisted history and cron state', flush=True)
            status, summary = g.api('/api/voice/progress-summary', {
                'taskDescription': 'worker fixture', 'events': [{'type': 'status', 'text': 'worker event'}]})
            assert status == 200 and summary['ok'] and 'worker fixture' in summary['summary'], summary
            history = g.api('/api/aux/history')[1]
            assert history[-2]['taskType'] == 'progress_summary' and history[-2]['meta']['reqId']
            assert history[-1]['content'] == summary['summary']
            print('PASS background progress-summary producer, model reply and Aux history', flush=True)
            for wire, prompt, key, expected in [
                ('chat_completions', 'chat', 'result', 'chat answer'),
                ('responses', 'success', 'result', 'response answer'),
                ('responses', 'failed', 'error', 'fixture failure'),
                ('responses', 'truncated', 'error', 'Aux Responses stream disconnected before completion'),
            ]:
                config = g.api('/api/aux/config', {'protocol': 'openai', 'providerId': wire})[1]
                assert config['wireApi'] == wire, config
                status, answer = g.api('/api/aux/enqueue', {'id': prompt, 'prompt': prompt, 'systemPrompt': 'instructions'})
                assert (status, answer) == (200, {'ok': key == 'result', 'taskId': prompt, key: expected}), answer
            print('PASS Chat Completions payload and Responses SSE completion, failure and disconnect', flush=True)
            check_agent_recovery(g, data, agent['id'])
        finally:
            release.set()
            g.stop()
            upstream.shutdown()


if __name__ == '__main__':
    main()
