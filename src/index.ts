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
import { OpenCode, type OpenCodeClient, type SessionActive, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"

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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Shapes this plugin consumes. Kept minimal on purpose: the plugin session API
// and the local client return different but structurally compatible types, and
// both satisfy these.
// ---------------------------------------------------------------------------

export interface ContentPartLike {
  readonly type: string
  readonly text?: string
  readonly state?: { readonly status?: string }
}

export interface MessageLike {
  readonly id?: string
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<ContentPartLike>
  readonly time?: {
    readonly created?: number
    readonly updated?: number
    readonly completed?: number
    readonly archived?: number
  }
  readonly finish?: string
  readonly error?: unknown
  readonly metadata?: unknown
}

export interface SessionLike {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly time?: { readonly updated?: number; readonly archived?: number }
  readonly location?: { readonly directory?: string }
}

export interface ReferenceLike {
  readonly name: string
  readonly path: string
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
  return path.replace(/\/+$/, "").toLowerCase()
}

export function sameDir(a: string | undefined, b: string | undefined): boolean {
  return normalizeDir(a) !== "" && normalizeDir(a) === normalizeDir(b)
}

export function labelForDirectory(directory: string | undefined, references: ReadonlyArray<ReferenceLike>): string {
  const reference = references.find((entry) => sameDir(entry.path, directory))
  if (reference) return reference.name
  return basename((directory ?? "").replace(/\/+$/, "")) || "unknown"
}

export function isRootSession(session: SessionLike): boolean {
  return !session.parentID && !session.time?.archived
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

export function assistantText(message: MessageLike): string {
  const content = message.content ?? []
  return content
    .filter((part): part is ContentPartLike & { text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

export function hasRunningTool(message: MessageLike): boolean {
  const content = message.content ?? []
  return content.some(
    (part) => part.type === "tool" && (part.state?.status === "running" || part.state?.status === "streaming"),
  )
}

export function describeMessageError(error: unknown): string {
  if (typeof error === "string") return error
  const record = asRecord(error)
  if (typeof record.message === "string") return record.message
  if (typeof record.type === "string") return record.type
  return "unknown error"
}

export type ReplyState = { status: "waiting" | "done" | "error"; text: string; error?: string }

/**
 * Read the peer's answer out of its message list. The anchor is the message we
 * delivered, matched by id first and then by exact text; only assistant messages
 * after it count, so a busy target cannot leak an earlier reply.
 */
export function extractReply(
  messages: ReadonlyArray<MessageLike>,
  opts: { anchorId?: string; altText: string; peerIdle?: boolean },
): ReplyState {
  let index = -1
  if (opts.anchorId) index = messages.findIndex((message) => message.id === opts.anchorId)
  if (index === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue
      if ((message.type === "user" || message.type === "synthetic") && message.text === opts.altText) {
        index = i
        break
      }
    }
  }
  if (index === -1) return { status: "waiting", text: "" }

  const assistants = messages.slice(index + 1).filter((message) => message.type === "assistant")
  const text = assistants
    .map(assistantText)
    .filter(Boolean)
    .join("\n\n")
  if (assistants.length === 0) return { status: "waiting", text }

  const last = assistants[assistants.length - 1]
  if (!last) return { status: "waiting", text }
  if (last.error) return { status: "error", text, error: describeMessageError(last.error) }
  if (hasRunningTool(last)) return { status: "waiting", text }
  if (!last.time?.completed) return { status: "waiting", text }
  if (last.finish === "tool-calls" && !opts.peerIdle) return { status: "waiting", text }
  return { status: "done", text }
}

export function lastAssistantText(messages: ReadonlyArray<MessageLike>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== "assistant") continue
    const text = assistantText(message)
    if (text) return text
  }
  return undefined
}

/** Pick the session a target string refers to. Input order does not matter. */
export function selectSession(
  sessions: ReadonlyArray<SessionLike>,
  opts: { target: string; references?: ReadonlyArray<ReferenceLike>; excludeID?: string },
): SessionLike | undefined {
  const target = opts.target.trim()
  if (!target) return undefined
  const references = opts.references ?? []
  const needle = target.toLowerCase()
  const pool = sessions
    .filter((session) => isRootSession(session) && session.id !== opts.excludeID)
    .slice()
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

  const reference = references.find((entry) => entry.name.toLowerCase() === needle)
  if (reference) {
    const match = pool.find((session) => sameDir(session.location?.directory, reference.path))
    if (match) return match
  }
  if (target.startsWith("/") || target.startsWith("~")) {
    const directory = homeExpanded(target)
    const match = pool.find((session) => sameDir(session.location?.directory, directory))
    if (match) return match
  }
  const byDirectory = pool.find((session) => basename(session.location?.directory ?? "").toLowerCase() === needle)
  if (byDirectory) return byDirectory
  return pool.find((session) => (session.title ?? "").toLowerCase().includes(needle))
}

export interface AskInput {
  target: string
  message: string
  mode: "queue" | "steer"
  wait: boolean
  deliver: "user" | "synthetic"
  timeoutMs: number
}

/** Validate the model-supplied tool input. Returns an error message instead of guessing. */
export function parseAskInput(input: unknown): AskInput | string {
  const record = asRecord(input)
  const target = typeof record.target === "string" ? record.target.trim() : ""
  if (!target) return "peer_ask needs a `target`: a session id, reference name, directory, or title fragment."
  const message = typeof record.message === "string" ? record.message.trim() : ""
  if (!message) return "peer_ask needs a non-empty `message` to send."
  return {
    target,
    message,
    mode: record.mode === "steer" ? "steer" : "queue",
    wait: record.wait !== false,
    deliver: record.deliver === "synthetic" ? "synthetic" : "user",
    timeoutMs: clampTimeout(record.timeout_ms),
  }
}

export function parseReadInput(input: unknown): string | undefined {
  const record = asRecord(input)
  const sessionID = typeof record.sessionID === "string" ? record.sessionID.trim() : ""
  return sessionID || undefined
}

/** The chain of sessions the message being answered has passed through. */
export function peerVia(message: MessageLike): string[] | undefined {
  const peer = asRecord(asRecord(message.metadata).peer)
  const via = peer.via
  if (!Array.isArray(via)) return undefined
  return via.filter((value): value is string => typeof value === "string")
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

interface Registration {
  url?: string
  password?: string
}

async function readRegistration(): Promise<Registration | undefined> {
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
      const raw: unknown = JSON.parse(await readFile(file, "utf8"))
      const record = asRecord(raw)
      if (typeof record.url === "string") {
        return { url: record.url, password: typeof record.password === "string" ? record.password : undefined }
      }
    } catch {}
  }
  return undefined
}

interface Connection {
  baseUrl: string
  headers?: Record<string, string>
}

async function resolveConnection(): Promise<Connection | undefined> {
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
    let client: OpenCodeClient | undefined

    async function getClient(): Promise<OpenCodeClient | undefined> {
      if (client) return client
      const connection = await resolveConnection().catch((error: unknown) => {
        log("could not resolve the OpenCode service", error)
        return undefined
      })
      if (!connection) return undefined
      client = OpenCode.make({ baseUrl: connection.baseUrl, headers: connection.headers })
      return client
    }

    function dropClient() {
      client = undefined
    }

    const CLIENT_UNAVAILABLE =
      "Session discovery needs the local OpenCode service, which is not reachable right now. Pass a session id (ses_...) explicitly, or retry."

    async function listSessions(): Promise<SessionInfo[]> {
      const found = await getClient()
      if (!found) throw new Error(CLIENT_UNAVAILABLE)
      try {
        const response = await found.session.list({ order: "desc", limit: LIST_LIMIT })
        return Array.isArray(response?.data) ? response.data : []
      } catch (error) {
        dropClient()
        throw error
      }
    }

    async function activeMap(): Promise<Record<string, SessionActive>> {
      const found = await getClient()
      if (!found) return {}
      try {
        return await found.session.active()
      } catch {
        return {}
      }
    }

    async function references(): Promise<ReferenceLike[]> {
      try {
        const response = await ctx.reference.list()
        const data = Array.isArray(response?.data) ? response.data : []
        return data.map((entry) => ({ name: entry.name, path: entry.path }))
      } catch {
        return []
      }
    }

    async function sessionInfo(sessionID: string): Promise<SessionInfo | undefined> {
      try {
        return await ctx.session.get({ sessionID })
      } catch {
        return undefined
      }
    }

    async function sessionContext(sessionID: string): Promise<MessageLike[]> {
      try {
        const messages = await ctx.session.context({ sessionID })
        return Array.isArray(messages) ? messages : []
      } catch (error) {
        log(`could not read the context of ${sessionID}`, error)
        return []
      }
    }

    interface ResolvedTarget {
      sessionID: string
      title?: string
      directory?: string
      label: string
    }

    async function resolveTarget(target: string): Promise<ResolvedTarget | string> {
      const wanted = target.trim()
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
      let sessions: SessionInfo[]
      try {
        sessions = await listSessions()
      } catch (error) {
        return `Could not list sessions (${errorMessage(error)}). Use peer_list for details, or pass a session id (ses_...).`
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

    async function inboundChain(caller: string): Promise<string[]> {
      const messages = await sessionContext(caller)
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message) continue
        const via = peerVia(message)
        if (via) return via
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
        execute: async (_input: unknown, toolContext: ToolContext) => {
          const caller = toolContext.sessionID
          const found = await getClient()
          if (!found) {
            return {
              content: `${CLIENT_UNAVAILABLE} You can still call peer_ask with an explicit session id (ses_...).`,
              metadata: { ok: false, reason: "service-unreachable" },
            }
          }
          try {
            const [sessions, active, refs] = await Promise.all([listSessions(), activeMap(), references()])
            const roots = sessions.filter(isRootSession)
            const now = Date.now()
            const shown = roots.slice(0, LIST_SHOW)
            const rows = shown.map((session) => {
              const label = labelForDirectory(session.location?.directory, refs)
              const state = active[session.id] ? "busy" : "idle"
              const mine = session.id === caller ? " | you" : ""
              const title = session.title?.trim() ? session.title.trim() : "(untitled)"
              const updated = agoLabel(now - (session.time?.updated ?? now))
              return `- ${label} | ${session.id} | ${state} | ${updated} | ${title}${mine}`
            })
            const hidden = roots.length - shown.length
            const lines = [
              `OpenCode sessions in this runtime (${roots.length} total${hidden > 0 ? `, ${hidden} not shown` : ""}):`,
              ...rows,
            ]
            return {
              content: lines.join("\n"),
              metadata: { ok: true, count: roots.length, sessions: shown.map((session) => session.id) },
            }
          } catch (error) {
            dropClient()
            log("peer_list failed", error)
            return {
              content: `Could not list sessions: ${errorMessage(error)}`,
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
          'Set deliver="synthetic" if the peer\'s user transcript should stay clean (agent-notification entry instead of a user turn).',
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
        execute: async (input: unknown, toolContext: ToolContext) => {
          const caller: string = toolContext.sessionID
          try {
            const parsed = parseAskInput(input)
            if (typeof parsed === "string") return { content: parsed, metadata: { ok: false } }

            const resolved = await resolveTarget(parsed.target)
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
              message: parsed.message,
            })
            const from: Record<string, string | number> = { sessionID: caller, label: fromLabel }
            const directory = me?.location?.directory
            if (directory) from.directory = directory
            const metadata = {
              peer: { v: 1, from, via: [...chain, caller] },
            }

            let inboxID: string | undefined
            try {
              if (parsed.deliver === "synthetic") {
                const inbox = await ctx.session.synthetic({
                  sessionID: resolved.sessionID,
                  text,
                  description: `peer message from ${fromLabel}`,
                  metadata,
                  delivery: parsed.mode,
                })
                inboxID = inbox.id
              } else {
                const inbox = await ctx.session.prompt({
                  sessionID: resolved.sessionID,
                  text,
                  metadata,
                  delivery: parsed.mode,
                })
                inboxID = inbox.id
              }
            } catch (error) {
              return {
                content: `Could not deliver to ${resolved.label} (${resolved.sessionID}): ${errorMessage(error)}`,
                metadata: { ok: false, sessionID: resolved.sessionID },
              }
            }

            const where = `${resolved.label}${resolved.title?.trim() ? ` "${shrink(resolved.title)}"` : ""} (${resolved.sessionID})`
            if (!parsed.wait) {
              return {
                content: `Delivered to ${where}. Not waiting (wait=false) — fetch the reply later with peer_read.`,
                metadata: { ok: true, status: "sent", sessionID: resolved.sessionID, mode: parsed.mode },
              }
            }

            try {
              await toolContext.progress({ sessionID: resolved.sessionID, status: "waiting for peer reply" })
            } catch {}

            const started = Date.now()
            const deadline = started + parsed.timeoutMs
            let partial = ""
            let interval = POLL_FAST_MS
            for (;;) {
              if (toolContext.signal.aborted) {
                return {
                  content: `Stopped waiting for ${where}. The message was delivered and the peer may still answer — use peer_read to fetch it later.`,
                  metadata: { ok: false, status: "aborted", sessionID: resolved.sessionID },
                }
              }
              const messages = await sessionContext(resolved.sessionID)
              const active = await activeMap()
              const activeIDs = Object.keys(active)
              const reply = extractReply(messages, {
                anchorId: inboxID,
                altText: text,
                peerIdle: activeIDs.length === 0 ? false : !active[resolved.sessionID],
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
                    `No final reply yet from ${where} after ${elapsedLabel(parsed.timeoutMs)} — it is still working.`,
                    "Partial text so far:",
                    "---",
                    partial || "(none yet)",
                    `Fetch the final reply later with peer_read { "sessionID": "${resolved.sessionID}" }.`,
                  ].join("\n"),
                  metadata: {
                    ok: false,
                    status: "timeout",
                    sessionID: resolved.sessionID,
                    elapsed_ms: Date.now() - started,
                  },
                }
              }
              await sleep(interval, toolContext.signal)
              if (Date.now() - started > POLL_FAST_WINDOW_MS) interval = POLL_SLOW_MS
            }
          } catch (error) {
            log("peer_ask failed", error)
            return { content: `peer_ask failed: ${errorMessage(error)}`, metadata: { ok: false } }
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
        execute: async (input: unknown) => {
          const sessionID = parseReadInput(input)
          if (!sessionID) return { content: "No session id given.", metadata: { ok: false } }
          const info = await sessionInfo(sessionID)
          if (!info) {
            return { content: `Session ${sessionID} was not found in this runtime.`, metadata: { ok: false } }
          }
          const text = lastAssistantText(await sessionContext(sessionID))
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
