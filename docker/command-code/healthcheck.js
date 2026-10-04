'use strict';
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
async function check() {
  fs.accessSync(process.env.COMMAND_CODE_CMD, fs.constants.X_OK);
  const providers = JSON.parse(fs.readFileSync(path.join(home, '.commandcode/providers.json'), 'utf8'));
  if (providers.provider?.deepseek?.apiKey !== '$DEEPSEEK_API_KEY') throw new Error('配置未就绪');
  fs.accessSync(path.join(process.env.MULTICC_DATA_DIR, 'command-code-seed.json'));
  const response = await fetch('http://127.0.0.1:3000/readyz', { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('服务未就绪');
}
check().catch(() => { console.error('Command Code 实例未就绪'); process.exitCode = 1; });
