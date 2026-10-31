# MultiCC as a practical Super Agent workspace

MultiCC brings coding agents, task context, memory, tools and result delivery
into one self-hosted workspace. Give it a goal, let a supported agent plan and
execute the work, and follow the task through to an output you can inspect.
Claude Code, Codex and the other supported engines provide the reasoning and
execution; MultiCC provides the coordination and continuity around them.

## From a goal to a result

1. **Start with a goal.** Open a task or ask the Commander to coordinate work.
   Tasks retain their own identity, history and status.
2. **Bring in relevant context.** Scoped memory and on-demand history retrieval
   provide earlier decisions with their sources. Retrieval is bounded; it is
   not a promise of perfect or unlimited recall.
3. **Delegate independent work.** Cross-session dispatch can create an
   independent task or address an existing one. Independent workspaces can run
   concurrently. Tasks in the same conversation shell share a worktree and
   run serially; a separate task or fork is needed for isolated code changes.
4. **Use tools and wait for results.** With the corresponding integrations
   configured, agents can use browser and desktop tools, files, commands and
   services. Background jobs and registered callback or polling waits return
   results to the conversation. Schedules and internal event triggers can
   initiate recurring work.
5. **Deliver something inspectable.** Review the task's report, file, preview,
   code diff and checks. Git integration has validation gates; overlapping
   changes can still require conflict resolution.

When a task needs a human decision or a desktop action, the agent can ask for
help in the same task. On supported hosts, open its screen from your phone,
complete the step and reply in chat. The agent then checks the state and
continues. Human assistance supports the workflow; it is one capability in
the broader workspace.

## What ships today

| Capability | Implementation and further reading |
|---|---|
| Task identity, independent execution contexts and workspace ownership | [Task conversation shells](task-session-shell-experiment.md) |
| Commander and cross-session delegation | [Router MCP tools](router-tools.md), [gateway dispatch](gateway-dispatch-brief.md) |
| Task and project memory, source-tagged history retrieval | [Features](features.md), [task conversation shells](task-session-shell-experiment.md) |
| Asynchronous dispatch, background commands and callback/poll waits | [Router MCP tools](router-tools.md), [API reference](api-reference.md) |
| Schedules, file-change and task-state triggers | [Trigger skill](../skills/multicc-trigger/SKILL.md) |
| Browser, desktop and connected service tools | [Browser skill](../skills/multicc-browser/SKILL.md), [desktop skill](../skills/multicc-computer-use/SKILL.md) |
| CLI switching while retaining the task and worktree | [Visible handoff checkpoints](cli-switching.md) |
| Human help from desktop or phone | [Human-assistance workflow](../skills/multicc-human-assist/SKILL.md) |
| Files, reports and previews collected alongside the work | [Artifact skill](../skills/multicc-artifact/SKILL.md) |

Availability depends on the selected engine, installed integrations and host
permissions. Cross-engine handoff transfers a bounded visible checkpoint,
not a vendor's hidden state. Provider and subagent controls differ by engine.

## Example task to try

> Investigate this repository's onboarding problem. Use the existing issue
> and project decisions as context. Propose a plan, delegate an independent
> review if useful, implement the agreed change and run the relevant checks.
> Return a summary and the diff. Ask me when a decision or login needs me.

This is a suggested input, not a recorded benchmark or a claim that every
repository can be completed autonomously. The agent chooses a workflow based
on the task and available tools; MultiCC does not automatically turn every
prompt into a multi-agent dependency graph.

## Relation to the Super-agent architecture discussion

The article [Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)
explores a broader architecture for autonomous agent systems. MultiCC already
implements several of its execution and context-management building blocks:
independent workers, task/session separation, bounded context retrieval,
scoped memory, asynchronous results and persistent host-side state.

**MultiCC is an independent project.** This comparison does not imply an
affiliation, endorsement or complete implementation of the article's design.
The following are not current MultiCC capabilities:

- A unified subscription graph that routes subsequent PR, email and IM-thread
  events directly to the same workers across all channels.
- General-purpose silent monitoring that discovers and fixes work without
  a request or a configured trigger.
- A cloud agent loop that stays active independently of its host, or a single
  agent that migrates execution among offline and online machines.
- A separate semantic watchdog agent that continually corrects the direction
  of other agents, or automatic dependency-DAG scheduling for every task.

These are boundaries, not a committed roadmap. Current processes still
depend on a running host and MultiCC service. Desktop and phone clients can
disconnect and reconnect while that host remains available.

## Hosting, access and cost

MultiCC is MIT-licensed and self-hosted. The workspace and its stored state
run on your own computer or server. Connected model providers and external
tools receive the data necessary for their requests; self-hosting does not
mean all inference is local or that no data leaves the host.

Bring a supported CLI and its required account or model access. Model, API,
hosting and third-party service charges may apply. Remote access needs an
authenticated reachable address. Human desktop control currently supports
macOS and Linux X11 with the desktop agent and OS permissions; Windows
desktop control and Wayland are not supported.
