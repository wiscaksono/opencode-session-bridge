# opencode-session-bridge

Let the agents in your OpenCode sessions talk to each other.

You work in more than one repo at a time. Each OpenCode session knows its own
project and history and nothing about the others. `session-bridge` adds three
tools, so one session can ask another a question, hand it a task, and wait for the
answer. The peer answers from its own context.

A typical exchange: the agent in your backend repo says the endpoint now returns
`newPremium`, asks the agent in your frontend repo to update the API client, and
gets a reply listing the files it changed.

## Requirements

- OpenCode V2 (tested on `v2.0.20`).
- Both sessions must share the same background service. That is the default: every
  TUI on the machine connects to one service, so sessions in different projects see
  each other. Servers started with `--standalone` are separate runtimes and cannot
  reach each other.
- Discovery needs the local service registration file,
  `~/.local/state/opencode/service.json`. When that file is missing or the service
  does not answer, `peer_ask` still works if you pass an explicit session id.

## Install

Not on npm yet. Install from GitHub:

```sh
opencode plugin add github:wiscaksono/opencode-session-bridge
```

To install by hand, clone the repo and link it in. A plugin directory is
auto-discovered, so no config entry is needed:

```sh
git clone https://github.com/wiscaksono/opencode-session-bridge
ln -s "$PWD/opencode-session-bridge" ~/.config/opencode/plugins/session-bridge
# project-local instead of global:
# mkdir -p .opencode/plugins && ln -s "$PWD/opencode-session-bridge" .opencode/plugins/session-bridge
```

Confirm it loaded:

```sh
opencode api get /api/plugin
```

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `peer_ask` | `target`, `message`, `mode?` (`queue`\|`steer`), `wait?`, `deliver?` (`user`\|`synthetic`), `timeout_ms?` | Send a message to another session. By default it blocks until the peer answers and returns that reply. |
| `peer_list` | none | List the sessions in this runtime, with reference names, busy/idle state, and ids. |
| `peer_read` | `sessionID` | Read the last assistant reply of another session, for replies that arrive after a timeout. |

`target` accepts a session id (`ses_...`), a reference name from `references` in
your `opencode.json`, an absolute directory, or a title fragment. When several
sessions match a directory, the most recently updated one is used.

## Usage

You talk to your agent normally and it picks the tool:

- "Ask the frontend agent which HTTP client it uses for the policy service, and
  wait for the answer."
- "Tell the session working on the API that the response shape changed, and that
  the field is now `newPremium`, then ask it to update the clients."
- "Check whether the session in the auth repo already handles the new header."

When a peer is busy, delivery is queued and it answers after its current turn. The
peer works with its own tools and permissions, so a permission prompt leaves
`peer_ask` waiting until someone answers it or the call times out. A timeout does
not cancel the message: read the reply later with `peer_read`.

## How it works

The plugin injects the message into the peer session as a turn and marks it with a
`[peer message] from another agent session` header that names the sender, plus an
instruction to answer in the reply. With `deliver: "synthetic"` the message arrives
as an agent notification instead of a user turn. The model sees the same text
either way, and the peer's user transcript stays clean.

The reply is read by anchoring on the id of the delivered message and taking the
assistant messages that follow it. A peer that was already busy therefore cannot
leak its previous answer into your result.

Discovery goes through `@opencode/client` against the local service, because the
plugin context has no `session.list`. An unfiltered `session.list` is runtime-wide,
which is what makes the cross-project lookup work.

Every delivered message carries the chain of sessions it passed through
(`metadata.peer.via`). Before sending, the plugin reads that chain back from the
caller's context and refuses self-sends, cycles, and chains longer than 4 hops.
A to B to C still works.

## Limits and security

- A peer message becomes a turn in the target session and can cause tool use. Treat
  peer messages as untrusted input.
- Same runtime only, as described under Requirements.
- The hop-chain guard needs the peer to run `session-bridge` too.
- No file-conflict guarantees. This is a transport: it does not spawn sessions,
  schedule work, or isolate checkouts. Two sessions editing the same working tree
  can still conflict. If you need that protection, pair it with worktree isolation,
  scope rules, or one writer per repo.
- Messages and replies are capped by the session runner's normal output bounding.

## Development

```sh
bun install
bun test
bun run typecheck
```

The tests cover the pure helpers (target resolution, reply extraction, tool input
parsing, message formatting, loop guards) and need no server.

## License

MIT
