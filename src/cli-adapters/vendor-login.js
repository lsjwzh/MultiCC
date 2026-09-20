'use strict';

// Vendor-auth CLIs are providerless: the CLI binary owns the account and login
// happens inside its own interactive TUI (`/login`). When a chat turn fails
// with the vendor's "authentication required" text, the UI offers to open one
// of these whitelisted login terminal sessions (same pattern as codex-login /
// claude-auth-login in src/session/create-record.js).
const VENDOR_LOGIN = Object.freeze({
  codebuddy: Object.freeze({
    loginFlow: 'codebuddy-login',
    label: 'WorkBuddy',
    loginCommand: '/login',
  }),
  qoder: Object.freeze({
    loginFlow: 'qoder-login',
    label: 'Qoder CN',
    loginCommand: '/login',
  }),
});

const LOGIN_FLOW_CLI = Object.freeze(Object.fromEntries(
  Object.entries(VENDOR_LOGIN).map(([cli, spec]) => [spec.loginFlow, cli]),
));

function vendorLoginForCli(cli) {
  return VENDOR_LOGIN[String(cli || '').trim().toLowerCase()] || null;
}

function cliForLoginFlow(loginFlow) {
  return LOGIN_FLOW_CLI[String(loginFlow || '').trim()] || null;
}

// Terminal launch override for a vendor loginFlow session: the vendor TUI owns
// /login, so the "login command" is just the bare binary (null = not a vendor
// login flow → caller keeps its normal terminal command).
function vendorLoginTerminalCmd(loginFlow, cliCommands) {
  const cli = cliForLoginFlow(loginFlow);
  return cli && cliCommands && cliCommands[cli] ? `${cliCommands[cli]}` : null;
}

module.exports = { VENDOR_LOGIN, vendorLoginForCli, cliForLoginFlow, vendorLoginTerminalCmd };
