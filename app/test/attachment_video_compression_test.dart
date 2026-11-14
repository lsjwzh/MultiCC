import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/attachment_picker.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/video_compression');
  late Directory dir;
  late File original;
  late File output;
  var calls = 0;

  setUp(() async {
    await I18n.init('zh');
    dir = await Directory.systemTemp.createTemp('attachment-test-');
    original = File('${dir.path}/original.mov');
    output = File('${dir.path}/compressed.mp4');
    final handle = await original.open(mode: FileMode.write);
    await handle.truncate(25 * 1024 * 1024);
    await handle.close();
    calls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls++;
          expect(call.method, 'compress');
          expect(call.arguments['path'], original.path);
          expect(call.arguments['maxBytes'], 25 * 1024 * 1024 - 1);
          await output.writeAsBytes([1, 2, 3]);
          return output.path;
        });
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    await dir.delete(recursive: true);
  });

  test(
    'compresses a video at the server limit and preserves the original',
    () async {
      final prepared = await prepareChatAttachment(
        PickedAttachment(path: original.path, filename: 'clip.mov'),
        isIOS: true,
        channel: channel,
      );
      expect(calls, 1);
      expect(prepared.filename, 'clip.mp4');
      expect(prepared.mimeType, 'video/mp4');
      expect(prepared.temporary, isTrue);
      expect(await original.length(), 25 * 1024 * 1024);
      expect(await File(prepared.path!).readAsBytes(), [1, 2, 3]);
    },
  );

  test('leaves small videos and large non-video files unchanged', () async {
    final small = File('${dir.path}/small.mp4');
    await small.writeAsBytes([1]);
    final video = PickedAttachment(path: small.path, filename: 'small.mp4');
    final document = PickedAttachment(path: original.path, filename: 'doc.pdf');
    expect(
      await prepareChatAttachment(video, isIOS: true, channel: channel),
      same(video),
    );
    expect(
      await prepareChatAttachment(document, isIOS: true, channel: channel),
      same(document),
    );
    expect(calls, 0);
  });

  test('reports failure and removes an oversized compressed result', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (_) async {
          final handle = await output.open(mode: FileMode.write);
          await handle.truncate(25 * 1024 * 1024);
          await handle.close();
          return output.path;
        });
    await expectLater(
      prepareChatAttachment(
        PickedAttachment(path: original.path, filename: 'clip.mov'),
        isIOS: true,
        channel: channel,
      ),
      throwsA(predicate((e) => e.toString().contains('视频压缩失败'))),
    );
    expect(await original.exists(), isTrue);
    expect(await output.exists(), isFalse);
  });

  test('uploads a prepared file and removes its temporary copy', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    await output.writeAsBytes([1, 2, 3]);
    final client = MockClient((request) async {
      expect(request.headers['content-type'], contains('multipart/form-data'));
      expect(request.bodyBytes, containsAllInOrder([1, 2, 3]));
      return http.Response(
        '{"path":"/server/clip.mp4","name":"clip.mp4"}',
        200,
      );
    });
    final uploaded = await uploadChatAttachment(
      settings: settings,
      picked: PickedAttachment(
        path: output.path,
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        temporary: true,
      ),
      httpClient: client,
    );
    expect(uploaded.path, '/server/clip.mp4');
    expect(await output.exists(), isFalse);
    expect(await original.exists(), isTrue);
    client.close();
  });

  test('removes the temporary copy when upload fails', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    await output.writeAsBytes([1, 2, 3]);
    final client = MockClient((_) async => http.Response('error', 500));
    await expectLater(
      uploadChatAttachment(
        settings: settings,
        picked: PickedAttachment(
          path: output.path,
          filename: 'clip.mp4',
          temporary: true,
        ),
        httpClient: client,
      ),
      throwsException,
    );
    expect(await output.exists(), isFalse);
    expect(await original.exists(), isTrue);
    client.close();
  });
}
