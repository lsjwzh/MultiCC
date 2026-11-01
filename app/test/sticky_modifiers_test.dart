import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_rfb.dart' show RfbKeysyms;
import 'package:multicc_app/services/sticky_modifiers.dart';

void main() {
  late DateTime now;
  late StickyModifiers sticky;

  setUp(() {
    now = DateTime(2026, 1, 1);
    sticky = StickyModifiers(
      clock: () => now,
      doubleTapWindow: const Duration(milliseconds: 320),
    );
  });

  StickyModifierKey chip(String id) =>
      StickyModifiers.definitions.singleWhere((d) => d.id == id);

  test('点一下 = 一次性：按下修饰键，用掉后自动放开', () {
    final shift = chip('shift');
    final first = sticky.tap(shift);
    expect(first.down, [shift]);
    expect(first.up, isEmpty);
    expect(sticky.stateOf('shift'), StickyModifierState.once);
    expect(shift.keysym, RfbKeysyms.shiftL);

    final used = sticky.consumeOneShots();
    expect(used.up, [shift]);
    expect(used.down, isEmpty);
    expect(sticky.stateOf('shift'), StickyModifierState.off);
    expect(sticky.anyActive, isFalse);
  });

  test('快速连点两下 = 锁定；锁定态不会被一次性消费掉', () {
    final cmd = chip('cmd');
    sticky.tap(cmd);
    now = now.add(const Duration(milliseconds: 120));
    final second = sticky.tap(cmd);
    // 键已经按着，第二下不再发 down/up。
    expect(second.down, isEmpty);
    expect(second.up, isEmpty);
    expect(sticky.stateOf('cmd'), StickyModifierState.locked);

    expect(sticky.consumeOneShots().up, isEmpty);
    expect(sticky.stateOf('cmd'), StickyModifierState.locked);
  });

  test('点亮后再点一下 = 放开；窗口外的第二下算放开而不是锁定', () {
    final alt = chip('alt');
    sticky.tap(alt);
    now = now.add(const Duration(milliseconds: 500));
    final off = sticky.tap(alt);
    expect(off.up, [alt]);
    expect(off.down, isEmpty);
    expect(sticky.stateOf('alt'), StickyModifierState.off);
  });

  test('HTTP mods 按服务端顺序 shift, ctrl, alt, cmd', () {
    for (final id in ['cmd', 'shift', 'alt', 'ctrl']) {
      sticky.tap(chip(id));
    }
    expect(sticky.httpNames, ['shift', 'ctrl', 'alt', 'cmd']);
  });

  test('releaseAll 放开所有点亮的修饰键（一次性 + 锁定）', () {
    sticky.tap(chip('shift'));
    sticky.tap(chip('cmd'));
    now = now.add(const Duration(milliseconds: 100));
    sticky.tap(chip('cmd')); // 锁定
    final all = sticky.releaseAll();
    expect(all.down, isEmpty);
    expect(all.up.map((c) => c.id).toSet(), {'shift', 'cmd'});
    expect(sticky.anyActive, isFalse);
    expect(sticky.releaseAll().up, isEmpty);
  });
}
