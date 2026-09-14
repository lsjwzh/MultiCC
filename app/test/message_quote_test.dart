import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/message_quote.dart';

// 消息引用：引用块不只抄正文，还带上这条消息**整体所属的子任务**。
// Web 侧的同一套语义在 public/chat-quote.js（tests/test-chat-quote.js 20 项）；
// 这里是 Dart 端的镜像，两边必须说出同样的话 —— 一个客户端写的引用，另一个
// 客户端读起来不该变样。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));
  tearDown(() => I18n.switchLang('zh'));

  ChatMessage assistant({
    String content = '登录接口已经改成走统一网关。',
    String? id = 'm_abc',
    String? taskId = 'tsk_36ec81e8',
    String? taskName = '完善登录页面',
    String? sourceSessionId = 'codex-claude-chat-06',
    String? sourceMessageId = 'm_abc',
    DateTime? timestamp,
  }) =>
      ChatMessage(
        role: MessageRole.assistant,
        content: content,
        id: id,
        taskId: taskId,
        taskName: taskName,
        sourceSessionId: sourceSessionId,
        sourceMessageId: sourceMessageId,
        timestamp:
            timestamp ?? DateTime(2026, 9, 14, 9, 30),
      );

  test('表头带任务名与 id、角色、时间、消息身份', () {
    final quote = buildMessageQuote(assistant());
    final header = quote.split('\n').first;
    expect(header,
        '> 【引用】任务「完善登录页面」（tsk_36ec81e8） · 助手 · 09-14 09:30 · codex-claude-chat-06:m_abc');
    expect(quote.split('\n')[1], '> 登录接口已经改成走统一网关。');
  });

  test('消息身份是 <sessionId>:<messageId> —— 任务上下文接口认的句柄', () {
    final quote = buildMessageQuote(assistant(
      sourceSessionId: 'sess_a',
      sourceMessageId: 'm_7',
    ));
    expect(quote, contains('sess_a:m_7'));
  });

  test('没有 sourceSessionId 时身份退化成消息 id 本身', () {
    final quote = buildMessageQuote(assistant(
      id: 'm_7',
      sourceSessionId: null,
      sourceMessageId: null,
    ));
    expect(quote, contains(' · m_7'));
  });

  test('壳气泡的复合 id 不会被再接一次会话前缀', () {
    // 任务壳气泡 id 本身就是 <sessionId>:<messageId>；再拼一次会话名就会写出
    // 一个不存在的句柄（sess_a:sess_a:m_7）。
    final quote = buildMessageQuote(assistant(
      id: 'sess_a:m_7',
      sourceSessionId: 'sess_a',
      sourceMessageId: null,
    ));
    expect(quote, contains('sess_a:m_7'));
    expect(quote, isNot(contains('sess_a:sess_a')));
  });

  test('多行正文逐行加引用前缀', () {
    final quote = buildMessageQuote(assistant(
      content: '第一段。\n\n第二段：另外补了退避重试。',
    ));
    final body = quote.split('\n').skip(1).join('\n');
    // 空行也留一个 > —— 这正是 Web 的 quoteLines：整块引用挂在引用里，
    // 段落之间的空行不会把引用截断。
    expect(body, '> 第一段。\n>\n> 第二段：另外补了退避重试。');
  });

  test('没有任务归属时说「本会话」，不编一个任务名', () {
    final quote = buildMessageQuote(assistant(taskId: null, taskName: null));
    expect(quote, contains('【引用】本会话 ·'));
  });

  test('只有名字没有 id 时只报名字', () {
    final quote = buildMessageQuote(assistant(taskId: null));
    expect(quote, contains('任务「完善登录页面」'));
    expect(quote, isNot(contains('（')));
  });

  test('没有可指认的身份时说「未落库」', () {
    final quote = buildMessageQuote(assistant(
      id: null,
      sourceSessionId: null,
      sourceMessageId: null,
    ));
    expect(quote, contains('未落库'));
  });

  test('三种角色各自说对', () {
    expect(buildMessageQuote(assistant()), contains(' · 助手 ·'));
    expect(
      buildMessageQuote(ChatMessage(
        role: MessageRole.user,
        content: '改成走网关',
        id: 'm_1',
        timestamp: DateTime(2026, 9, 14, 9, 30),
      )),
      contains(' · 你 ·'),
    );
    expect(
      buildMessageQuote(ChatMessage(
        role: MessageRole.system,
        content: '会话已切换',
        id: 'm_2',
        timestamp: DateTime(2026, 9, 14, 9, 30),
      )),
      contains(' · 系统 ·'),
    );
  });

  test('英文目录下说英文', () {
    I18n.switchLang('en');
    final quote = buildMessageQuote(assistant());
    expect(quote, contains('> [quote] task "完善登录页面" (tsk_36ec81e8)'));
    expect(quote, contains(' · assistant · 09-14 09:30 · codex-claude-chat-06:m_abc'));
    final noTask = buildMessageQuote(assistant(taskId: null, taskName: null));
    expect(noTask, contains('this conversation'));
  });

  test('超长正文按 800 字截断，并写明原文字数', () {
    final long = '字' * 1200;
    final quote = buildMessageQuote(assistant(content: long));
    final lines = quote.split('\n');
    expect(lines[1], '> ${'字' * 800}');
    expect(lines[2], contains('原文共 1200 字'));
  });

  test('刚好 800 字不截断', () {
    final quote = buildMessageQuote(assistant(content: '字' * 800));
    expect(quote, isNot(contains('截断')));
    expect(quote.split('\n').length, 2);
  });

  test('空内容 / 空白内容不生成引用块', () {
    expect(buildMessageQuote(assistant(content: '')), '');
    expect(buildMessageQuote(assistant(content: '   \n  ')), '');
  });

  test('正文末尾的空白不落进引用块', () {
    final quote = buildMessageQuote(assistant(content: '  说完了。 \n'));
    expect(quote.split('\n')[1], '> 说完了。');
  });

  test('插进输入框：空草稿时引用块在上、留出空行', () {
    expect(composerTextWithQuote('', '> 【引用】…'), '> 【引用】…\n\n');
    expect(composerTextWithQuote('   ', '> 【引用】…'), '> 【引用】…\n\n');
  });

  test('插进输入框：已有草稿原样留在下面，不被覆盖', () {
    final merged = composerTextWithQuote('顺便把审核也做了', '> 【引用】…');
    expect(merged, '> 【引用】…\n\n顺便把审核也做了');
  });

  test('草稿前导空行不重复堆叠', () {
    final merged = composerTextWithQuote('\n\n顺便把审核也做了', '> 【引用】…');
    expect(merged, '> 【引用】…\n\n顺便把审核也做了');
  });

  test('late attribution：归属是后到的，落在同一条消息上', () {
    // 服务端在这一轮结束时才判定归属，那时气泡早画好了。applyAttribution 就是
    // 就地补打 —— 不重建列表，所以正在流式的那条不会被冲掉。
    final msg = ChatMessage(
      role: MessageRole.assistant,
      content: '结论',
      id: 'sess_a:m_9',
      sourceSessionId: 'sess_a',
      sourceMessageId: 'm_9',
      timestamp: DateTime(2026, 9, 14, 9, 30),
    );
    expect(buildMessageQuote(msg), contains('本会话'));

    msg.applyAttribution({
      'id': 'm_9',
      'turnId': 'turn_1',
      'taskId': 'tsk_1',
      'taskName': '完善登录页面',
      'auxRunId': null,
    });
    final quote = buildMessageQuote(msg);
    expect(quote, contains('任务「完善登录页面」（tsk_1）'));
    // 身份两半都还在：补打只补它知道的那几个字段。
    expect(quote, contains('sess_a:m_9'));
    expect(msg.turnId, 'turn_1');
    expect(msg.auxRunId, isNull);
  });

  test('补打不会用空值抹掉已经知道的字段', () {
    final msg = assistant(taskId: 'tsk_1', taskName: '完善登录页面');
    msg.applyAttribution({'turnId': 'turn_2', 'taskId': null, 'taskName': ''});
    expect(msg.taskId, 'tsk_1');
    expect(msg.taskName, '完善登录页面');
    expect(msg.turnId, 'turn_2');
  });

  test('历史回放直接带上归属字段', () {
    // 服务端的历史投影里本来就带这四个字段（src/routes/chat-history.js 的
    // publicCommittedMessage），所以重连后引用块仍然说得出这条消息属于谁。
    final msg = ChatMessage.fromHistory({
      'id': 'sess_a:m_3',
      'role': 'assistant',
      'content': '改完了',
      'ts': DateTime(2026, 9, 14, 9, 30).millisecondsSinceEpoch,
      'taskId': 'tsk_9',
      'taskName': '迁移数据库',
      'turnId': 'turn_9',
      'sourceSessionId': 'sess_a',
      'sourceMessageId': 'm_3',
    });
    final quote = buildMessageQuote(msg);
    expect(quote, contains('任务「迁移数据库」（tsk_9）'));
    expect(quote, contains('sess_a:m_3'));
  });

  test('历史里没有归属字段时不编造', () {
    final msg = ChatMessage.fromHistory({
      'id': 'm_1',
      'role': 'user',
      'content': '在吗',
      'ts': 0,
      'taskId': '',
    });
    expect(msg.taskId, isNull); // 空串与缺失同义：都是「不知道」
    expect(buildMessageQuote(msg), contains('本会话'));
  });

  test('两种语言目录里都真的存在这 11 条文案', () {
    // 引用块是拼装出来的，缺一条 key 不会报错 —— 它会把 key 本身印进引用里，
    // 而那种引用会一路发到模型和别的客户端手里。所以在两种语言里都点名。
    const keys = [
      'msgQuoteAction',
      'msgQuoteUnavailable',
      'msgQuoteHeader',
      'msgQuoteTask',
      'msgQuoteTaskNamed',
      'msgQuoteNoTask',
      'msgQuoteNoTrace',
      'msgQuoteRoleUser',
      'msgQuoteRoleAssistant',
      'msgQuoteRoleSystem',
      'msgQuoteTruncated',
    ];
    for (final lang in ['zh', 'en']) {
      I18n.switchLang(lang);
      for (final key in keys) {
        final value = t(key);
        expect(value, isNotEmpty, reason: '$lang 缺少 $key');
        expect(value, isNot(key), reason: '$lang 的 $key 没有落到目录里');
      }
    }
  });
}
