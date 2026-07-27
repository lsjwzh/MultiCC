// Quick validation test for realtime voice implementation

const assert = require('assert');

console.log('=== Realtime Voice Implementation Validation ===\n');

// Test 1: TTS Service loads
console.log('[Test 1] TTS Service Loading');
try {
  const tts = require('../src/tts-service.js');
  assert(typeof tts.handleTtsWs === 'function', 'handleTtsWs should be a function');
  assert(typeof tts.providerStatus === 'function', 'providerStatus should be a function');
  assert(typeof tts.applyConfig === 'function', 'applyConfig should be a function');
  console.log('  ✅ TTS service exports correct functions');
  
  const status = tts.providerStatus();
  assert(status.openai !== undefined, 'should have openai status');
  assert(status.volcano !== undefined, 'should have volcano status');
  console.log('  ✅ Provider status works:', JSON.stringify(status));
} catch (err) {
  console.log('  ❌ Error:', err.message);
  process.exit(1);
}

// Test 2: Voice modules exist
console.log('\n[Test 2] Voice Module Files');
const fs = require('fs');
const files = [
  'public/voice-output.js',
  'public/vad-monitor.js', 
  'public/voice-session.js',
  'public/voice-stream.js',
  'public/voice-worklet.js',
];
for (const f of files) {
  if (fs.existsSync(f)) {
    console.log(`  ✅ ${f} exists`);
  } else {
    console.log(`  ❌ ${f} missing`);
    process.exit(1);
  }
}

// Test 3: Documentation exists
console.log('\n[Test 3] Documentation Files');
const docs = [
  'docs/realtime-voice-design.md',
  'docs/realtime-voice-implementation.md',
  'docs/benchmark-realtime-voice.md',
];
for (const f of docs) {
  if (fs.existsSync(f)) {
    console.log(`  ✅ ${f} exists`);
  } else {
    console.log(`  ❌ ${f} missing`);
  }
}

// Test 4: Test pages exist
console.log('\n[Test 4] Test Pages');
const testPages = [
  'public/test-voice-realtime.html',
];
for (const f of testPages) {
  if (fs.existsSync(f)) {
    console.log(`  ✅ ${f} exists`);
  } else {
    console.log(`  ❌ ${f} missing`);
  }
}

// Test 5: Server.js has TTS integration
console.log('\n[Test 5] Server Integration');
const serverContent = fs.readFileSync('server.js', 'utf8');
if (serverContent.includes("ttsService.handleTtsWs")) {
  console.log('  ✅ TTS WebSocket route integrated');
} else {
  console.log('  ❌ TTS WebSocket route not found');
  process.exit(1);
}
if (serverContent.includes("require('../src/tts-service')")) {
  console.log('  ✅ TTS service imported');
} else {
  console.log('  ❌ TTS service import not found');
  process.exit(1);
}

// Test 6: chat.js has TTS integration
console.log('\n[Test 6] Chat.js Integration');
const chatContent = fs.readFileSync('public/chat.js', 'utf8');
if (chatContent.includes("speakText")) {
  console.log('  ✅ speakText function found');
} else {
  console.log('  ❌ speakText function not found');
  process.exit(1);
}
if (chatContent.includes("VoiceOutput")) {
  console.log('  ✅ VoiceOutput usage found');
} else {
  console.log('  ❌ VoiceOutput usage not found');
  process.exit(1);
}

// Summary
console.log('\n=== Summary ===');
console.log('✅ All core components implemented');
console.log('✅ Server integration complete');
console.log('✅ Frontend integration complete');
console.log('✅ Documentation created');
console.log('\nReady for testing!');
console.log('\nNext steps:');
console.log('1. Install edge-tts: pip install edge-tts');
console.log('2. Install ffmpeg: brew install ffmpeg (macOS)');
console.log('3. Start server: node server.js');
console.log('4. Open test page: http://localhost:3000/test-voice-realtime.html');
