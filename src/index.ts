/**
 * session-bridge: let agents in different OpenCode sessions talk to each other.
 *
 * Typical use: the agent working in one repo asks the agent working in another
 * repo a question (or hands it a task) and waits for the reply. Both sessions
 * live in the same shared background service (the OpenCode V2 default), so a
 * prompt addressed to any session id reaches it regardless of location/project.
 *
 * Tools:
 *   - peer_ask    send a message to another session and (by default) wait for its reply
 *   - peer_list   list sessions in this runtime, with reference names and busy state
 *   - peer_read   read the last assistant reply of another session
 *
 * Notes from verifying against opencode v2.0.20:
 *   - `ctx.session` has no `list`, so peer discovery uses a local client
 *     (`@opencode/client` + `@opencode/client/service`). An unfiltered
 *     `session.list` is runtime-wide, so one call covers every project.
 *   - `ctx.session.prompt` wakes an idle session; `delivery: "queue"` defers the
 *     message to the target's next turn boundary.
 *   - The reply is read from `ctx.session.context`, anchored to the inbox id of
 *     the message we sent, so a target that was already busy cannot leak a
 *     previous answer into the result.
 *   - Each delivered message carries `metadata.peer.via`, the chain of sessions
 *     it passed through. Before sending, the chain is read back from the
 *     caller's context and checked against the target.
 *
 * Limits:
 *   - One runtime only. `--standalone` servers are separate and cannot see each
 *     other.
 *   - The hop-chain guard needs the peer to run session-bridge too.
 *   - Peer messages are untrusted input: the peer answers with its own tools and
 *     permissions, so a message can cause file edits.
 *   - A pending permission prompt leaves peer_ask waiting until it is answered
 *     or the call times out.
 *
 * v2 backlog: deliver replies back asynchronously through `ctx.session.synthetic`
 * with the pending ask kept in `ctx.storage`; cross-plugin registry.
 */
import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Plugin } from "@opencode/plugin"

const PREFIX = "[session-bridge]"
const HOP_LIMIT = 4
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MIN_TIMEOUT_MS = 1_000
const LIST_LIMIT = 100
const LIST_SHOW = 25
const POLL_FAST_MS = 400
const POLL_SLOW_MS = 1_200
const POLL_FAST_WINDOW_MS = 15_000
const NO_TEXT = "(peer completed without a text reply)"

function log(...args: unknown[]) {
  console.warn(PREFIX, ...args)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function clampTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(n)))
}

export function homeExpanded(path: string): string {
  if (path === "~") return homedir()
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

export function normalizeDir(path: string | undefined): string {
  if (!path) return ""
  const trimmed = path.replace(/\/+$/, "")
  return trimmed.toLowerCase()
}

export function sameDir(a: string | undefined, b: string | undefined): boolean {
  return normalizeDir(a) !== "" && normalizeDir(a) === normalizeDir(b)
}

export function labelForDirectory(directory: string | undefined, references: Array<{ name: string; path: string }>): string {
  const ref = references.find((r) => sameDir(r.path, directory))
  if (ref) return ref.name
  return basename((directory ?? "").replace(/\/+$/, "")) || "unknown"
}

export function isRootSession(session: any): boolean {
  return Boolean(session) && !session.parentID && !session.time?.archived
}

export function formatPeerMessage(input: {
  label: string
  sessionID: string
  chain: string[]
  message: string
}): string {
  const lines = [
    `[peer message] from another agent session — ${input.label} (${input.sessionID})`,
    "This is not your user typing. Answer in your final message; that text is returned to the sender verbatim. Work in your own project as usual, and do not forward the question back through the peer tool.",
    "If a decision only a human can make is needed, state it as an open question in your reply — the sender relays it. Do not wait for an answer.",
  ]
  if (input.chain.length > 0) lines.push(`(peer chain: ${input.chain.join(" -> ")})`)
  lines.push("", input.message)
  return lines.join("\n")
}

export function checkGuard(input: { caller: string; target: string; chain: string[] }): string | undefined {
  if (input.target === input.caller) return "Refusing: the target session is this same session."
  if (input.chain.includes(input.target))
    return `Refusing: peer chain would loop (${input.target} is already in: ${input.chain.join(" -> ")}). Answer in your own reply instead.`
  if (input.chain.length >= HOP_LIMIT)
    return `Refusing: peer hop limit (${HOP_LIMIT}) reached (${input.chain.join(" -> ")}). Answer in your own reply instead.`
  return undefined
}

export function assistantText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("")
}

