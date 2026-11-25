'use strict';

// Vendor-auth CLIs are providerless: the CLI binary owns the account and login
// happens inside its own interactive TUI (`/login`). When a chat turn fails
// with the vendor's "authentication required" text, the UI offers to open one
// of these whitelisted login terminal sessions (same pattern as codex-login /
// claude-auth-login in src/session/create-record.js).
const { displayNameOf } = require('../cli/cli-capability');

const VENDOR_LOGIN = Object.freeze({
  commandcode: Object.freeze({
    loginFlow: 'commandcode-login',
    label: displayNameOf('commandcode'),
    loginCommand: 'command-code login',
    autoStart: true,
  }),
  codebuddy: Object.freeze({
    loginFlow: 'codebuddy-login',
    label: displayNameOf('codebuddy'),
    loginCommand: '/login',
  }),
  qoder: Object.freeze({
    loginFlow: 'qoder-login',
    label: displayNameOf('qoder'),
    loginCommand: '/login',
  }),
  // agy signs in through its own TUI (bare `agy` → Google OAuth); there is no
  // login subcommand. The per-account flow pins HOME at the account's mini-home
  // (src/routes/account-routes-host.js), so this entry is only the "machine's own
  // login" variant plus the loginFlow → cli mapping create-record requires.
  agy: Object.freeze({
    loginFlow: 'agy-login',
    label: displayNameOf('agy'),
    loginCommand: 'agy',
    autoStart: true,
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
  if (cli === 'commandcode' && cliCommands && cliCommands[cli]) {
    const quoted = `'${String(cliCommands[cli]).replace(/'/g, `'"'"'`)}'`;
    return `${quoted} login --no-auto-update`;
  }
  return cli && cliCommands && cliCommands[cli] ? `${cliCommands[cli]}` : null;
}

module.exports = { VENDOR_LOGIN, vendorLoginForCli, cliForLoginFlow, vendorLoginTerminalCmd };
