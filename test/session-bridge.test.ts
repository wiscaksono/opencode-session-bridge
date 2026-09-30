import { describe, expect, test } from "bun:test"
import {
  checkGuard,
  clampTimeout,
  extractReply,
  formatPeerMessage,
  isRootSession,
  labelForDirectory,
  lastAssistantText,
  selectSession,
  sameDir,
} from "../src/index.ts"

const assistant = (over: Record<string, unknown> = {}) => ({
  id: "msg_a1",
  type: "assistant",
  time: { created: 1, completed: 2 },
  content: [{ type: "text", text: "hello" }],
  ...over,
})

describe("clampTimeout", () => {
  test("defaults when missing or junk", () => {
    expect(clampTimeout(undefined)).toBe(300_000)
    expect(clampTimeout("abc")).toBe(300_000)
    expect(clampTimeout(Number.NaN)).toBe(300_000)
  })
  test("clamps to the allowed range", () => {
    expect(clampTimeout(10)).toBe(1_000)
    expect(clampTimeout(9_999_999)).toBe(1_800_000)
    expect(clampTimeout("5000")).toBe(5_000)
  })
})

describe("checkGuard", () => {
  test("refuses self-send", () => {
    expect(checkGuard({ caller: "ses_a", target: "ses_a", chain: [] })).toContain("same session")
  })
  test("refuses a loop", () => {
    const result = checkGuard({ caller: "ses_b", target: "ses_a", chain: ["ses_a"] })
    expect(result).toContain("loop")
  })
  test("refuses past the hop limit", () => {
    const result = checkGuard({ caller: "ses_e", target: "ses_z", chain: ["ses_a", "ses_b", "ses_c", "ses_d"] })
    expect(result).toContain("hop limit")
  })
  test("allows a fresh target", () => {
    expect(checkGuard({ caller: "ses_b", target: "ses_c", chain: ["ses_a"] })).toBeUndefined()
  })
})

describe("formatPeerMessage", () => {
  test("marks the sender and keeps the message body", () => {
    const text = formatPeerMessage({ label: "frontend-app", sessionID: "ses_a", chain: [], message: "ping" })
    expect(text).toContain("[peer message] from another agent session — frontend-app (ses_a)")
    expect(text).toContain("not your user typing")
    expect(text).toContain("open question")
    expect(text.endsWith("\n\nping")).toBe(true)
    expect(text).not.toContain("peer chain")
  })
  test("includes the chain when present", () => {
    const text = formatPeerMessage({ label: "b", sessionID: "ses_b", chain: ["ses_a", "ses_b"], message: "x" })
    expect(text).toContain("(peer chain: ses_a -> ses_b)")
  })
})

describe("extractReply", () => {
  const outgoing = "the exact text we sent"

  test("waits when nothing was delivered yet", () => {
    expect(extractReply([], { anchorId: "msg_u1", altText: outgoing }).status).toBe("waiting")
  })

  test("ignores a completed turn that came before our message", () => {
    const messages = [
      { id: "msg_old_u", type: "user", text: "older question" },
      assistant({ id: "msg_old_a", content: [{ type: "text", text: "older answer" }] }),
      { id: "msg_u1", type: "user", text: outgoing },
    ]
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing }).status).toBe("waiting")
  })

  test("returns only the reply after the anchor", () => {
    const messages = [
      { id: "msg_old_u", type: "user", text: "older question" },
      assistant({ id: "msg_old_a", content: [{ type: "text", text: "older answer" }] }),
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ id: "msg_new_a", content: [{ type: "text", text: "fresh answer" }] }),
    ]
    const reply = extractReply(messages, { anchorId: "msg_u1", altText: outgoing })
    expect(reply.status).toBe("done")
    expect(reply.text).toBe("fresh answer")
  })

  test("falls back to matching the sent text when the id is unknown", () => {
    const messages = [{ id: "msg_u9", type: "user", text: outgoing }, assistant({ content: [{ type: "text", text: "ok" }] })]
    expect(extractReply(messages, { anchorId: "msg_missing", altText: outgoing }).text).toBe("ok")
  })

  test("waits while a tool is still running", () => {
    const messages = [
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ content: [{ type: "tool", state: { status: "running" } }] }),
    ]
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing }).status).toBe("waiting")
  })

  test("waits on an incomplete assistant message", () => {
    const messages = [
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ time: { created: 1 } }),
    ]
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing }).status).toBe("waiting")
  })

  test("tool-calls finish needs an idle peer to count as done", () => {
    const messages = [
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ finish: "tool-calls", content: [{ type: "text", text: "step" }] }),
    ]
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing }).status).toBe("waiting")
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing, peerIdle: true }).status).toBe("done")
  })

  test("surfaces a peer error", () => {
    const messages = [
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ error: { type: "provider.error", message: "boom" } }),
    ]
    const reply = extractReply(messages, { anchorId: "msg_u1", altText: outgoing })
    expect(reply.status).toBe("error")
    expect(reply.error).toBe("boom")
  })

  test("joins text across a multi-message turn", () => {
    const messages = [
      { id: "msg_u1", type: "user", text: outgoing },
      assistant({ id: "msg_a1", content: [{ type: "text", text: "part one" }] }),
      assistant({ id: "msg_a2", finish: "stop", content: [{ type: "text", text: "part two" }] }),
    ]
    expect(extractReply(messages, { anchorId: "msg_u1", altText: outgoing }).text).toBe("part one\n\npart two")
  })
})