export function hasRunningTool(message: any): boolean {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.some(
    (part: any) => part?.type === "tool" && (part?.state?.status === "running" || part?.state?.status === "streaming"),
  )
}

export function describeMessageError(error: any): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message
    if (typeof error.type === "string") return error.type
  }
  return "unknown error"
}

export type ReplyState = { status: "waiting" | "done" | "error"; text: string; error?: string }

/**
 * Read the peer's answer out of its message list. The anchor is the message we
 * delivered, matched by id first and then by exact text; only assistant messages
 * after it count, so a busy target cannot leak an earlier reply.
 */
export function extractReply(
  messages: any,
  opts: { anchorId?: string; altText: string; peerIdle?: boolean },
): ReplyState {
  const list = Array.isArray(messages) ? messages : []
  let index = -1
  if (opts.anchorId) index = list.findIndex((m: any) => m?.id === opts.anchorId)
  if (index === -1) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if ((m?.type === "user" || m?.type === "synthetic") && m?.text === opts.altText) {
        index = i
        break
      }
    }
  }
  if (index === -1) return { status: "waiting", text: "" }

  const assistants = list.slice(index + 1).filter((m: any) => m?.type === "assistant")
  const text = assistants
    .map(assistantText)
    .filter(Boolean)
    .join("\n\n")
  if (assistants.length === 0) return { status: "waiting", text }

  const last = assistants[assistants.length - 1]
  if (last?.error) return { status: "error", text, error: describeMessageError(last.error) }
  if (hasRunningTool(last)) return { status: "waiting", text }
  if (!last?.time?.completed) return { status: "waiting", text }
  if (last.finish === "tool-calls" && !opts.peerIdle) return { status: "waiting", text }
  return { status: "done", text }
}

export function lastAssistantText(messages: any): string | undefined {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.type !== "assistant") continue
    const text = assistantText(m)
    if (text) return text
  }
  return undefined
}

/** Pick the session a target string refers to. Input order does not matter. */
export function selectSession(
  sessions: any,
  opts: { target: string; references?: Array<{ name: string; path: string }>; excludeID?: string },
): any | undefined {
  const target = String(opts.target ?? "").trim()
  if (!target) return undefined
  const references = opts.references ?? []
  const pool = (Array.isArray(sessions) ? sessions : [])
    .filter((s: any) => isRootSession(s) && s.id !== opts.excludeID)
    .slice()
    .sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

  const reference = references.find((r) => r?.name?.toLowerCase() === target.toLowerCase())
  if (reference) {
    const match = pool.find((s: any) => sameDir(s.location?.directory, reference.path))
    if (match) return match
  }
  if (target.startsWith("/") || target.startsWith("~")) {
    const dir = homeExpanded(target)
    const match = pool.find((s: any) => sameDir(s.location?.directory, dir))
    if (match) return match
  }
  const byDirectory = pool.find((s: any) => basename(s.location?.directory ?? "").toLowerCase() === target.toLowerCase())
  if (byDirectory) return byDirectory
  const needle = target.toLowerCase()
  return pool.find((s: any) => (s.title ?? "").toLowerCase().includes(needle))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      done()
    })
  })
}

