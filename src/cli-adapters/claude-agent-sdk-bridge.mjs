#!/usr/bin/env node

import { query } from '@anthropic-ai/claude-agent-sdk';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const options = { disallowedTools: [] };
  let prompt = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      prompt = argv.slice(i + 1).join(' ');
      break;
    }
    if (arg === '--session-id') options.sessionId = argv[++i];
    else if (arg === '--resume') options.resume = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--effort') options.effort = argv[++i];
    else if (arg === '--agent') options.agent = argv[++i];
    else if (arg === '--system-prompt') options.systemPrompt = argv[++i];
    else if (arg === '--settings') options.settings = argv[++i];
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i]);
    else if (arg === '--disallowed-tools-json') {
      const parsed = JSON.parse(argv[++i]);
      if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
        throw new Error('invalid --disallowed-tools-json');
      }
      options.disallowedTools = parsed;
    } else if (arg === '--router-node') options.routerNode = argv[++i];
    else if (arg === '--router-script') options.routerScript = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!prompt) throw new Error('prompt is required');
  if (options.sessionId && options.resume) throw new Error('--session-id and --resume are mutually exclusive');
  return { options, prompt };
}

export function sdkOptions(input) {
  const options = {
    cwd: process.cwd(),
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'multicc-claude-exp/1.0',
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
    },
  };
  for (const key of ['sessionId', 'resume', 'model', 'effort', 'agent', 'settings']) {
    if (input[key] != null && input[key] !== '') options[key] = input[key];
  }
  if (Number.isSafeInteger(input.maxTurns) && input.maxTurns > 0) options.maxTurns = input.maxTurns;
  if (input.systemPrompt) {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: input.systemPrompt };
  }
  if (input.disallowedTools.length) options.disallowedTools = input.disallowedTools;
  if (input.routerNode && input.routerScript) {
    options.mcpServers = {
      multicc_router: { command: input.routerNode, args: [input.routerScript] },
    };
  }
  return options;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function run(argv = process.argv.slice(2), queryImpl = query, emit = write) {
  const { options, prompt } = parseArgs(argv);
  for await (const message of queryImpl({ prompt, options: sdkOptions(options) })) emit(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write({ type: 'system', subtype: 'sdk_error', error: message.slice(0, 4000) });
    process.stderr.write(`[claude-exp] ${message}\n`);
    process.exitCode = 1;
  }
}