describe("lastAssistantText", () => {
  test("reads back to the newest assistant with text", () => {
    const messages = [assistant({ content: [{ type: "text", text: "old" }] }), assistant({ content: [{ type: "reasoning", text: "think" }] })]
    expect(lastAssistantText(messages)).toBe("old")
  })
  test("returns undefined with no text", () => {
    expect(lastAssistantText([])).toBeUndefined()
  })
})

describe("selectSession", () => {
  const sessions = [
    {
      id: "ses_new",
      title: "adding newPremium field",
      time: { updated: 300 },
      location: { directory: "/Users/me/work/frontend-app" },
    },
    {
      id: "ses_old",
      title: "old work",
      time: { updated: 100 },
      location: { directory: "/Users/me/work/frontend-app" },
    },
    { id: "ses_api", title: "api endpoint", time: { updated: 200 }, location: { directory: "/Users/me/work/backend-api" } },
    { id: "ses_child", parentID: "ses_new", time: { updated: 400 }, location: { directory: "/Users/me/work/frontend-app" } },
    {
      id: "ses_archived",
      time: { updated: 500, archived: 600 },
      location: { directory: "/Users/me/work/frontend-app" },
    },
  ]
  const references = [
    { name: "frontend-app", path: "/Users/me/work/frontend-app" },
    { name: "backend-api", path: "/Users/me/work/backend-api" },
  ]

  test("resolves a reference name to the newest root session", () => {
    expect(selectSession(sessions, { target: "frontend-app", references })?.id).toBe("ses_new")
  })
  test("resolves an absolute path", () => {
    expect(selectSession(sessions, { target: "/Users/me/work/backend-api", references })?.id).toBe("ses_api")
  })
  test("resolves a directory basename", () => {
    expect(selectSession(sessions, { target: "backend-api", references })?.id).toBe("ses_api")
  })
  test("resolves a title fragment", () => {
    expect(selectSession(sessions, { target: "newPremium", references })?.id).toBe("ses_new")
  })
  test("skips children and archived sessions", () => {
    expect(selectSession(sessions, { target: "frontend-app", references })?.parentID).toBeUndefined()
  })
  test("never returns the caller", () => {
    const picked = selectSession(sessions, { target: "frontend-app", references, excludeID: "ses_new" })
    expect(picked?.id).toBe("ses_old")
  })
  test("returns undefined for no match", () => {
    expect(selectSession(sessions, { target: "does-not-exist", references })).toBeUndefined()
  })
})

describe("directory helpers", () => {
  test("sameDir ignores trailing slashes and case", () => {
    expect(sameDir("/tmp/Repo/", "/tmp/repo")).toBe(true)
    expect(sameDir("/tmp/repo", "/tmp/other")).toBe(false)
  })
  test("labelForDirectory prefers the reference name", () => {
    const refs = [{ name: "frontend-app", path: "/Users/me/work/frontend-app" }]
    expect(labelForDirectory("/Users/me/work/frontend-app/", refs)).toBe("frontend-app")
    expect(labelForDirectory("/Users/me/work/backend-api", refs)).toBe("backend-api")
  })
  test("isRootSession", () => {
    expect(isRootSession({ id: "x" })).toBe(true)
    expect(isRootSession({ id: "x", parentID: "ses_p" })).toBe(false)
    expect(isRootSession({ id: "x", time: { archived: 1 } })).toBe(false)
  })
})
