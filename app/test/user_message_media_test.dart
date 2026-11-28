import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/message_quote.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/utils/user_message_media.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

// Valid 1x1 transparent PNG bytes so Image.network decodes cleanly in widget tests.
final Uint8List _kTransparentPng = Uint8List.fromList(const <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

class _RecordedImageRequest {
  final Uri uri;
  final Map<String, String> headers;
  const _RecordedImageRequest(this.uri, this.headers);
}

class _FakeHttpOverrides extends HttpOverrides {
  final List<_RecordedImageRequest> requests = [];

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _FakeHttpClient(requests);
}

class _FakeHttpClient implements HttpClient {
  final List<_RecordedImageRequest> requests;
  _FakeHttpClient(this.requests);

  @override
  bool autoUncompress = true;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async =>
      _FakeHttpClientRequest(url, requests);

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      _FakeHttpClientRequest(url, requests);

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientRequest implements HttpClientRequest {
  final Uri _uri;
  final List<_RecordedImageRequest> _requests;
  final _FakeHttpHeaders _headers = _FakeHttpHeaders();

  _FakeHttpClientRequest(this._uri, this._requests);

  @override
  HttpHeaders get headers => _headers;

  @override
  Future<HttpClientResponse> close() async {
    _requests.add(_RecordedImageRequest(_uri, Map.of(_headers.values)));
    return _FakeHttpClientResponse(_kTransparentPng);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpHeaders implements HttpHeaders {
  final Map<String, String> values = {};

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {
    values[name] = value.toString();
  }

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    values[name] = value.toString();
  }

  @override
  void forEach(void Function(String name, List<String> values) action) {
    values.forEach((k, v) => action(k, [v]));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  final Uint8List _bytes;
  _FakeHttpClientResponse(this._bytes);

  @override
  int get statusCode => HttpStatus.ok;

  @override
  int get contentLength => _bytes.length;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.fromIterable(<List<int>>[_bytes]).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;

  setUpAll(() async {
    await I18n.init('zh');
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:3000',
      'multicc_token': 'secret-token',
    });
    settings = await SettingsService.getInstance();
  });

  group('parseUserMessageMedia', () {
    test('returns plain text untouched when no media path is present', () {
      const raw = '  帮我整理一下今天的待办清单  ';
      final parsed = parseUserMessageMedia(raw);
      expect(parsed.hasMedia, isFalse);
      expect(parsed.media, isEmpty);
      expect(parsed.displayText, raw);
    });

    test('parses App chat message with text + uploaded image and image-only', () {
      final withText = parseUserMessageMedia(
        '看看这张图 /var/folders/ab/T/multicc_123_abcd1234.png',
      );
      expect(withText.hasMedia, isTrue);
      expect(withText.displayText, '看看这张图');
      expect(withText.media, hasLength(1));
      expect(withText.media.first.kind, UserMessageMediaKind.image);
      expect(
        withText.media.first.path,
        '/var/folders/ab/T/multicc_123_abcd1234.png',
      );
      expect(withText.media.first.displayName, 'multicc_123_abcd1234.png');
      expect(withText.media.first.remoteUrl, isNull);

      final imageOnly = parseUserMessageMedia('/tmp/multicc_1_aa.jpg');
      expect(imageOnly.hasMedia, isTrue);
      expect(imageOnly.displayText, isEmpty);
      expect(imageOnly.media, hasLength(1));
      expect(imageOnly.media.first.kind, UserMessageMediaKind.image);
      expect(imageOnly.media.first.path, '/tmp/multicc_1_aa.jpg');
      expect(imageOnly.media.first.displayName, 'multicc_1_aa.jpg');
    });

    test('parses multiple space-separated images and deduplicates by path', () {
      final parsed = parseUserMessageMedia(
        '对比一下 /tmp/a.png /tmp/b.JPG /tmp/a.png /Users/me/c.heic',
      );
      expect(parsed.displayText, '对比一下');
      expect(parsed.media.map((m) => m.path).toList(), [
        '/tmp/a.png',
        '/tmp/b.JPG',
        '/Users/me/c.heic',
      ]);
      expect(
        parsed.media.every((m) => m.kind == UserMessageMediaKind.image),
        isTrue,
      );
    });

    test('parses Air attachment block and drops orphaned 附件： label', () {
      final parsed = parseUserMessageMedia(
        '修复按钮\n\n附件：/tmp/multicc_1_aa.png /tmp/multicc_2_bb.pdf',
      );
      expect(parsed.displayText, '修复按钮');
      expect(parsed.media, hasLength(2));
      expect(parsed.media[0].kind, UserMessageMediaKind.image);
      expect(parsed.media[0].path, '/tmp/multicc_1_aa.png');
      expect(parsed.media[0].displayName, 'multicc_1_aa.png');
      expect(parsed.media[1].kind, UserMessageMediaKind.file);
      expect(parsed.media[1].path, '/tmp/multicc_2_bb.pdf');
      expect(parsed.media[1].displayName, 'multicc_2_bb.pdf');
    });

    test('parses English Attachments: line and non-temp files inside it', () {
      final single = parseUserMessageMedia('Attachments: /tmp/a.png');
      expect(single.displayText, isEmpty);
      expect(single.media, hasLength(1));
      expect(single.media.first.kind, UserMessageMediaKind.image);
      expect(single.media.first.path, '/tmp/a.png');

      final mixed = parseUserMessageMedia(
        'Please inspect\n\nAttachments: /Users/me/docs/spec.pdf',
      );
      expect(mixed.displayText, 'Please inspect');
      expect(mixed.media, hasLength(1));
      expect(mixed.media.first.kind, UserMessageMediaKind.file);
      expect(mixed.media.first.path, '/Users/me/docs/spec.pdf');
      expect(mixed.media.first.displayName, 'spec.pdf');
    });

    test('parses Markdown image/link, /api/download, file://, and Windows paths', () {
      final md = parseUserMessageMedia(
        '看截图 ![shot](/Users/me/shot.png) 和 ![spaced](</Users/me/my shot.png>)',
      );
      expect(md.displayText, '看截图 和');
      expect(md.media.map((m) => m.path).toList(), [
        '/Users/me/shot.png',
        '/Users/me/my shot.png',
      ]);

      final download = parseUserMessageMedia(
        '原图 /api/download?path=%2Ftmp%2Fx.png&inline=1',
      );
      expect(download.displayText, '原图');
      expect(download.media, hasLength(1));
      expect(download.media.first.kind, UserMessageMediaKind.image);
      expect(download.media.first.path, '/tmp/x.png');
      expect(download.media.first.displayName, 'x.png');
      expect(
        download.media.first.remoteUrl,
        '/api/download?path=%2Ftmp%2Fx.png&inline=1',
      );

      final absDownload = parseUserMessageMedia(
        '[查看](https://multicc.example/api/download?path=%2Ftmp%2Fy.webp&inline=1)',
      );
      expect(absDownload.displayText, isEmpty);
      expect(absDownload.media, hasLength(1));
      expect(absDownload.media.first.path, '/tmp/y.webp');
      expect(absDownload.media.first.displayName, 'y.webp');

      final fileUri = parseUserMessageMedia('file:///tmp/b.webp');
      expect(fileUri.displayText, isEmpty);
      expect(fileUri.media, hasLength(1));
      expect(fileUri.media.first.path, '/tmp/b.webp');
      expect(fileUri.media.first.displayName, 'b.webp');

      final windows = parseUserMessageMedia(r'看看 C:\Users\me\c.jpg');
      expect(windows.displayText, '看看');
      expect(windows.media, hasLength(1));
      expect(windows.media.first.kind, UserMessageMediaKind.image);
      expect(windows.media.first.path, r'C:\Users\me\c.jpg');
      expect(windows.media.first.displayName, 'c.jpg');
    });

    test('preserves [annotation] block src= metadata while extracting trailing image', () {
      const raw =
          '[annotation] src=/tmp/orig.png\n1. (12,34) 把这里改蓝\n[/annotation] /tmp/multicc_9_deadbeef.png';
      final parsed = parseUserMessageMedia(raw);
      expect(parsed.hasMedia, isTrue);
      expect(
        parsed.displayText,
        '[annotation] src=/tmp/orig.png\n1. (12,34) 把这里改蓝\n[/annotation]',
      );
      expect(parsed.media, hasLength(1));
      expect(parsed.media.first.kind, UserMessageMediaKind.image);
      expect(parsed.media.first.path, '/tmp/multicc_9_deadbeef.png');
      expect(parsed.media.first.displayName, 'multicc_9_deadbeef.png');
    });

    test('does not swallow plain code/doc paths or external image URLs', () {
      const codeMsg = '帮我改 /Users/me/app/server.js 里的 bug';
      final parsedCode = parseUserMessageMedia(codeMsg);
      expect(parsedCode.hasMedia, isFalse);
      expect(parsedCode.displayText, codeMsg);

      const backtickCode = '帮我看看 `/Users/me/app/server.js` 第 20 行';
      final parsedBacktick = parseUserMessageMedia(backtickCode);
      expect(parsedBacktick.hasMedia, isFalse);
      expect(parsedBacktick.displayText, backtickCode);

      const externalUrl = '参考 https://example.com/data/diagram.png 的结构';
      final parsedExternal = parseUserMessageMedia(externalUrl);
      expect(parsedExternal.hasMedia, isFalse);
      expect(parsedExternal.displayText, externalUrl);
    });

    test('strips matching backticks or quotes around extracted bare image path', () {
      final parsed = parseUserMessageMedia('看看 `/tmp/shot.png`');
      expect(parsed.displayText, '看看');
      expect(parsed.media, hasLength(1));
      expect(parsed.media.first.path, '/tmp/shot.png');
    });
  });

  group('User bubble widget rendering', () {
    // NetworkImage caches its HttpClient instance once per VM process, so share
    // a single HttpOverrides recorder across widget tests and clear per test.
    final fakeHttp = _FakeHttpOverrides();

    setUp(() {
      fakeHttp.requests.clear();
      PaintingBinding.instance.imageCache.clear();
      PaintingBinding.instance.imageCache.clearLiveImages();
    });

    Widget wrapBubble(ChatMessage message, {SettingsService? overrideSettings}) {
      return Provider<SettingsService?>.value(
        value: overrideSettings ?? settings,
        child: MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: MessageBubble(message: message)),
          ),
        ),
      );
    }

    testWidgets(
      'hides raw image path, shows clean text + clickable preview, sends header auth, and opens fullscreen viewer',
      (tester) async {
        await HttpOverrides.runZoned(() async {
          final msg = ChatMessage(
            id: 'm_img_1',
            role: MessageRole.user,
            content: '看看这张图 /var/folders/ab/T/multicc_123_abcd1234.png',
          );

          await tester.pumpWidget(wrapBubble(msg));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();

          expect(find.text('看看这张图'), findsOneWidget);
          expect(find.textContaining('/var/folders/'), findsNothing);
          expect(
            find.byKey(const ValueKey('user-message-image-0')),
            findsOneWidget,
          );

          // Image request routes through /api/download?inline=1 with header auth (never query token).
          expect(fakeHttp.requests, isNotEmpty);
          final req = fakeHttp.requests.first;
          expect(req.uri.path, '/api/download');
          expect(
            req.uri.queryParameters['path'],
            '/var/folders/ab/T/multicc_123_abcd1234.png',
          );
          expect(req.uri.queryParameters['inline'], '1');
          expect(req.uri.queryParameters.containsKey('token'), isFalse);
          expect(req.headers['X-Access-Token'], 'secret-token');

          // Copy and quote still preserve the original message content.
          expect(messageCopyText(msg), msg.content);
          expect(
            buildMessageQuote(msg),
            contains('/var/folders/ab/T/multicc_123_abcd1234.png'),
          );

          // Tap preview -> opens fullscreen zoom viewer with annotate & reset actions.
          await tester.tap(find.byKey(const ValueKey('user-message-image-0')));
          await tester.pump();
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump(const Duration(milliseconds: 400));

          expect(find.byTooltip('重置缩放'), findsOneWidget);
          expect(find.byIcon(Icons.edit_outlined), findsOneWidget);
          expect(find.text('multicc_123_abcd1234.png'), findsWidgets);
        }, createHttpClient: fakeHttp.createHttpClient);
      },
    );

    testWidgets(
      'renders multiple user images as clickable grid tiles',
      (tester) async {
        await HttpOverrides.runZoned(() async {
          final msg = ChatMessage(
            role: MessageRole.user,
            content: '/tmp/multicc_1_aa.png /tmp/multicc_2_bb.jpg',
          );

          await tester.pumpWidget(wrapBubble(msg));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();

          expect(find.textContaining('/tmp/multicc_'), findsNothing);
          expect(
            find.byKey(const ValueKey('user-message-image-0')),
            findsOneWidget,
          );
          expect(
            find.byKey(const ValueKey('user-message-image-1')),
            findsOneWidget,
          );
          expect(fakeHttp.requests.length, greaterThanOrEqualTo(2));
        }, createHttpClient: fakeHttp.createHttpClient);
      },
    );

    testWidgets(
      'assistant markdown supports relative /api/download?path=... images with header auth',
      (tester) async {
        await HttpOverrides.runZoned(() async {
          final msg = ChatMessage(
            role: MessageRole.assistant,
            content: '![shot](/api/download?path=%2Ftmp%2Fchart.png&inline=1)',
          );

          await tester.pumpWidget(wrapBubble(msg));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();

          expect(fakeHttp.requests, isNotEmpty);
          final req = fakeHttp.requests.first;
          expect(req.uri.host, '127.0.0.1');
          expect(req.uri.port, 3000);
          expect(req.uri.path, '/api/download');
          expect(req.uri.queryParameters['path'], '/tmp/chart.png');
          expect(req.uri.queryParameters['inline'], '1');
          expect(req.headers['X-Access-Token'], 'secret-token');
        }, createHttpClient: fakeHttp.createHttpClient);
      },
    );

    testWidgets(
      'renders uploaded non-image file path as a clickable filename chip',
      (tester) async {
        final msg = ChatMessage(
          role: MessageRole.user,
          content:
              '请总结这个文档 /var/folders/ab/T/multicc_123_deadbeef.pdf',
        );

        await tester.pumpWidget(wrapBubble(msg));
        await tester.pump();

        expect(find.text('请总结这个文档'), findsOneWidget);
        expect(find.textContaining('/var/folders/'), findsNothing);
        expect(
          find.byKey(const ValueKey('user-message-file-0')),
          findsOneWidget,
        );
        expect(find.text('multicc_123_deadbeef.pdf'), findsOneWidget);
      },
    );

    testWidgets(
      'keeps plain text user messages identical to existing behavior',
      (tester) async {
        final msg = ChatMessage(
          role: MessageRole.user,
          content: '帮我改 /Users/me/app/server.js 里的 bug',
        );

        await tester.pumpWidget(wrapBubble(msg));
        await tester.pump();

        expect(
          find.text('帮我改 /Users/me/app/server.js 里的 bug'),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('user-message-image-0')), findsNothing);
        expect(find.byKey(const ValueKey('user-message-file-0')), findsNothing);
      },
    );
  });
}