function shrink(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function elapsedLabel(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`
}

function agoLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown"
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

// ---------------------------------------------------------------------------
// Service discovery / local client
// ---------------------------------------------------------------------------

function normalizeServiceUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::" || parsed.hostname === "[::]") {
      parsed.hostname = "127.0.0.1"
    }
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return url
  }
}

async function readRegistration(): Promise<{ url?: string; password?: string } | undefined> {
  const dir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode")
  const files: string[] = [join(dir, "service.json")]
  try {
    for (const entry of await readdir(dir)) {
      if (entry.startsWith("service") && entry.endsWith(".json") && !files.includes(join(dir, entry))) {
        files.push(join(dir, entry))
      }
    }
  } catch {}
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"))
      if (raw && typeof raw.url === "string") {
        return { url: raw.url, password: typeof raw.password === "string" ? raw.password : undefined }
      }
    } catch {}
  }
  return undefined
}

async function resolveConnection(): Promise<{ baseUrl: string; headers?: Record<string, string> } | undefined> {
  try {
    const found = await Service.discover({ version: (version) => version.startsWith("2.") })
    if (found?.url) return { baseUrl: normalizeServiceUrl(found.url), headers: Service.headers(found) }
  } catch (error) {
    log("service discovery failed, falling back to the registration file", error)
  }
  const registration = await readRegistration()
  if (!registration?.url) return undefined
  const headers = registration.password
    ? { authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}` }
    : undefined
  return { baseUrl: normalizeServiceUrl(registration.url), headers }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "session-bridge",
  async setup(ctx) {
    let client: any
    let clientReady = false

    async function getClient(): Promise<any | undefined> {
      if (clientReady) return client
      const connection = await resolveConnection().catch((error) => {
        log("could not resolve the OpenCode service", error)
        return undefined
      })
      if (!connection) return undefined
      client = OpenCode.make({ baseUrl: connection.baseUrl, headers: connection.headers })
      clientReady = true
      return client
    }

    function dropClient() {
      client = undefined
      clientReady = false
    }

    /** Return the client, or an error message when the service is unreachable. */
    async function withClient(): Promise<any | string> {
      const found = await getClient()
      if (!found) {
        return "Session discovery needs the local OpenCode service, which is not reachable right now. Pass a session id (ses_...) explicitly, or retry."
      }
      return found
    }

    async function listSessions(): Promise<any[]> {
      const found = await withClient()
      if (typeof found === "string") throw new Error(found)
      try {
        const response = await found.session.list({ order: "desc", limit: LIST_LIMIT })
        return Array.isArray(response?.data) ? response.data : []
      } catch (error) {
        dropClient()
        throw error
      }
    }

    async function activeMap(): Promise<Record<string, any>> {
      const found = await getClient()
      if (!found) return {}
      try {
        return (await found.session.active()) ?? {}
      } catch {
        return {}
      }
    }

    async function references(): Promise<Array<{ name: string; path: string }>> {
      try {
        const response: any = await ctx.reference.list()
        const data = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
        return data
          .filter((entry: any) => entry && typeof entry.name === "string" && typeof entry.path === "string")
          .map((entry: any) => ({ name: entry.name, path: entry.path }))
      } catch {
        return []
      }
    }

    async function sessionInfo(sessionID: string): Promise<any | undefined> {
      try {
        return await ctx.session.get({ sessionID })
      } catch {
        return undefined
      }
    }

    async function context(sessionID: string): Promise<any[]> {
      try {
        const messages = await ctx.session.context({ sessionID })
        return Array.isArray(messages) ? messages : []
      } catch (error) {
        log(`could not read the context of ${sessionID}`, error)
        return []
      }
    }

    async function resolveTarget(
      target: string,
    ): Promise<{ sessionID: string; title?: string; directory?: string; label: string } | string> {
      const wanted = String(target ?? "").trim()
      if (!wanted) return "No target given. Use peer_list to see available sessions, or pass a session id (ses_...)."
      if (/^ses_/.test(wanted)) {
        const info = await sessionInfo(wanted)
        if (!info) return `Session ${wanted} was not found in this runtime.`
        const refs = await references()
        return {
          sessionID: wanted,
          title: info.title,
          directory: info.location?.directory,
          label: labelForDirectory(info.location?.directory, refs),
        }
      }
      let sessions: any[]
      try {
        sessions = await listSessions()
      } catch (error) {
        return `Could not list sessions (${String(error instanceof Error ? error.message : error)}). Use peer_list for details, or pass a session id (ses_...).`
      }
      const refs = await references()
      const match = selectSession(sessions, { target: wanted, references: refs })
      if (!match) {
        return `No session matched "${wanted}". Use peer_list to see available sessions, or pass a session id (ses_...).`
      }
      return {
        sessionID: match.id,
        title: match.title,
        directory: match.location?.directory,
        label: labelForDirectory(match.location?.directory, refs),
      }
    }

    /** The chain of sessions the message being answered has passed through. */
    async function inboundChain(caller: string): Promise<string[]> {
      const messages = await context(caller)
      for (let i = messages.length - 1; i >= 0; i--) {
        const via = messages[i]?.metadata?.peer?.via
        if (Array.isArray(via)) return via.filter((value: unknown): value is string => typeof value === "string")
      }
      return []
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "peer_list",
        description: [
          "List the OpenCode sessions running in this shared runtime, across every project, with their reference",
          "name (from opencode.json references), title, busy/idle state and id. Use it to pick the `target` for",
          "peer_ask, or to check whether the peer session is currently busy.",
        ].join(" "),
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: unknown, toolContext: any) => {
          const caller = toolContext.sessionID
          const found = await getClient()
          if (!found) {
            return {
              content:
                "Session discovery needs the local OpenCode service, which is not reachable right now. You can still call peer_ask with an explicit session id (ses_...).",
              metadata: { ok: false, reason: "service-unreachable" },
            }
          }
          try {
            const [sessions, active, refs] = await Promise.all([listSessions(), activeMap(), references()])
            const roots = sessions.filter(isRootSession)
            const now = Date.now()
            const rows = roots.slice(0, LIST_SHOW).map((session: any) => {
              const label = labelForDirectory(session.location?.directory, refs)
              const state = active[session.id] ? "busy" : "idle"
              const mine = session.id === caller ? " | you" : ""
              const title = session.title?.trim() ? session.title.trim() : "(untitled)"
              const updated = agoLabel(now - (session.time?.updated ?? now))
              return `- ${label} | ${session.id} | ${state} | ${updated} | ${title}${mine}`
            })
            const hidden = roots.length - rows.length
            const lines = [
              `OpenCode sessions in this runtime (${roots.length} total${hidden > 0 ? `, ${hidden} not shown` : ""}):`,
              ...rows,
            ]
            return {
              content: lines.join("\n"),
              metadata: { ok: true, count: roots.length, sessions: roots.slice(0, LIST_SHOW).map((s: any) => s.id) },
            }
          } catch (error) {
            dropClient()
            log("peer_list failed", error)
            return {
              content: `Could not list sessions: ${String(error instanceof Error ? error.message : error)}`,
              metadata: { ok: false },
            }
          }
        },
      })

      editor.add({
        name: "peer_ask",
        description: [
          "Send a message to an agent in another OpenCode session and (by default) wait for its reply.",
          "`target` accepts a session id (ses_...), a reference name from opencode.json, an absolute directory,",
          "or a title fragment — use peer_list to see what is available.",
          "Delivery is queued, so a busy peer answers after its current turn; the peer uses its own tools and",
          "permissions, so this can take a while (or time out). Do not use it to relay a question back to a",
          "session that is already in the peer chain — answer in your own reply instead.",
          "Set deliver=\"synthetic\" if the peer's user transcript should stay clean (agent-notification entry instead of a user turn).",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            target: { type: "string", description: "Session id, reference name, directory path, or title fragment." },
            message: { type: "string", description: "The message to send to the peer agent." },
            mode: {
              type: "string",
              enum: ["queue", "steer"],
              description:
                "Delivery mode. queue (default) waits for the peer's next turn boundary; steer lands at its next step boundary mid-turn.",
            },
            wait: { type: "boolean", description: "Wait for the peer's reply (default true). false returns after delivery." },
            deliver: {
              type: "string",
              enum: ["user", "synthetic"],
              description:
                "How the peer receives the message. user (default) is a normal user turn; synthetic is an agent-notification entry. The model sees the same text either way; synthetic keeps the peer's user transcript clean.",
            },
            timeout_ms: {
              type: "number",
              description: `How long to wait for the reply, in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
            },
          },
          required: ["target", "message"],
          additionalProperties: false,
        },
        execute: async (input: any, toolContext: any) => {
          const caller: string = toolContext.sessionID
          try {
            const resolved = await resolveTarget(input?.target ?? "")
            if (typeof resolved === "string") return { content: resolved, metadata: { ok: false } }

            const chain = await inboundChain(caller)
            const guard = checkGuard({ caller, target: resolved.sessionID, chain })
            if (guard) return { content: guard, metadata: { ok: false, reason: "guard" } }

            const refs = await references()
            const me = await sessionInfo(caller)
            const fromLabel = labelForDirectory(me?.location?.directory, refs)
            const text = formatPeerMessage({
              label: fromLabel,
              sessionID: caller,
              chain,
              message: String(input?.message ?? ""),
            })
            const metadata = {
              peer: {
                v: 1,
                from: { sessionID: caller, directory: me?.location?.directory, label: fromLabel },
                via: [...chain, caller],
              },
            }
            const mode = input?.mode === "steer" ? "steer" : "queue"
            const timeout = clampTimeout(input?.timeout_ms)
            const synthetic = input?.deliver === "synthetic"

            let inbox: any
            try {
              inbox = synthetic
                ? await ctx.session.synthetic({
                    sessionID: resolved.sessionID,
                    text,
                    description: `peer message from ${fromLabel}`,
                    metadata,
                    delivery: mode,
                  } as any)
                : await ctx.session.prompt({
                    sessionID: resolved.sessionID,
                    text,
                    metadata,
                    delivery: mode,
                  } as any)
            } catch (error) {
              return {
                content: `Could not deliver to ${resolved.label} (${resolved.sessionID}): ${String(error instanceof Error ? error.message : error)}`,
                metadata: { ok: false, sessionID: resolved.sessionID },
              }
            }

            const where = `${resolved.label}${resolved.title?.trim() ? ` "${shrink(resolved.title)}"` : ""} (${resolved.sessionID})`
            if (input?.wait === false) {
              return {
                content: `Delivered to ${where}. Not waiting (wait=false) — fetch the reply later with peer_read.`,
                metadata: { ok: true, status: "sent", sessionID: resolved.sessionID, mode },
              }
            }

            try {
              await toolContext.progress?.({ sessionID: resolved.sessionID, status: "waiting for peer reply" })
            } catch {}

            const started = Date.now()
            const deadline = started + timeout
            let partial = ""
            let interval = POLL_FAST_MS
            for (;;) {
              if (toolContext.signal?.aborted) {
                return {
                  content: `Stopped waiting for ${where}. The message was delivered and the peer may still answer — use peer_read to fetch it later.`,
                  metadata: { ok: false, status: "aborted", sessionID: resolved.sessionID },
                }
              }
              const messages = await context(resolved.sessionID)
              const active = await activeMap()
              const reply = extractReply(messages, {
                anchorId: inbox?.id,
                altText: text,
                peerIdle: Object.keys(active).length === 0 ? false : !active[resolved.sessionID],
              })
              if (reply.status === "done") {
                return {
                  content: `Reply from ${where} in ${elapsedLabel(Date.now() - started)}:\n---\n${reply.text || NO_TEXT}`,
                  metadata: {
                    ok: true,
                    status: "done",
                    sessionID: resolved.sessionID,
                    elapsed_ms: Date.now() - started,
                  },
                }
              }
              if (reply.status === "error") {
                return {
                  content: `${where} failed while answering: ${reply.error}\n---\n${reply.text}`.trimEnd(),
                  metadata: { ok: false, status: "peer-error", sessionID: resolved.sessionID, error: reply.error },
                }
              }
              if (reply.text) partial = reply.text
              if (Date.now() >= deadline) {
                return {
                  content: [
                    `No final reply yet from ${where} after ${elapsedLabel(timeout)} — it is still working.`,
                    "Partial text so far:",
                    "---",
                    partial || "(none yet)",
                    `Fetch the final reply later with peer_read { "sessionID": "${resolved.sessionID}" }.`,
                  ].join("\n"),
                  metadata: { ok: false, status: "timeout", sessionID: resolved.sessionID, elapsed_ms: Date.now() - started },
                }
              }
              await sleep(interval, toolContext.signal)
              if (Date.now() - started > POLL_FAST_WINDOW_MS) interval = POLL_SLOW_MS
            }
          } catch (error) {
            log("peer_ask failed", error)
            return {
              content: `peer_ask failed: ${String(error instanceof Error ? error.message : error)}`,
              metadata: { ok: false },
            }
          }
        },
      })

      editor.add({
        name: "peer_read",
        description:
          "Read the last assistant reply of another session. Use it to fetch a peer's answer later, after peer_ask timed out or returned early.",
        input: {
          type: "object",
          properties: { sessionID: { type: "string", description: "Session id to read (ses_...)." } },
          required: ["sessionID"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const sessionID = String(input?.sessionID ?? "").trim()
          if (!sessionID) return { content: "No session id given.", metadata: { ok: false } }
          const info = await sessionInfo(sessionID)
          if (!info) {
            return { content: `Session ${sessionID} was not found in this runtime.`, metadata: { ok: false } }
          }
          const text = lastAssistantText(await context(sessionID))
          if (!text) {
            return {
              content: `No assistant text found in ${sessionID} yet.`,
              metadata: { ok: true, sessionID, found: false },
            }
          }
          const title = info.title?.trim() ? ` — ${shrink(info.title)}` : ""
          return {
            content: `Last reply from ${sessionID}${title}:\n---\n${text}`,
            metadata: { ok: true, sessionID, found: true },
          }
        },
      })
    })
  },
})
