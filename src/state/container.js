// Canonical cross-domain state registry.
//
// These three Maps are read by nearly every domain (core, chat, push, triggers,
// gateway, skills, workspace). Centralizing the *references* here lets extracted
// modules read `state.sessions` instead of receiving bespoke init() injections.
//
// Mechanism: server.js still creates and owns these Maps; at bootstrap it
// populates this object with the SAME references (Object.assign). Because the
// Maps are mutated-but-never-reassigned, the shared reference stays valid for
// the process lifetime. Consumers must read `state.sessions` at call time and
// must NOT destructure (`const { sessions } = state`) before bootstrap runs —
// the properties are null until server.js fills them in.
//
//   sessions          live session id → runtime session object (tmux/chat procs)
//   persistedSessions session id → persisted record (survives restart)
//   directories       directory id → registered working directory
module.exports = {
  sessions: null,
  persistedSessions: null,
  directories: null,
};
