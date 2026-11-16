'use strict';

// Frozen copy of the handler that moved to the Rust front door:
// `GET /api/channels` (src/routes/plugins.js at commit e4ec0604). It exists only
// as the differential oracle for `docs/rust-migration/differential/channels.js`;
// production code must not require it. Update it only to mirror a documented
// change in Node, never to make the differential pass.
//
// The two Node-only facts the handler consults are injected:
//   channelHost  -> { status() } | null   (src/plugins/channel-host.js; null = no host)
//   usage()      -> [{plugin, kind, ...}] (src/plugins/channel-registry.js)
function createLegacyChannelsRoute(deps = {}) {
  if (typeof deps.usage !== 'function') throw new TypeError('legacy channels: usage() is required');
  const { channelHost = null, usage: channelUsage } = deps;
  const channelRegistry = { usage: channelUsage };

  return function mount(app) {
    // 常驻插件与通知渠道：是否在运行、未恢复的告警；各渠道的接收人（推送设置、钩子用）。
    app.get('/api/channels', (req, res) => {
      res.set('Cache-Control', 'no-store');
      // inUse：有推送订阅或钩子指望它。插件停了而 inUse 为真，Air 要出横幅。
      const usage = channelRegistry.usage();
      const plugins = (channelHost ? channelHost.status() : []).map(item => {
        if (!item.channel) return item;
        const count = usage.filter(use => use.plugin === item.id).length;
        return { ...item, inUse: count > 0, subscriptions: usage.filter(use => use.plugin === item.id && use.kind === 'push').length, uses: count };
      });
      res.json({ available: Boolean(channelHost), plugins });
    });
  };
}

module.exports = { createLegacyChannelsRoute };
