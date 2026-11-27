part of 'computer_spaces_shell.dart';

/// Shared geometry for the PageView placeholders and fixed live desktop slots.
class _OverviewGeometry {
  _OverviewGeometry(this.size, EdgeInsets padding)
      : top = padding.top + 94, bottom = padding.bottom + 56;
  final Size size;
  final double top, bottom;

  Rect preview(int index, double page) {
    final width = size.width * .76 - 20;
    final height = math.max(1.0, size.height - top - bottom - 164);
    final scale = math.min(width / size.width, height / size.height);
    final centerX = size.width / 2 + (index - page) * size.width * .76;
    return Rect.fromLTWH(centerX - size.width * scale / 2,
      top + 64 + (height - size.height * scale) / 2,
      size.width * scale, size.height * scale);
  }
}

extension _SpacesOverview on _ComputerSpacesShellState {
  Widget _overview(_OverviewGeometry geometry) => Stack(children: [
    Positioned(top: MediaQuery.paddingOf(context).top + 12, left: 24, right: 20,
      child: Row(children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t('spacesAllComputers'),
              style: const TextStyle(color: Colors.white, fontSize: 26,
                fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(t('spacesConnectedCount', {'count': '${_machines.length}'}),
              style: const TextStyle(color: Colors.white60, fontSize: 12)),
          ])),
        TextButton(key: const ValueKey('space-overview-back'),
          style: TextButton.styleFrom(foregroundColor: Colors.white,
            backgroundColor: Colors.white12),
          onPressed: exitOverview, child: Text(t('gitManagerBack'))),
      ])),
    Positioned(top: geometry.top, bottom: geometry.bottom, left: 0, right: 0,
      child: PageView.builder(
        key: const ValueKey('spaces-overview-gallery'),
        controller: _pages, itemCount: _machines.length + 1,
        itemBuilder: (context, index) => index == _machines.length
          ? _addCard()
          : _machineCard(_machines[index], geometry, index),
      )),
    Positioned(bottom: MediaQuery.paddingOf(context).bottom + 12,
      left: 16, right: 16,
      child: SingleChildScrollView(scrollDirection: Axis.horizontal,
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (var i = 0; i <= _machines.length; i++)
            Semantics(button: true,
              label: i == _machines.length ? t('airMachinesAdd') : _machines[i].name,
              selected: _page.round() == i,
              child: GestureDetector(
                key: ValueKey('space-overview-dot-$i'),
                behavior: HitTestBehavior.opaque,
                onTap: () => _pages.animateToPage(i,
                  duration: const Duration(milliseconds: 280), curve: Curves.easeOutCubic),
                child: Padding(padding: const EdgeInsets.all(10),
                  child: AnimatedContainer(duration: const Duration(milliseconds: 160),
                    width: _page.round() == i ? 18 : 6, height: 6,
                    decoration: BoxDecoration(
                      color: _page.round() == i ? Colors.white : Colors.white30,
                      borderRadius: BorderRadius.circular(99)))),
              )),
        ]))),
  ]);

  Widget _machineCard(ManagedComputer machine, _OverviewGeometry geometry, int index) {
    final warm = _slots.containsKey(_key(machine));
    final status = machine.local ? t('spacesEntryComputer')
      : _online[machine.id] == false ? t('airMachinesUnavailable')
      : _running.containsKey(machine.id)
        ? t('spacesRunningCount', {'count': '${_running[machine.id]}'})
        : t('airMachinesConnectingNow');
    return Padding(padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Column(children: [
        SizedBox(height: 64, child: Center(child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: Colors.white12,
            borderRadius: BorderRadius.circular(999)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.circle, size: 7, color: _online[machine.id] == false
              ? Colors.amber : const Color(0xff2ba67a)),
            const SizedBox(width: 7),
            Flexible(child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(machine.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
              Text(status, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white60, fontSize: 10)),
            ])),
          ])))),
        Expanded(child: Center(child: AspectRatio(
          aspectRatio: geometry.size.width / geometry.size.height,
          child: Semantics(button: true, label: machine.name,
            child: GestureDetector(key: ValueKey('space-overview-card-${machine.id}'),
              behavior: HitTestBehavior.opaque,
              onTap: () => switchToMachine(machine),
              child: Container(
                decoration: BoxDecoration(color: const Color(0xffeaf1f9),
                  borderRadius: BorderRadius.circular(26),
                  boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 20)]),
                child: warm ? null : _coldPreview(machine),
              ),
            ),
          ),
        ))),
        SizedBox(height: 100, child: Center(child: Wrap(alignment: WrapAlignment.center,
          spacing: 6, runSpacing: 2, children: [
            _overviewAction(Icons.settings_outlined, t('airMachinesSettings'),
              () => _openSettings(machine)),
            if (!machine.local) ...[
              _overviewAction(Icons.refresh, t('airMachinesReconnect'),
                () => unawaited(openAddMachineDialog(context, existing: machine))),
              _overviewAction(Icons.link_off, t('airMachinesRemove'),
                () => unawaited(_remove(machine))),
            ],
          ]))),
      ]));
  }

  Widget _overviewAction(IconData icon, String label, VoidCallback action) =>
    TextButton.icon(onPressed: action, icon: Icon(icon, size: 14),
      label: Text(label, style: const TextStyle(fontSize: 10)),
      style: TextButton.styleFrom(foregroundColor: Colors.white,
        backgroundColor: Colors.white10, minimumSize: const Size(0, 30),
        padding: const EdgeInsets.symmetric(horizontal: 10)));

  Widget _coldPreview(ManagedComputer machine) => Padding(
    padding: const EdgeInsets.all(20),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Icon(Icons.computer, size: 36, color: Color(0xff6f8096)),
      const SizedBox(height: 14),
      Text(machine.name, maxLines: 2, overflow: TextOverflow.ellipsis),
      const SizedBox(height: 8),
      Text(t('spacesOpenDesktop'), style: const TextStyle(fontSize: 11)),
      const Spacer(),
      for (var i = 0; i < 3; i++)
        Container(height: 28, margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(color: Colors.white70,
            borderRadius: BorderRadius.circular(8))),
    ]));

  Widget _addCard() => Padding(padding: const EdgeInsets.fromLTRB(10, 64, 10, 100),
    child: GestureDetector(key: const ValueKey('space-overview-add-card'),
      onTap: () => unawaited(openAddMachineDialog(context)),
      child: CustomPaint(painter: const _DashedCardBorder(),
        child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.add_circle_outline, size: 48, color: Colors.white70),
          const SizedBox(height: 14),
          Text(t('airMachinesAdd'), style: const TextStyle(color: Colors.white, fontSize: 18)),
        ]))),
    ));
}

class _DashedCardBorder extends CustomPainter {
  const _DashedCardBorder();
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()..addRRect(RRect.fromRectAndRadius(
      (Offset.zero & size).deflate(1), const Radius.circular(26)));
    final paint = Paint()..color = Colors.white38
      ..style = PaintingStyle.stroke..strokeWidth = 1.5;
    for (final metric in path.computeMetrics()) {
      for (double d = 0; d < metric.length; d += 14) {
        canvas.drawPath(metric.extractPath(d, math.min(d + 7, metric.length)), paint);
      }
    }
  }
  @override
  bool shouldRepaint(_DashedCardBorder oldDelegate) => false;
}
