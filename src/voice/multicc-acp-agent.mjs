#!/usr/bin/env node

import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import bridgeModule from '../voice-acp-bridge.js'

const { createVoiceAcpBridge } = bridgeModule

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}

const directoryId = option('--directory-id') || process.env.MULTICC_DIRECTORY_ID || ''
if (!directoryId) {
  process.stderr.write('[multicc-acp] --directory-id or MULTICC_DIRECTORY_ID is required\n')
  process.exit(2)
}

const bridge = createVoiceAcpBridge({
  directoryId,
  baseUrl: process.env.MULTICC_BASE_URL || 'http://127.0.0.1:3000',
  accessToken: process.env.MULTICC_ACCESS_TOKEN || '',
  log: (event, fields) => {
    process.stderr.write(`[multicc-acp] ${event} ${JSON.stringify(fields || {})}\n`)
  },
})

const app = acp.agent({ name: 'multicc-voice-gateway' })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    if (params.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol ${params.protocolVersion}`)
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {}, close: {} },
      },
      agentInfo: {
        name: 'multicc-voice-gateway',
        title: 'MultiCC Fleet Voice Gateway',
        version: '1.0.0',
      },
      _meta: {
        multicc: {
          directoryId,
          taskAuthority: 'multicc-task-board',
          qwenExternalMcp: 'ignored',
        },
      },
    }
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => bridge.createSession(params))
  .onRequest(acp.methods.agent.session.resume, ({ params }) => bridge.resumeSession(params))
  .onRequest(acp.methods.agent.session.close, ({ params }) => bridge.closeSession(params))
  .onRequest(acp.methods.agent.session.prompt, ({ params, client, signal }) => (
    bridge.prompt(
      params,
      update => client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update,
      }),
      signal,
    )
  ))
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => bridge.cancel(params))

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)
const connection = app.connect(stream)

async function shutdown() {
  await bridge.stop()
  connection.close()
}

process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
connection.closed.finally(() => bridge.stop()).catch(() => {})
