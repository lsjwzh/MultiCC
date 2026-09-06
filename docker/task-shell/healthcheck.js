'use strict';
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const seed = JSON.parse(fs.readFileSync(path.join(process.env.MULTICC_DATA_DIR, 'lab-seed.json')));
  const response = await fetch('http://127.0.0.1:3000/readyz', { signal: AbortSignal.timeout(2000) });
  if (!response.ok || seed.shells?.length !== 2) throw new Error('Lab not ready');
})().catch(() => { process.exitCode = 1; });
