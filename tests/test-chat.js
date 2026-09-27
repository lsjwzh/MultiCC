'use strict';
// Quick test: verify chat mode claude spawn works
const { spawn } = require('child_process');
const path = require('path');

const CLAUDE = process.env.CLAUDE_CMD || 'claude';
const CWD = process.env.CWD || process.cwd();

function testSpawn(label, args) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===`);
    console.log(`CMD: ${CLAUDE} ${args.join(' ')}`);
    console.log(`CWD: ${CWD}\n`);

    const proc = spawn(CLAUDE, args, {
      cwd: CWD,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      // Print first few lines
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines.slice(0, 3)) {
        try {
          const evt = JSON.parse(line);
          console.log(`  [stdout] type=${evt.type} ${evt.subtype || evt.event?.type || ''}`);
        } catch (_) {
          console.log(`  [stdout] ${line.slice(0, 120)}`);
        }
      }
      if (lines.length > 3) console.log(`  ... +${lines.length - 3} more lines`);
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      console.log(`  [stderr] ${d.toString().trim().slice(0, 200)}`);
    });

    proc.on('close', (code) => {
      console.log(`\n  EXIT CODE: ${code}`);
      if (code !== 0 && !stdout) {
        console.log(`  FULL STDERR: ${stderr.slice(0, 500)}`);
      }
      resolve({ code, stdout, stderr });
    });

    // Timeout
    setTimeout(() => {
      proc.kill('SIGTERM');
      console.log('  [TIMEOUT] killed after 15s');
    }, 15000);
  });
}

async function main() {
  // Test 1: Basic - no --resume
  const t1 = await testSpawn('Test 1: No --resume (should work)', [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--dangerously-skip-permissions',
    'just say "hello test" and nothing else'
  ]);

  // Test 2: --resume with fake UUID (should fail)
  const t2 = await testSpawn('Test 2: --resume fake UUID (should fail)', [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--dangerously-skip-permissions',
    '--resume', '00000000-0000-0000-0000-000000000000',
    'hello'
  ]);

  // Test 3: --continue (resume most recent in cwd)
  const t3 = await testSpawn('Test 3: --continue (resume latest in cwd)', [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--dangerously-skip-permissions',
    '--continue',
    'just say "hello continue" and nothing else'
  ]);

  console.log('\n\n=== SUMMARY ===');
  console.log(`Test 1 (no resume):     exit=${t1.code} ${t1.code === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Test 2 (fake resume):   exit=${t2.code} ${t2.code !== 0 ? 'EXPECTED FAIL' : 'UNEXPECTED PASS'}`);
  console.log(`Test 3 (--continue):    exit=${t3.code} ${t3.code === 0 ? 'PASS' : 'FAIL'}`);
}

main().catch(console.error);
