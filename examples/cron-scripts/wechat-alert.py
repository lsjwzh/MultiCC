#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCC 异常微信提醒 —— 「定时脚本任务」的例子。

这条链路一共三步，全程不碰大模型：

    1. 取任务状态   GET  /api/air                  → 挑出 runState 是 error / waiting 的活任务
    2. 调会话接口   POST /api/sessions/<中转会话>/scheduled-messages
    3. 发微信提醒   中转任务收到工单后用 computer use 把正文原样发进微信群

它对应「定时任务中心」（Air 侧栏 → 定时任务）里 kind=script 的那一类规则：不需要
固定 Air 任务、不需要常驻会话，cron 到点就在工作目录里跑一次这条命令，退出码与输出
末尾进执行记录。**每次调用只扫一轮就退出** —— 循环交给 cron 表达式，不要在这儿
自己 sleep，否则规则卡在「执行中」永不结算。

用法（配置与状态都放 ~/.multicc 下，不进仓库）：

    python3 wechat-alert.py --config ~/.multicc/wechat-alert/config-cron.json
    python3 wechat-alert.py --config ... --dry-run     # 只打印要发什么，不改状态、不投递

退出码：0 = 正常（含「本轮没有要提醒的」「被频率闸压住」），1 = 取状态或投递失败。
失败会体现在定时任务卡片的错误态与最近一次运行的输出里。

首轮**只登记不补发**（primed）：第一次跑时机器上多半已经堆着一批历史 error，直接
发就是往群里刷屏。所以第一轮只把当前状态记下来，从第二轮起才报「变化」。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
DEFAULT_GROUP = 'all in one'
MAX_LINES_PER_MESSAGE = 8
MAX_ALERTS_KEPT = 200
REQUEST_TIMEOUT_SECONDS = 30

DEFAULTS = {
    'enabled': True,
    'baseUrl': DEFAULT_BASE_URL,
    'relayTaskId': '',
    'relaySessionId': '',
    'wechatGroup': DEFAULT_GROUP,
    'watchStates': {'error': {'label': '出错了'}, 'waiting': {'label': '在等你回答'}},
    'reAlertAfterMinutes': 0,
    'minDispatchIntervalMs': 120000,
    'maxAlertsPerHour': 12,
    'excludeTaskIds': [],
    'excludeSessionIds': [],
    'excludeTitlePrefixes': [],
    'dispatchDelaySeconds': 1,
}


# ── 配置与状态 ────────────────────────────────────────────────────────────────

def load_config(path):
    """读配置文件；缺的键用默认值补齐。文件不存在不算错，纯靠命令行参数也能跑。"""
    cfg = dict(DEFAULTS)
    cfg['watchStates'] = dict(DEFAULTS['watchStates'])
    if path:
        try:
            with open(path, encoding='utf-8') as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            raise SystemExit('配置文件不存在：%s' % path)
        except (OSError, ValueError) as error:
            raise SystemExit('配置文件读不了（%s）：%s' % (path, error))
        if not isinstance(raw, dict):
            raise SystemExit('配置文件顶层必须是对象：%s' % path)
        for key in DEFAULTS:
            if key in raw and raw[key] is not None:
                cfg[key] = raw[key]
    return cfg


def state_path(cfg, config_path, override):
    """状态文件放哪：命令行 > 配置文件 stateFile（相对配置文件所在目录）> 同目录默认。

    状态**必须**跨次调用活着（去重、频率闸、primed 都靠它），所以别放进会被回收的
    目录里 —— ~/.multicc 下是安全的。
    """
    if override:
        return os.path.abspath(os.path.expanduser(override))
    base = os.path.dirname(os.path.abspath(os.path.expanduser(config_path))) if config_path else os.getcwd()
    name = cfg.get('stateFile') or 'state-cron.json'
    return name if os.path.isabs(name) else os.path.join(base, name)


def load_state(path):
    try:
        with open(path, encoding='utf-8') as handle:
            parsed = json.load(handle)
        if not isinstance(parsed, dict):
            raise ValueError('bad state')
    except (OSError, ValueError):
        return {'version': 1, 'primed': False, 'tasks': {}, 'alerts': []}
    return {
        'version': 1,
        'primed': parsed.get('primed') is True,
        'tasks': parsed.get('tasks') if isinstance(parsed.get('tasks'), dict) else {},
        'alerts': parsed.get('alerts')[-MAX_ALERTS_KEPT:] if isinstance(parsed.get('alerts'), list) else [],
        'lastDispatchAt': parsed.get('lastDispatchAt') or 0,
    }


