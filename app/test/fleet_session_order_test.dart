// Ordering contract for every fleet-internal session list.
//
// The lists used to be sorted by last interaction, so a session that streamed a
// single token jumped to the top of its group and the cards traded places under
// the user's finger. They are now in creation order.
//
// The functions under test are the real ones on the render path, not stand-ins:
// SessionManager.sessionsByKind is a one-line delegate to
// groupFleetSessionsByKind, and both it and the _SessionGroup widget order
// through orderFleetSessions. That matters — a test that only exercised the
// comparator would still pass if a call site quietly went back to sorting by
// activity. The web side has the mirror test in tests/test-manage-dashboard.js.
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/utils/manual_order.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';

Session _s(
  String id,
  String createdAt, {
  String? type,
  DateTime? lastActivity,
  String? dirId,
  SessionKind kind = SessionKind.chat,
}) => Session(
  id: id,
  createdAt: DateTime.parse(createdAt),
  lastActivity: lastActivity,
  type: type,
  dirId: dirId,
  kind: kind,
);

List<String> _order(List<Session> sessions) =>
    orderFleetSessions(sessions).map((s) => s.id).toList();

void main() {
  test('fleet sessions are oldest-first, commander pinned above them', () {
    final sessions = [
      _s('newest', '2026-03-03T00:00:00Z'),
      _s('oldest', '2026-03-01T00:00:00Z'),
      _s('cmdr', '2026-03-09T00:00:00Z', type: 'commander'),
      _s('middle', '2026-03-02T00:00:00Z'),
    ];
    // The commander is the newest of the four, so it only lands first if the
    // pin really does bypass the age comparison.
    expect(_order(sessions), ['cmdr', 'oldest', 'middle', 'newest']);
  });

  test('activity does not move a card', () {
    // Same createdAt values, wildly different lastActivity: the old comparator
    // would have reversed this list, the new one must not touch it.
    final sessions = [
      _s('a', '2026-03-01T00:00:00Z', lastActivity: DateTime(2020)),
      _s('b', '2026-03-02T00:00:00Z', lastActivity: DateTime(2030)),
      _s('c', '2026-03-03T00:00:00Z', lastActivity: DateTime(2025)),
    ];
    expect(_order(sessions), ['a', 'b', 'c']);
    expect(_order(sessions.reversed.toList()), ['a', 'b', 'c']);
  });

  test('equal createdAt breaks on id, so the order is reproducible', () {
    // Dart's List.sort is not stable — without the id tiebreak these two could
    // swap between two polls of the same unchanged data.
    final tie = [
      _s('b', '2026-03-05T00:00:00Z'),
      _s('a', '2026-03-05T00:00:00Z'),
    ];
    expect(_order(tie), ['a', 'b']);
    expect(_order(tie.reversed.toList()), ['a', 'b']);
    expect(compareSessionsByCreation(tie[0], tie[1]), greaterThan(0));
  });

  test('a fleet without a commander keeps plain creation order', () {
    final sessions = [
      _s('z', '2026-03-04T00:00:00Z'),
      _s('y', '2026-03-01T00:00:00Z'),
    ];
    expect(_order(sessions), ['y', 'z']);
  });

  // The call site itself, not just the comparator: SessionManager.sessionsByKind
  // is a one-liner over groupFleetSessionsByKind, so this is what the fleet
  // sheet actually renders.
  group('groupFleetSessionsByKind (the fleet sheet call site)', () {
    final fleet = [
      _s('chat-new', '2026-03-08T00:00:00Z', dirId: 'd1'),
      _s('term-new', '2026-03-09T00:00:00Z', dirId: 'd1', kind: SessionKind.terminal),
      _s('chat-cmdr', '2026-03-07T00:00:00Z', dirId: 'd1', type: 'commander'),
      _s('other-fleet', '2026-03-01T00:00:00Z', dirId: 'd2'),
      _s('chat-old', '2026-03-02T00:00:00Z', dirId: 'd1',
          lastActivity: DateTime(2030)),
      _s('term-old', '2026-03-03T00:00:00Z', dirId: 'd1', kind: SessionKind.terminal),
    ];
    List<String> idsOf(Map<String, List<Session>> g, String key) =>
        g[key]!.map((s) => s.id).toList();

    test('splits by kind, scopes to the directory, orders by creation', () {
      final groups = groupFleetSessionsByKind(fleet, 'd1');
      // chat-old has the newest lastActivity of the whole fleet and still sits
      // below the commander in creation order — activity buys no position.
      expect(idsOf(groups, 'chat'), ['chat-cmdr', 'chat-old', 'chat-new']);
      expect(idsOf(groups, 'terminal'), ['term-old', 'term-new']);
      // Another fleet's session never leaks in, whichever group it would land in.
      expect(idsOf(groups, 'chat'), isNot(contains('other-fleet')));
    });

    test('both groups exist even when the fleet has only one kind', () {
      final groups = groupFleetSessionsByKind(
        [_s('solo', '2026-03-01T00:00:00Z', dirId: 'd1')],
        'd1',
      );
      expect(idsOf(groups, 'chat'), ['solo']);
      expect(groups['terminal'], isEmpty);
    });

    test('an unknown directory yields two empty groups, not a null', () {
      final groups = groupFleetSessionsByKind(fleet, 'nope');
      expect(groups['chat'], isEmpty);
      expect(groups['terminal'], isEmpty);
    });

    test('a dragged order overrides creation order, per group', () {
      // One flat list covers both groups — that is how the server stores it
      // (sessionOrder[dirId]), and a session only ever lives in one group.
      final groups = groupFleetSessionsByKind(
        fleet,
        'd1',
        manualOrder: ['chat-new', 'chat-old', 'term-new', 'term-old'],
      );
      // chat-new is the newest chat and now leads its group — but under the
      // commander, which the drag does not get to displace.
      expect(idsOf(groups, 'chat'), ['chat-cmdr', 'chat-new', 'chat-old']);
      expect(idsOf(groups, 'terminal'), ['term-new', 'term-old']);
    });

    test('a session created after the last drag lands at the end', () {
      final withNewcomer = [
        ...fleet,
        _s('chat-newcomer', '2026-03-01T00:00:00Z', dirId: 'd1'),
      ];
      // The newcomer is the OLDEST chat in the fleet, so creation order alone
      // would put it first. It was not on screen when the user dragged, so it
      // must not push into the arrangement they made.
      final groups = groupFleetSessionsByKind(
        withNewcomer,
        'd1',
        manualOrder: ['chat-new', 'chat-old', 'chat-cmdr'],
      );
      expect(idsOf(groups, 'chat'),
          ['chat-cmdr', 'chat-new', 'chat-old', 'chat-newcomer']);
    });

    test('an order naming sessions that are gone still ranks the rest', () {
      final groups = groupFleetSessionsByKind(
        fleet,
        'd1',
        manualOrder: ['deleted-one', 'chat-new', 'other-fleet'],
      );
      expect(idsOf(groups, 'chat'), ['chat-cmdr', 'chat-new', 'chat-old']);
    });
  });

  // The pure helpers the drag handlers call. They have a byte-for-byte twin in
  // public/ui-layout-store.js: both clients read the same server document, so a
  // divergence here means "arranged on the phone, looks different on the web".
  group('manual order helpers', () {
    test('applyManualOrder keeps unranked items in the caller order', () {
      expect(
        applyManualOrder(['a', 'b', 'c', 'd'], ['c', 'a'], (s) => s),
        ['c', 'a', 'b', 'd'],
      );
      // No arrangement yet: the caller's order stands, untouched.
      expect(applyManualOrder(['a', 'b'], const [], (s) => s), ['a', 'b']);
      // Idempotent — the widget re-applies what the provider already applied.
      final once = applyManualOrder(['a', 'b', 'c'], ['b'], (s) => s);
      expect(applyManualOrder(once, ['b'], (s) => s), once);
    });

    test('reorderAround inserts after the target when dragging down', () {
      // The adjacent-downward drag: inserting before the target would make this
      // a no-op, which reads as "the drag did not take".
      expect(reorderAround(['a', 'b', 'c'], 'a', 'b'), ['b', 'a', 'c']);
      expect(reorderAround(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
      // Nothing to do, and nothing lost.
      expect(reorderAround(['a', 'b'], 'a', 'a'), ['a', 'b']);
      expect(reorderAround(['a', 'b'], 'ghost', 'a'), ['a', 'b']);
    });

    test('mergeGroupOrder does not discard the other group arrangement', () {
      // The user arranges the terminals, then the chats. Writing only the chat
      // group back would silently drop the terminal arrangement — one fleet,
      // one flat list.
      expect(
        mergeGroupOrder(['t2', 't1'], ['c2', 'c1']),
        ['c2', 'c1', 't2', 't1'],
      );
      // Re-dragging the same group replaces its own entries rather than
      // duplicating them.
      expect(mergeGroupOrder(['c1', 'c2'], ['c2', 'c1']), ['c2', 'c1']);
    });
  });
}
