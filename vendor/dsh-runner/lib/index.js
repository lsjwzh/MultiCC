// multicc-dsh-runner — the multicc chat surface for DeepSeek Harness (dsh).
//
// The shipped dsh-headless bundle is one-shot: plain-text stdout, a fresh
// agent per run, no resume. multicc needs stream-json-style events and native
// session continuity, both of which the harness core already exposes
// (agents.resume + the session/event feed). This plugin rides over the same
// dsh-base/dsh-headless bundles with the one-shot runners disabled (see the
// profile's cordis.patch.yml, written by src/cli-adapters/dsh.js) and:
//
//   1. parses the multicc flag family off the launcher's cmdlineArgs service —
//      dsh --profile multicc [--multicc-model <id>] [--multicc-resume <id>] "<task>"
//   2. creates (or resumes) an Agent, submits the task as a user followup and
//      waits for quiescence;
//   3. streams every session event as one JSON object per line on stdout:
//      {type:'session_started',sessionId,resumed}
//      {type:'assistant_text',text}            — assistant/message text blocks
//      {type:'thinking',text}                  — assistant/message reasoning blocks
//      {type:'tool_update',id,name,input,completed:false}          — tool/call
//      {type:'tool_update',id,name,completed:true,content,isError} — tool/result
//      {type:'status',status:'thinking'}       — llm/retry-started (keep-alive)
//      {type:'complete'} / {type:'error',message}
//   4. exits 0 on a completed turn, 1 otherwise.
//
// Credentials stay entirely with dsh: DEEPSEEK_API_KEY in the launching
// environment (or the credentials service the `dsh web` Models page writes)
// and an optional DEEPSEEK_BASE_URL override, both read by dsh-llm-deepseek.
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'multicc-runner';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'cmdlineArgs'];

const internals = { stdout: process.stdout, stderr: process.stderr };

function line(obj) { internals.stdout.write(JSON.stringify(obj) + '\n'); }

function parseToolArguments(raw) {
  if (raw == null || typeof raw === 'object') return raw || {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// callId → tool name, filled from tool/call so tool/result cards keep names.
const toolNames = new Map();

// Flatten the tool/result message into plain text for the chat transcript.
function toolResultText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block?.type !== 'tool-result') continue;
    const inner = Array.isArray(block.content)
      ? block.content.map(item => (item?.type === 'text' ? item.text : '')).join('')
      : String(block.content ?? '');
    parts.push(inner);
  }
  return parts.join('\n');
}

export function apply(ctx) {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('multicc-runner: the launcher must provide ctx.appExit before the tree mounts');

  const parsed = { task: '', resume: '', model: '' };
  const program = new Command()
    .name('dsh --profile multicc')
    .description('multicc chat runner: answer one task with event streaming, then exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--multicc-resume <sessionId>', 'resume a persisted dsh session instead of creating one')
    .option('--multicc-model <model>', 'override the default DeepSeek model for this run');
  program.action(() => {
    parsed.task = program.args.join(' ');
    const opts = program.opts();
    parsed.resume = String(opts.multiccResume || '');
    parsed.model = String(opts.multiccModel || '');
  });
  try {
    parseCmdline(ctx, program);
  } catch (error) {
    internals.stderr.write(`multicc-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    return exit(1);
  }
  if (!parsed.task.trim()) {
    internals.stderr.write('multicc-runner: a task is required\n');
    return exit(1);
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event !== 'object') return;
    const data = event.data || {};
    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) line({ type: 'assistant_text', text: block.text });
        else if (block?.type === 'reasoning' && block.text) line({ type: 'thinking', text: block.text });
      }
    } else if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '');
      if (callId && data.name) toolNames.set(callId, String(data.name));
      line({
        type: 'tool_update', id: callId, name: String(data.name || 'tool'),
        input: parseToolArguments(data.arguments), completed: false,
      });
    } else if (event.type === 'tool/result') {
      const callId = String(data.message?.source?.callId ?? '');
      line({
        type: 'tool_update', id: callId,
        name: toolNames.get(callId) || 'tool',
        input: {}, completed: true,
        content: toolResultText(data.message), isError: !!data.error,
      });
    } else if (event.type === 'llm/retry-started') {
      line({ type: 'status', status: 'thinking' });
    }
  });

  run(ctx, parsed, exit).catch((error) => {
    internals.stderr.write('multicc-runner: ' + (error?.stack || error) + '\n');
    line({ type: 'error', message: error?.message || String(error) });
    exit(1);
  });
}

async function run(ctx, parsed, exit) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const defaultModel = ctx.get('agentDefaultModel');
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error('multicc-runner: dsh core services are unavailable (agents/sessions/agentDefaultModel)');
  }
  const selection = defaultModel.currentSelection();
  const model = parsed.model || selection.model;
  const agentOptions = { provider: selection.provider, model };
  const setup = (agentCtx) => { installModelSelection(agentCtx, { current: { ...selection, model }, assembled: undefined }); };

  let agent;
  if (parsed.resume) {
    ({ agent } = await agents.resume({ resumeSessionId: SessionId(parsed.resume), agentOptions, setup }));
    line({ type: 'session_started', sessionId: String(agent.session.id), resumed: true });
  } else {
    const sid = 'multicc-' + randomUUID();
    ({ agent } = await agents.create({
      sessionId: SessionId(sid), meta: { cwd: process.cwd() }, agentOptions, setup,
    }));
    line({ type: 'session_started', sessionId: sid, resumed: false });
  }
  await agent.whenIdle();
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: parsed.task }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);

  const last = [...agent.session.events].reverse().find(e => e.type === 'turn/end');
  const reason = last?.data?.reason ?? {};
  line({ type: 'session_finished', sessionId: String(agent.session.id) });
  if (reason.kind === 'completed') {
    line({ type: 'complete' });
    return exit(0);
  }
  const failure = reason.error || reason.failure || {};
  line({
    type: 'error',
    message: `dsh turn ${reason.kind || 'ended'}${failure.code ? `: ${failure.code}` : ''}${failure.message ? ` — ${failure.message}` : ''}`,
  });
  return exit(1);
}
