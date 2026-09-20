import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

// 收起浮层（对话 / 目录详情）有两件事必须同时成立：① 先把滑落动画放完，再把浮层
// 从状态里摘掉（摘早了这一层会「啪」地消失，不是滑下去）；② 摘完之后要叫醒等在
// 那里的那个人 —— 首页 AppBar 的 ☰ 就是靠这一下，等浮层让开了才去拉抽屉。
// 这两个都是「看不见的时序」，靠读代码看不出来，所以在这里锁住。
void main() {
  // SessionManager 构造时就要 WidgetsBinding（它注册成观察者），离开 widget 测试
  // 也得先把 binding 立起来。
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<SessionManager> manager() async => SessionManager(
    settings: await SettingsService.getInstance(),
  );

  test('收起对话：浮层滑完之前不算完，滑完才通知', () async {
    final mgr = await manager();
    var animated = 0;
    var settled = false;
    mgr.chatCollapseHandler = () => animated++;

    final done = mgr.requestCloseChat().then((_) => settled = true);

    // 动画还没走完：状态不许提前动，等人也不许提前醒。
    expect(animated, 1, reason: '注册的滑落入口要被叫一次');
    expect(mgr.activeSessionId, isNull);
    expect(settled, isFalse, reason: '滑落没走完就开抽屉，会开在浮层底下');

    mgr.notifyLayerCollapsed();
    await done;
    expect(settled, isTrue);
  });

  test('浮层不在树上（没有注册）就直接收，也别让等的人吊着', () async {
    final mgr = await manager();
    await mgr.requestCloseChat();
    expect(mgr.activeSessionId, isNull);
  });

  test('目录详情走同一条路', () async {
    final mgr = await manager();
    var animated = 0;
    mgr.fleetCollapseHandler = () => animated++;

    final done = mgr.requestCloseFleetDir();
    expect(animated, 1);
    mgr.notifyLayerCollapsed();
    await done;
  });

  test('连着来两次（连点两下 ☰）：前一个也要落地，不留悬着的等待', () async {
    final mgr = await manager();
    var animated = 0;
    mgr.chatCollapseHandler = () => animated++;

    var firstSettled = false;
    final first = mgr.requestCloseChat().then((_) => firstSettled = true);
    final second = mgr.requestCloseChat();
    await first;
    expect(firstSettled, isTrue, reason: '第二个请求把第一个顶掉时，第一个也要有个结果');
    mgr.notifyLayerCollapsed();
    await second;
  });

  test('滑落入口不参与显示状态：换它不该惊动监听者', () async {
    final mgr = await manager();
    var notified = 0;
    mgr.addListener(() => notified++);
    mgr.chatCollapseHandler = () {};
    mgr.fleetCollapseHandler = () {};
    expect(notified, 0);
  });
}
