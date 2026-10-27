#!/usr/bin/env node
'use strict';

// Build-time only. Keep the MultiCC artwork and add a desktop-helper badge.
// Shipped .icns needs no browser or developer tools on the user's Mac.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = fs.readFileSync(path.join(root, 'app/assets/branding/icon.svg'), 'utf8');
const badge = `
  <g aria-label="Desktop agent">
    <circle cx="418" cy="418" r="86" fill="#0d1117"/>
    <circle cx="418" cy="418" r="74" fill="#79c0ff"/>
    <g fill="none" stroke="#0d1117" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
      <rect x="376" y="383" width="84" height="58" rx="8"/>
      <path d="M418 441v15m-23 0h46"/>
      <path d="m405 403 12 10-12 10m22 0h9" stroke-width="6"/>
    </g>
  </g>
`;
const svg = base.replace('</svg>', badge + '</svg>');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-agent-icon-'));
try {
  const html = path.join(work, 'icon.html');
  const master = path.join(__dirname, 'AgentIcon.png');
  fs.writeFileSync(html, '<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>' + svg);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', '--window-size=1024,1024', `--screenshot=${master}`, `file://${html}`], { stdio: 'ignore' });
  const iconset = path.join(work, 'AgentIcon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), master,
        '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(__dirname, 'AgentIcon.icns')]);
  console.log('Generated scripts/macos-agent/AgentIcon.png and AgentIcon.icns');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
