// 参考矩阵生成器：用仓库里那份 qrcode-generator（public/qrcode.min.js，Web 的
// #air-qr-btn 用的就是它）跑出真值，落成 qr_reference.json，供 Dart 侧的
// qr_encoder_test 逐格比对。
//
//   node app/test/fixtures/generate_qr_reference.cjs
//
// 只在改动参照集时手工跑一次，测试本身不执行它。
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const qrcode = require(path.join(repoRoot, 'public', 'qrcode.min.js'));

// 字节化用 UTF-8，不是这个库的默认那套 `charCodeAt(i) & 0xff`（非 ASCII 会被
// 截掉高位，「主机」→ 0x3B 0x3A，扫出来是乱码）。App 侧按标准用 UTF-8，所以
// 参照也得切到同一套；纯 ASCII 下两者逐字节相同，不受影响。
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

// Web 那边是 qrcode(0, 'M')：版本自动、纠错等级 M。用例要盖住版本 1 到十位
// 数、UTF-8 路径、以及数据多到必须分块的长 URL。
const CASES = [
  'http://a.io:1/air',
  'http://localhost:3000/air',
  'http://192.168.1.9:3000/air',
  'http://100.118.172.84:3000/air',
  'http://macbook-air-pwy.tail94695a.ts.net/air',
  'http://主机.example:3000/air',
  `http://192.168.1.9:3000/air?task=${'x'.repeat(160)}`,
  'x'.repeat(400),
];

const cases = CASES.map((data) => {
  const qr = qrcode(0, 'M');
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    let line = '';
    for (let column = 0; column < count; column += 1) {
      line += qr.isDark(row, column) ? '1' : '0';
    }
    rows.push(line);
  }
  // (count - 17) / 4 就是版本号。
  return { data, version: (count - 17) / 4, count, rows };
});

const out = path.join(__dirname, 'qr_reference.json');
fs.writeFileSync(out, `${JSON.stringify({ level: 'M', byteEncoding: 'utf-8', cases }, null, 1)}\n`);
for (const c of cases) {
  console.log(`v${c.version} (${c.count}x${c.count})  ${c.data.length} 字节  ${c.data.slice(0, 40)}`);
}
console.log(`→ ${out}`);
