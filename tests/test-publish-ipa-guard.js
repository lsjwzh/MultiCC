'use strict';

// publish-ipa.sh 的投放闸门：描述文件里没有设备 UDID 的 IPA（App Store 分发型）
// 一律不许进 OTA 通道。
//
// 这条闸门是被真事逼出来的。2026-09-20 发布的 2.29.15 (129) 是用 `method=app-store`
// 导出的 —— 包里代码是新的，但描述文件是 "iOS Team Store Provisioning Profile"，
// 一台设备都没列。itms-services 只认 development / ad-hoc 那几类描述文件，于是手机
// 把 25MB 整个下完之后静默丢掉：服务器这边 manifest、HEAD、GET 全 200，/ios-ota 页面
// 上安装按钮亮着、版本号也报 129，没有任何一处报错；用户那边只看到「点了安装没反应」，
// 继续跑旧版 —— 直到有人对着截图一个像素一个像素量出「卡片还是老排法」才查到这里。
//
// 真签名造不出来，所以脚本留了 MULTICC_IPA_PROFILE_PLIST 这个口子：跳过 security cms，
// 直接喂一份解好的描述文件。两种结局（有设备 / 没设备 / 压根没描述文件）都要钉住。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const scriptPath = path.resolve(__dirname, '../scripts/publish-ipa.sh');

// publish-ipa.sh 是 macOS 专属的（plutil / security cms 都没有跨平台替身），CI 跑在
// Linux 上 —— 那边跳过，而不是红一片说不清缘由的失败。
// 注意是 skip 的理由，不是「能不能跑」—— node:test 的 skip 传 true 就是跳过。
const skipReason = process.platform === 'darwin' ? false : 'publish-ipa.sh 只在 macOS 上跑（plutil/security cms）';

// 脚本按 BASH_SOURCE 推 ROOT，再往 ROOT/public 投放 —— 所以把它抄到一个临时仓库里，
// 这个测试就不会碰到真正的仓库目录。
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-publish-ipa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(root, 'scripts', 'publish-ipa.sh'));
  return root;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>2.29.15</string>
  <key>CFBundleVersion</key><string>129</string>
  <key>CFBundleIdentifier</key><string>com.multicc.multiccApp</string>
  <key>CFBundleDisplayName</key><string>MultiCC</string>
</dict></plist>
`;
}

// 一个最小的 .ipa：Payload/*.app/{Info.plist, embedded.mobileprovision}。
function makeIpa(root, { withProfile = true } = {}) {
  const stage = path.join(root, 'stage');
  const app = path.join(stage, 'Payload', 'MultiCC.app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), infoPlist());
  if (withProfile) fs.writeFileSync(path.join(app, 'embedded.mobileprovision'), 'not-a-real-cms-blob');
  const ipa = path.join(root, 'MultiCC.ipa');
  execFileSync('zip', ['-q', '-r', ipa, 'Payload'], { cwd: stage });
  return ipa;
}

function writeProfile(root, name, plist) {
  const file = path.join(root, name);
  fs.writeFileSync(file, plist);
  return file;
}

// development / ad-hoc：描述文件里列着设备。
const PROFILE_WITH_DEVICE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Name</key><string>iOS Team Provisioning Profile: com.multicc.multiccApp</string>
  <key>ProvisionedDevices</key><array><string>00008130-000C25181141001C</string></array>
  <key>Entitlements</key><dict><key>get-task-allow</key><true/></dict>
</dict></plist>
`;

// App Store 分发型：ProfileDistributionType=STORE，没有 ProvisionedDevices。
const PROFILE_STORE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Name</key><string>iOS Team Store Provisioning Profile: com.multicc.multiccApp</string>
  <key>ProfileDistributionType</key><string>STORE</string>
</dict></plist>
`;

function publish(root, ipa, profilePlist) {
  const env = { ...process.env, MULTICC_IPA_PROFILE_PLIST: profilePlist };
  return spawnSync('bash', [path.join(root, 'scripts', 'publish-ipa.sh'), ipa], {
    encoding: 'utf8', env, cwd: root,
  });
}

test('App Store 分发型（描述文件里没有设备）的 IPA 不许投放', { skip: skipReason }, t => {
  const root = makeRepo(t);
  const ipa = makeIpa(root);
  const result = publish(root, ipa, writeProfile(root, 'store.plist', PROFILE_STORE));

  assert.notEqual(result.status, 0, `这个包该被拦下：${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /App Store 分发型/, '要把原因说清楚，而不是一句 generic 的失败');
  assert.match(result.stderr, /development/, '要给出可执行的下一步');
  // 拦下来就不许落盘 —— 半成品躺在那儿，下一个人的「已发布」就是假的。
  assert.equal(fs.existsSync(path.join(root, 'public', 'multicc-ios.ipa')), false, '拦下时不该写 IPA');
  assert.equal(fs.existsSync(path.join(root, 'public', 'multicc-ios.ipa.json')), false, '拦下时不该写 sidecar');
});

test('development 签的（描述文件里有设备）照常发布', { skip: skipReason }, t => {
  const root = makeRepo(t);
  const ipa = makeIpa(root);
  const result = publish(root, ipa, writeProfile(root, 'dev.plist', PROFILE_WITH_DEVICE));

  assert.equal(result.status, 0, `这个包该放行：${result.stdout}${result.stderr}`);
  assert.ok(fs.existsSync(path.join(root, 'public', 'multicc-ios.ipa')), 'IPA 要落盘');
  const sidecar = JSON.parse(fs.readFileSync(path.join(root, 'public', 'multicc-ios.ipa.json'), 'utf8'));
  assert.equal(sidecar.versionName, '2.29.15');
  assert.equal(sidecar.versionCode, '129');
  assert.equal(sidecar.bundleId, 'com.multicc.multiccApp');
});

test('包里没有 embedded.mobileprovision 时说清楚，不硬猜', { skip: skipReason }, t => {
  const root = makeRepo(t);
  const ipa = makeIpa(root, { withProfile: false });
  const result = publish(root, ipa, writeProfile(root, 'dev.plist', PROFILE_WITH_DEVICE));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /embedded\.mobileprovision/);
  assert.equal(fs.existsSync(path.join(root, 'public', 'multicc-ios.ipa')), false);
});