def save_state(path, state):
    """先写临时文件再 rename：中途挂掉也不会留下半个 JSON 把下一轮带偏。"""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(tmp, path)
    except OSError as error:
        print('wechat-alert: 状态写不进去 (%s)' % error, file=sys.stderr)


# ── HTTP ─────────────────────────────────────────────────────────────────────

def request_json(base_url, method, pathname, body=None):
    payload = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base_url.rstrip('/') + pathname, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read().decode('utf-8', 'replace')
            status = response.status
    except urllib.error.HTTPError as error:
        return error.code, None, error.read().decode('utf-8', 'replace')
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError('%s %s 连不上：%s' % (method, pathname, error))
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    return status, parsed, raw


# ── 任务板 ───────────────────────────────────────────────────────────────────

def fetch_tasks(base_url):
    """任务状态来自 GET /api/air 的 tasks[]（2026-09-27 删旧看板后没有别的出口）。

    注意两代字段名：/api/air 用 sessionId（没有 chatSessionId）、活动时间叫
    lastMessageAt（没有 lastWorkAt）。下游一律读旧名字，所以只在这一处边界对齐 ——
    否则按会话排除会静默失效，配置看着还在、其实一条都拦不住。
    """
    status, body, raw = request_json(base_url, 'GET', '/api/air')
    if status != 200:
        raise RuntimeError('GET /api/air → HTTP %s' % status)
    tasks = body.get('tasks') if isinstance(body, dict) else None
    if not isinstance(tasks, list):
        raise RuntimeError('GET /api/air 返回体里没有 tasks 数组')
    normalized = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        merged = dict(task)
        merged['chatSessionId'] = task.get('chatSessionId') or task.get('sessionId') or None
        merged['lastWorkAt'] = task.get('lastWorkAt') or task.get('lastMessageAt') or None
        normalized.append(merged)
    return normalized


def is_excluded(cfg, task):
    task_id = str(task.get('id') or '')
    session_id = str(task.get('chatSessionId') or '')
    if cfg['relayTaskId'] and task_id == cfg['relayTaskId']:
        return True
    if cfg['relaySessionId'] and session_id == cfg['relaySessionId']:
        return True
    if task_id in (cfg['excludeTaskIds'] or []):
        return True
    if session_id and session_id in (cfg['excludeSessionIds'] or []):
        return True
    title = str(task.get('title') or '')
    return any(title.startswith(prefix) for prefix in (cfg['excludeTitlePrefixes'] or []))


def is_live(task):
    """只提醒「还没收摊」的任务：done/archived 的卡片留着旧的 error 判词，报出来是噪音。"""
    if task.get('deleting') is True:
        return False
    return str(task.get('status') or 'active') in ('active', 'open', 'todo')


def watch_state_of(cfg, task):
    state = str(task.get('runState') or '').strip()
    if not state:
        return None
    spec = (cfg['watchStates'] or {}).get(state)
    if not spec:
        return None
    if isinstance(spec, dict):
        return {'state': state, 'label': spec.get('label') or state}
    return {'state': state, 'label': state}


# ── 文案 ─────────────────────────────────────────────────────────────────────

def truncate(text, limit):
    value = ' '.join(str('' if text is None else text).split())
    return value[:limit - 1] + '…' if len(value) > limit else value


def local_stamp(now):
    return now.strftime('%Y-%m-%d %H:%M')


def build_batch(cfg, items, now):
    """一轮扫描里所有到点的提醒合并成**一条**微信消息再投递。

    为什么合并：一批会话（比如服务重启后）会在同一分钟里同时结算成 error，一条一条
    发就是往群里刷屏。合并后一轮最多一条，摘不下就写「等 N 个」。
    """
    by_state = {}
    for item in items:
        by_state.setdefault(item['watched']['state'], []).append(item)

    head = ('⚠️ MultiCC · %s' % items[0]['watched']['label']) if len(items) == 1 \
        else ('⚠️ MultiCC · %d 个任务要看一下' % len(items))
    lines = [head]
    for state, group in by_state.items():
        label = (cfg['watchStates'].get(state) or {}).get('label') or state
        if len(by_state) > 1:
            lines.append('【%s】%d 个' % (label, len(group)))
        for item in group[:MAX_LINES_PER_MESSAGE]:
            lines.append('· %s' % truncate(item['task'].get('title') or item['task'].get('id') or '(无标题)', 60))
        if len(group) > MAX_LINES_PER_MESSAGE:
            lines.append('· …等 %d 个' % len(group))
    lines.append('时间：%s' % local_stamp(now))
    wechat_text = '\n'.join(lines)

    detail = '\n'.join(
        '  [%s] %s  会话 %s  最近活动 %s' % (
            item['watched']['state'], truncate(item['task'].get('title'), 60),
            item['task'].get('chatSessionId') or '-', item['task'].get('lastWorkAt') or '-')
        for item in items)
    relay_text = '\n'.join([
        '【MultiCC 自动提醒工单】',
        '本轮共 %d 条提醒：' % len(items),
        detail,
        '',
        '请用 multicc computer use 把下面「---」之间的内容原样发送到微信群「%s」，' % cfg['wechatGroup'],
        '发送成功后只回一行「已发送」，不要复述内容。',
        '',
        '---',
        wechat_text,
        '---',
    ])
    return {'wechatText': wechat_text, 'relayText': relay_text, 'count': len(items)}


