import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_directory_search.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUp(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    settings = await SettingsService.getInstance();
  });

  test(
    'search combines both corpora, deduplicates ids, scopes board by directory',
    () async {
      final requests = <Uri>[];
      final service = AirService(
        settings: settings,
        httpClient: MockClient((r) async {
          requests.add(r.url);
          return http.Response(
            jsonEncode({
              'ok': true,
              'results': r.url.path == '/api/task-board/search'
                  ? [
                      {'taskId': 'a'},
                      {'taskId': 'b'},
                    ]
                  : [
                      {
                        'taskIds': ['b', 'archived'],
                      },
                    ],
            }),
            200,
          );
        }),
      );
      expect(await service.searchTaskIds('正文', dirId: 'd1', fullText: true), [
        'a',
        'b',
        'archived',
      ]);
      expect(requests.first.queryParameters['dirId'], 'd1');
      expect(requests.first.queryParameters.containsKey('statuses'), isFalse);
      requests.clear();
      expect(await service.searchTaskIds('标题', dirId: 'd2', fullText: false), [
        'a',
        'b',
      ]);
      expect(requests, hasLength(1));
    },
  );

  test(
    'old directory replies cannot replace new results; reset/dispose fence pending requests',
    () async {
      final old = Completer<http.Response>();
      final started = Completer<void>();
      final search = AirDirectorySearch(
        AirService(
          settings: settings,
          httpClient: MockClient((r) async {
            if (r.url.queryParameters['q'] == 'old') {
              started.complete();
              return old.future;
            }
            return http.Response(
              '{"ok":true,"results":[{"taskId":"new"}]}',
              200,
            );
          }),
        ),
      );
      search.search('old', 'd1', false);
      await started.future;
      final changed = Completer<void>();
      search.addListener(() {
        if (!changed.isCompleted) changed.complete();
      });
      search.search('new', 'd2', false);
      await changed.future;
      expect(search.ids, ['new']);
      old.complete(
        http.Response('{"ok":true,"results":[{"taskId":"old"}]}', 200),
      );
      await Future<void>.delayed(Duration.zero);
      expect(search.ids, ['new']);
      search.search('next', 'd3', false);
      search.reset();
      expect(search.ids, isNull);
      expect(search.loading, isFalse);
      search.dispose();
    },
  );

  test(
    'API failure is explicit and leaves local title fallback available',
    () async {
      final search = AirDirectorySearch(
        AirService(
          settings: settings,
          httpClient: MockClient((_) async => http.Response('{}', 503)),
        ),
      );
      final changed = Completer<void>();
      search.addListener(changed.complete);
      search.search('query', 'd1', true);
      await changed.future;
      expect(search.failed, isTrue);
      expect(search.ids, isNull);
      expect(search.loading, isFalse);
      search.dispose();
    },
  );
}
