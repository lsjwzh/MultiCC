// 远控直达链接（multicc-human-assist 的 `#rs=control` / `#rs=1`）在 App 侧的判定。
//
// Web 端同一张表在 public/chat-remote-links.js 的 linkMode 里，行为用例在
// tests/test-chat-remote-links.js；两份实现必须同时认下这几种形态，否则会有
// 一端偷偷回退到浏览器 —— 那正是「发远控 link 时跳开了网页」这个 bug：
//
//   · 环回地址：agent 在服务器那台机器上跑，`MULTICC_BASE_URL` 常是
//     `http://127.0.0.1:3000`，于是它写出来的跨设备链接就是 127.0.0.1。手机上的
//     回环是手机自己，交给浏览器只会白屏 —— 这一类必须进原生屏幕页。
//   · 配置里没写 scheme（`192.168.1.9:3000`，用户手填的常见形态）时，同一个
//     host:port 的 https（穿透域名）也算这台服务器。
//
// 独立文件而不是并进 message_bubble_task_test.dart：SettingsService 是进程内
// 单例，一个文件只能钉一种服务器配置，那边的 host 固定是 127.0.0.1:3000。
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;
  setUp(() async {
    SharedPreferences.setMockInitialValues(
      {'multicc_host': '192.168.1.9:3000'},
    );
    settings = await SettingsService.getInstance();
    expect(settings.host, '192.168.1.9:3000');
  });

  test('loopback links from the agent open the native screen page', () {
    // agent 就在服务器那台机器上：它写的 127.0.0.1 与手机上配的服务器是同一个进程。
    expect(
      remoteScreenLinkMode(
        'http://127.0.0.1:3000/chat.html?air=1&task=t1&rs=control',
        settings,
      ),
      'control',
    );
    expect(
      remoteScreenLinkMode('http://127.0.0.1:3999/chat.html?rs=1', settings),
      '1',
      reason: '环回不看端口',
    );
    expect(
      remoteScreenLinkMode('http://localhost:3000/chat.html?rs=control', settings),
      'control',
    );
    expect(
      remoteScreenLinkMode('http://box.localhost:3000/chat.html?rs=1', settings),
      '1',
    );
    // Dart 的 Uri.host 对 IPv6 不带方括号（JS 的 URL.hostname 带）—— 带方括号的
    // 写法在这里必须仍然认出来。
    expect(Uri.parse('http://[::1]:3000/x').host, '::1');
    expect(
      remoteScreenLinkMode('http://[::1]:3000/chat.html?rs=control', settings),
      'control',
    );
    // 没有配置也该认环回（进不去原生页也不该甩给浏览器）。
    expect(
      remoteScreenLinkMode('http://127.0.0.1:3000/chat.html?rs=control', null),
      'control',
    );
  });

  test('the configured server is recognised, scheme-agnostically when unset', () {
    // 配置里没写 scheme：http / https 都算同一台（同一个 host:port 的穿透域名）。
    expect(
      remoteScreenLinkMode(
        'http://192.168.1.9:3000/chat.html?air=1&task=t1&rs=control',
        settings,
      ),
      'control',
    );
    expect(
      remoteScreenLinkMode(
        'https://192.168.1.9:3000/chat.html?air=1&task=t1&rs=control',
        settings,
      ),
      'control',
      reason: '配置没写 scheme 时不该要求 scheme 一致',
    );
    // Air 的对话帧地址也是聊天页。
    expect(
      remoteScreenLinkMode('http://192.168.1.9:3000/air?rs=1', settings),
      '1',
    );
    // root-relative 与 hash 形态（消息里最常见的那种）。
    expect(remoteScreenLinkMode('/chat.html?air=1&task=t1&rs=control', settings), 'control');
    expect(remoteScreenLinkMode('/chat.html?air=1&task=t1#rs=1', settings), '1');
    expect(remoteScreenLinkMode('#rs=control', settings), 'control');
    expect(remoteScreenLinkMode('#rs=1', settings), '1');
  });

  test('anything that is not this server keeps going to the browser', () {
    final cases = <String, String>{
      '别的机器': 'http://192.168.1.20:3000/chat.html?rs=control',
      '别的端口': 'http://192.168.1.9:8080/chat.html?rs=control',
      '外站': 'http://example.com/chat.html?rs=control',
      '非 http(s) scheme': 'ftp://127.0.0.1/chat.html?rs=control',
      'file scheme': 'file:///chat.html?rs=control',
      '不是聊天页': 'http://192.168.1.9:3000/manage?rs=control',
      '产物页': '/artifacts/abc/index.html?rs=control',
      '别的 rs 值': '#rs=2',
      '普通锚点': '#section-1',
      '没有 rs': 'http://192.168.1.9:3000/chat.html?air=1&task=t1',
      '空串': '   ',
    };
    for (final entry in cases.entries) {
      expect(remoteScreenLinkMode(entry.value, settings), isNull, reason: entry.key);
    }
    // 配置没写 scheme 时，同一个 host:port 之外的一律不认 —— 这类链接没有环回
    // 那条兜底，配置为空时连自家的也认不出来是刻意的（宁可交给浏览器）。
    expect(
      remoteScreenLinkMode('http://192.168.1.9:3000/chat.html?rs=control', null),
      isNull,
    );
  });
}