def dispatch_alert(cfg, text, client_schedule_id):
    if not cfg['relaySessionId']:
        raise RuntimeError('配置里没有 relaySessionId，提醒无人可投')
    path = '/api/sessions/%s/scheduled-messages' % urllib.parse.quote(str(cfg['relaySessionId']), safe='')
    status, _body, raw = request_json(cfg['baseUrl'], 'POST', path, {
        'message': text,
        'delaySeconds': cfg['dispatchDelaySeconds'],
        'clientScheduleId': client_schedule_id,
    })
    if status not in (200, 201):
        raise RuntimeError('投递失败 HTTP %s: %s' % (status, truncate(raw, 300)))


# ── 一轮 ─────────────────────────────────────────────────────────────────────

def recent_alert_count(state, window_ms):
    since = int(datetime.now().timestamp() * 1000) - window_ms
    return len([entry for entry in state['alerts'] if int(entry.get('at') or 0) >= since])


def scan(cfg, state, dry_run, now_ms):
    tasks = fetch_tasks(cfg['baseUrl'])
    seen = set()
    pending = []

    for task in tasks:
        if not is_live(task) or is_excluded(cfg, task):
            continue
        watched = watch_state_of(cfg, task)
        if not watched:
            continue
        task_id = str(task.get('id'))
        seen.add(task_id)

        prev = state['tasks'].get(task_id)
        changed = (not prev) or prev.get('state') != watched['state']
        repeat_ms = int(cfg['reAlertAfterMinutes'] or 0) * 60000
        due_for_repeat = (not changed) and repeat_ms > 0 and prev is not None \
            and now_ms - int(prev.get('lastAlertAt') or 0) >= repeat_ms
        if state['primed'] and (changed or due_for_repeat):
            pending.append({'task': task, 'watched': watched, 'repeat': not changed})

    # 这一轮该写成什么样，先算好**但不落盘**。离开提醒集合的任务自然被丢掉（记录
    # 没了，它以后再变回 error/waiting 会重新提醒）。
    #
    # 为什么不当场写：被频率闸拦下的那批提醒要留在 pending 里下一轮再来，而判据是
    # 「state 变了」。要是这轮就把新 state 记进去，下一轮 changed 恒为 false，那批
    # 提醒就再也不会来了 —— 静默丢掉，正是「宁可晚到也不能丢」要防的那件事。
    snapshot = {}
    for task in tasks:
        task_id = str(task.get('id'))
        if task_id not in seen:
            continue
        snapshot[task_id] = dict(state['tasks'].get(task_id) or {}, **{
            'state': str(task.get('runState')), 'title': truncate(task.get('title'), 60), 'at': now_ms,
        })

    if not state['primed']:
        state['primed'] = True
        state['tasks'] = snapshot
        return {'alerted': 0, 'primed': True,
                'message': '首轮扫描：%d 个任务处于提醒状态，已记为已知（不补发历史提醒）' % len(seen)}

    if not pending:
        state['tasks'] = snapshot
        return {'alerted': 0, 'primed': False,
                'message': '无变化：%d 个任务在提醒集合里，本轮没有新提醒' % len(seen)}

    waiting = {str(item['task'].get('id')) for item in pending}
    previous = state['tasks']

    def hold(message, count):
        """压住一轮：pending 的任务保留旧 state（下一轮原样端上来），其余照常记账。"""
        state['tasks'] = {tid: value for tid, value in snapshot.items() if tid not in waiting}
        for task_id in waiting:
            if task_id in previous:
                state['tasks'][task_id] = previous[task_id]
        return {'alerted': 0, 'primed': False, 'held': count, 'message': message}

        return {'alerted': 0, 'primed': False,
                'message': '无变化：%d 个任务在提醒集合里，本轮没有新提醒' % len(seen)}

    batch = build_batch(cfg, pending, datetime.now())
    if dry_run:
        # 彩排：只打印将投递的内容，不改状态，方便反复跑。
        return {'alerted': 0, 'primed': False, 'held': len(pending),
                'message': '[dry-run] 本应投递 %d 条提醒：%s' % (batch['count'], batch['wechatText'].replace('\n', ' / '))}

    # 总闸 + 频率闸。任何一种拦住时都**不推进** lastAlertAt、也不推进那几条的 state，
    # 这样下一轮会原样把同一批提醒端上来；被拦住的提醒宁可晚到，也不能悄悄丢掉。
    if not cfg['enabled']:
        return hold('[未启用 enabled] 本轮有 %d 条提醒，只记录不发送' % batch['count'], len(pending))
    since_last = now_ms - int(state.get('lastDispatchAt') or 0)
    if since_last < int(cfg['minDispatchIntervalMs'] or 0):
        return hold('距上次投递仅 %ds（下限 %ds），本轮 %d 条压到下一轮'
                    % (since_last // 1000, int(cfg['minDispatchIntervalMs'] or 0) // 1000, len(pending)),
                    len(pending))
    if recent_alert_count(state, 3600000) >= int(cfg['maxAlertsPerHour'] or 0):
        return hold('一小时内的提醒数已达上限 %d，本轮 %d 条压到下一轮'
                    % (int(cfg['maxAlertsPerHour']), len(pending)), len(pending))

    dispatch_alert(cfg, batch['relayText'], 'wechat-alert-batch-%d' % now_ms)
    state['tasks'] = snapshot
    for item in pending:
        task_id = str(item['task']['id'])
        state['tasks'][task_id] = dict(state['tasks'].get(task_id) or {}, lastAlertAt=now_ms)
    state['lastDispatchAt'] = now_ms
    state['alerts'].append({
        'at': now_ms,
        'count': batch['count'],
        'states': sorted({item['watched']['state'] for item in pending}),
        'titles': [truncate(item['task'].get('title'), 60) for item in pending],
        'wechatText': batch['wechatText'],
    })
    if len(state['alerts']) > MAX_ALERTS_KEPT:
        state['alerts'] = state['alerts'][-MAX_ALERTS_KEPT:]
    return {'alerted': 1, 'primed': False,
            'message': '已投递 1 条合并提醒（含 %d 个任务）→ 中转任务：%s'
                       % (batch['count'], batch['wechatText'].replace('\n', ' / '))}


def main():
    parser = argparse.ArgumentParser(description='MultiCC 异常微信提醒（定时脚本任务示例）')
    parser.add_argument('--config', default=os.path.expanduser('~/.multicc/wechat-alert/config-cron.json'),
                        help='配置文件路径（JSON）')
    parser.add_argument('--base-url', dest='baseUrl', help='覆盖配置里的 baseUrl')
    parser.add_argument('--relay-task-id', dest='relayTaskId', help='覆盖配置里的 relayTaskId')
    parser.add_argument('--relay-session-id', dest='relaySessionId', help='覆盖配置里的 relaySessionId')
    parser.add_argument('--group', dest='wechatGroup', help='覆盖配置里的 wechatGroup')
    parser.add_argument('--state', help='状态文件路径（默认取配置文件里的 stateFile）')
    parser.add_argument('--enabled', dest='enabled', action='store_true', default=None, help='强制开启投递')
    parser.add_argument('--disabled', dest='enabled', action='store_false', default=None, help='只记录不投递')
    parser.add_argument('--dry-run', dest='dryRun', action='store_true', help='只打印将投递什么，不改状态、不投递')
    args = parser.parse_args()

    config_path = os.path.expanduser(args.config) if args.config else ''
    cfg = load_config(config_path)
    for key in ('baseUrl', 'relayTaskId', 'relaySessionId', 'wechatGroup'):
        value = getattr(args, key)
        if value:
            cfg[key] = value
    if args.enabled is not None:
        cfg['enabled'] = args.enabled

    path = state_path(cfg, config_path, args.state)
    state = load_state(path)
    now_ms = int(datetime.now().timestamp() * 1000)

    try:
        result = scan(cfg, state, args.dryRun, now_ms)
    except (RuntimeError, urllib.error.URLError, OSError) as error:
        print('wechat-alert: %s' % error, file=sys.stderr)
        return 1
    # dry-run 什么都不改，状态文件一个字节都不动（否则彩排会把 primed 吃掉）。
    if not args.dryRun:
        save_state(path, state)
    print(result['message'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
