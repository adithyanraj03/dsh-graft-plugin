/**
 * graft-status — show which graft graph this dsh is actually serving.
 *
 * WHY THIS EXISTS
 *
 * The `mcp-graft` row in the web profile spawns `graft mcp` once per dsh boot,
 * with no directory argument, so graft resolves "nearest ancestor with a graft/
 * index" from dsh's working directory. That is invisible from the UI: the
 * composer shows the model and the workspace, but nothing says which repo's
 * graph the graft tools answer from — or whether that graph still matches the
 * code.
 *
 * Getting this wrong is not a small confusion. An earlier version of the MCP
 * row pinned graft to ~/.dsh; a session opened on another project silently got
 * answers about the harness instead, and the only symptom was a freshness
 * check reporting a node count that belonged to a different repo.
 *
 * WHICH DIRECTORY IT RESOLVES FROM
 *
 * The SESSION's cwd (`session.header.cwd`), falling back to `process.cwd()`
 * only when a session has none.
 *
 * An earlier version used `process.cwd()` alone, reasoning that it matched what
 * `graft mcp` resolves and so could never disagree with the tools. In practice
 * that made it agree with the tools about the wrong repo: dsh launched from a
 * home directory while the session's workspace was a project elsewhere, and the
 * chip reported "no graft index above C:\\Users\\adith" for a workspace that has
 * a perfectly good index. Matching a stale answer is not consistency.
 *
 * The MCP server cannot follow suit — one stdio child is spawned per dsh boot,
 * so its root is fixed at launch. When the two disagree, this one is right
 * about the workspace and the MCP tools are answering about wherever dsh was
 * started. Launching dsh from the repo makes both agree.
 *
 * WHAT IT NEVER DOES
 *
 * Pure reads of files graft already writes. It never runs `graft`, never
 * writes to the index, and never makes a network request — so it cannot make
 * a graph stale, and it costs nothing when graft is absent.
 *
 * @module graft-status
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { createAutoSync } from './auto-sync.js'
import { createGraftCommand } from './command.js'
import { graftTools, resolveGraftCommand } from './graft-tools.js'

export const name = 'graft-status'

/**
 * The tool registry, for the model-facing graft tools.
 *
 * Everything else this plugin reads is a file on disk, deliberately, so a
 * missing service can never take the chip down.
 */
export const inject = ['tools']

/**
 * How long a computed status is reused before the files are read again.
 *
 * The dock re-renders on every session switch and the component polls, so
 * without this the same three files would be read many times a second. Five
 * seconds is under the interval at which graft's own hooks rewrite the cache,
 * so the chip still moves promptly when the graph does.
 */
const CACHE_MS = 5000

/**
 * The repository root graft would serve from `start`.
 *
 * Mirrors `graft mcp`'s own rule — nearest ancestor containing a `graft/`
 * directory — by testing for the artifacts graft writes rather than the
 * directory alone, because an empty `graft/` folder left behind by a removed
 * index would otherwise shadow a real one higher up.
 */
export async function findGraftRoot(start, exists) {
  let dir = start
  for (;;) {
    for (const probe of ['.cache/stats.json', '.graph/wiring.json', 'INDEX.md']) {
      if (await exists(join(dir, 'graft', probe))) return dir
    }
    const parent = dirname(dir)
    // `dirname` of a filesystem root returns the root itself; that fixed point
    // is the only reliable stop signal across platforms, and it is why this
    // walks with `dirname` rather than counting separators.
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * The directory to resolve a graft root from, for one session.
 *
 * `session.header.cwd` is what dsh recorded as that session's workspace — the
 * same value its entry in the session list shows — so it is right even when dsh
 * itself was launched somewhere else entirely. That case is not hypothetical:
 * dsh started from a home directory reported "no graft index above
 * C:\\Users\\adith" for a session whose workspace had a perfectly good one.
 *
 * `fallback` (the process cwd) is the last resort, for a session with no
 * recorded cwd or before any session exists.
 */
export function cwdForSession(sessions, sessionId, fallback) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return fallback
  try {
    const cwd = sessions?.get?.(sessionId)?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback
  } catch {
    // No sessions service, or an id it does not know.
    return fallback
  }
}

/**
 * Freshness as one short word.
 *
 * `syncing` outranks `dirty` because it is the more specific state: a sync in
 * flight is always over a dirty graph, and reporting the dirt would tell the
 * reader to do the thing already happening.
 */
export function freshnessOf(stats) {
  if (stats === null || typeof stats !== 'object') return 'unknown'
  if (stats.syncing === true) return 'syncing'
  if (stats.dirty === true) return 'stale'
  if (typeof stats.staleCount === 'number' && stats.staleCount > 0) return 'stale'
  return 'synced'
}

/** Node and edge counts read straight off a wiring graph, when no cache exists. */
export function countWiring(wiring) {
  if (wiring === null || typeof wiring !== 'object') return undefined
  const nodes = wiring.nodes
  const edges = wiring.edges
  if (!Array.isArray(nodes)) return undefined
  return {
    nodeCount: nodes.length,
    edgeCount: Array.isArray(edges) ? edges.length : 0,
  }
}

/** JSON from a file, or undefined when it is missing or unparseable. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // Absent, unreadable, or half-written by a concurrent graft sync. All three
    // mean the same thing here: no data this time round.
    return undefined
  }
}

/**
 * Tokens graft's own session files claim to have saved in this repo.
 *
 * Summed across sessions rather than read from one, because the id the harness
 * uses is not the id graft filed its state under. A repo graft has never been
 * queried in has no session directory at all, which reads as zero — correct,
 * and the reason the chip hides the figure rather than showing "0".
 */
async function readSavedTokens(root) {
  const dir = join(root, 'graft', '.cache', 'session')
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const session = await readJson(join(dir, entry))
    const saved = session?.savedTokens
    if (typeof saved === 'number' && Number.isFinite(saved) && saved > 0) total += saved
  }
  return Math.round(total)
}

/**
 * The standing instruction to prefer graft over grep/read.
 *
 * WHY THIS IS NOT IN THE DEPLOYMENT PERSONA
 *
 * It was, and it never reached the model. The web profile mounts agent presets,
 * and the shipped `standard` preset carries its own persona row:
 *
 *   # The preset's own persona, shadowing the deployment default for this agent.
 *   - id: persona
 *     name: '@deepseek-ai/dsh-persona'
 *     config: { text: 'You are a coding agent powered by {{model}} …' }
 *
 * Both sides name the same section, `deployment:persona`, and that is exactly
 * what makes the preset REPLACE it rather than add to it. Anything written into
 * the deployment persona is silently dropped for every session that joins a
 * preset — which, on this surface, is all of them.
 *
 * A section of this plugin's own has no such conflict: it is registered on the
 * agent's own context under its own name, so it survives whichever preset the
 * session happens to use, and it travels with the tools it describes instead of
 * living in a config file that has to remember they exist.
 *
 * WHY IT READS AS A PREFERENCE
 *
 * A hard "always use graft" is how the old graft-context skill caused a real
 * failure: it said to run `graft check` first, the model obeyed past the point
 * of sense, read "NO GRAPH" from the one tool that needs a deep build, and gave
 * up without trying the five that worked.
 */
const GRAFT_GUIDANCE = [
  'This workspace has a graft index: a prebuilt graph of every symbol, its',
  'file:line span, and who calls what.',
  '',
  'Prefer the graft_* tools over reading or grepping files:',
  '- graft_ask to find code or understand how something works — one call usually',
  '  replaces several file reads.',
  '- graft_callers before renaming or changing a symbol, to see what depends on it.',
  '- graft_skeleton instead of reading a whole file when signatures are enough.',
  '- graft_map to orient in an unfamiliar part of the tree.',
  '',
  'Fall back to read/grep when graft returns nothing useful, and say so rather',
  'than searching twice in silence. The graph rebuilds itself after edits, so it',
  'is normally current; `/graft` rebuilds it on demand.',
].join('\n')

/**
 * Where the guidance sits in the assembled prompt.
 *
 * Between FILE_REFERENCE (900) and the per-tool sections (TOOL_BASH is 1000),
 * so a rule about which tools to prefer is read immediately before the tools
 * themselves are described.
 */
const GUIDANCE_ORDER = 950

/** Where this plugin keeps its own running totals. */
const SAVINGS_PATH = join(
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'),
  'storages',
  'graft-status.json',
)

/**
 * Tokens the dsh tools have saved in one repo, added to graft's own tally.
 *
 * The two are summed rather than merged because they count disjoint work:
 * graft's per-session files are written by ITS hooks, which only run under
 * Claude Code, while this file records calls made through dsh. Neither sees
 * the other's, so the sum is the honest total for the repo — which is what the
 * chip claims it is.
 */
export function totalSaved(graftOwn, ours) {
  const a = typeof graftOwn === 'number' && Number.isFinite(graftOwn) && graftOwn > 0 ? graftOwn : 0
  const b = typeof ours === 'number' && Number.isFinite(ours) && ours > 0 ? ours : 0
  return Math.round(a + b)
}

/**
 * The whole status for one repo root.
 *
 * The cache is preferred over the graph because only the cache carries live
 * dirty/stale state; the graph is the fallback that keeps a freshly built repo
 * from reading as "not built" until something writes the cache. That ordering
 * is graft's own, kept identical so this chip and graft's statusline cannot
 * disagree about the same repo.
 */
export async function computeStatus(root, io) {
  const stats = await io.readJson(join(root, 'graft', '.cache', 'stats.json'))
  const base = stats !== undefined && typeof stats.nodeCount === 'number' && stats.nodeCount > 0
    ? { nodeCount: stats.nodeCount, edgeCount: stats.edgeCount ?? 0, freshness: freshnessOf(stats), syncedAt: stats.syncedAt ?? null }
    : undefined

  if (base !== undefined) {
    return { ...base, root, savedTokens: totalSaved(await io.readSavedTokens(root), io.ourSavings?.(root)), source: 'cache' }
  }

  const counted = countWiring(await io.readJson(join(root, 'graft', '.graph', 'wiring.json')))
  if (counted === undefined) return { root, ok: false, reason: 'no graph' }
  return {
    ...counted,
    root,
    // The graph carries no drift signal of its own, so this reads as synced
    // until something repopulates the cache — the same concession graft's
    // statusline documents for this exact fallback.
    freshness: 'synced',
    syncedAt: null,
    savedTokens: totalSaved(await io.readSavedTokens(root), io.ourSavings?.(root)),
    source: 'graph',
  }
}

/* ========================================================================== *
 * The visualiser
 * ========================================================================== */

/** graft viz's own default. Kept so a URL a user already has still works. */
const VIZ_PORT = 4400

/** Is something already answering on this port? */
async function vizAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1200),
    })
    return response.ok
  } catch {
    // Refused, timed out, or nothing there. All mean "not serving".
    return false
  }
}

/**
 * The first port from `base` that nothing is answering on.
 *
 * One `graft viz` serves exactly one repo, so two sessions on two repos need
 * two servers. An earlier version adopted whatever was already listening on the
 * fixed port, which is wrong the moment a second repo is involved: the adopted
 * server's repo is unknowable from the outside, so the tab would confidently
 * show a graph of something else. Picking a free port instead means every
 * server this plugin uses is one it started, for a root it knows.
 */
export async function pickPort(base, deps, span = 20) {
  for (let port = base; port < base + span; port += 1) {
    if (!(await deps.alive(port))) return port
  }
  return undefined
}

/**
 * Start `graft viz` for one repo and wait until it is actually accepting.
 *
 * @param deps - injected so the harness can drive this without a real graft.
 */
export async function startViz(root, port, deps) {
  let child
  try {
    child = deps.spawn(root, port)
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }

  // Poll rather than trust the process: `graft viz` prints its banner before
  // the socket is necessarily accepting, and the iframe that follows gets one
  // chance to load. Ten seconds covers a cold graph read on a large repo.
  const deadline = Date.now() + 10000
  for (;;) {
    if (await deps.alive(port)) return { ok: true, url: `http://127.0.0.1:${port}/`, child }
    if (child.exitCode !== null || Date.now() > deadline) {
      return {
        ok: false,
        reason: child.exitCode !== null
          ? `graft viz exited with code ${child.exitCode}`
          : `graft viz did not start listening on ${port} within 10s`,
        child,
      }
    }
    await deps.wait(250)
  }
}

/* ========================================================================== *
 * Browser-facing operations
 * ========================================================================== */

let liveOps = null

class GraftStatusRemote extends TypertRemoteService {
  constructor(ownerCtx) {
    super(ownerCtx, 'graftStatus')
  }

  /** Counts, freshness, and the repo root resolved for one session. */
  status(sessionId) {
    if (liveOps === null) throw new Error('graft-status is not ready')
    return liveOps.status(sessionId)
  }

  /** Ensure `graft viz` is serving that session's repo, and answer with its URL. */
  viz(sessionId) {
    if (liveOps === null) throw new Error('graft-status is not ready')
    return liveOps.viz(sessionId)
  }
}

/** Emulate the @Remote decorator without decorator syntax. */
function markRemoteMethod(prototype, method) {
  Remote(method)(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {
      has() {
        return false
      },
      get() {
        return undefined
      },
    },
    addInitializer(fn) {
      fn.call(Object.create(prototype))
    },
  })
}

markRemoteMethod(GraftStatusRemote.prototype, 'status')
markRemoteMethod(GraftStatusRemote.prototype, 'viz')

export function apply(ctx, config = {}) {
  const fallbackFrom = typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : process.cwd()
  const cacheMs = Number.isInteger(config.cacheMs) && config.cacheMs >= 0 ? config.cacheMs : CACHE_MS

  /**
   * root -> tokens this plugin's tools have saved there.
   *
   * Loaded once and written back lazily. Kept out of graft's own session files
   * on purpose: those belong to graft's hooks, and a second writer racing them
   * would corrupt a tally this plugin only wants to read.
   */
  const savings = new Map()
  let savingsLoaded = false
  let savingsDirty = false

  const loadSavings = async () => {
    if (savingsLoaded) return
    savingsLoaded = true
    const stored = await readJson(SAVINGS_PATH)
    const rows = stored?.savedTokens
    if (rows !== null && typeof rows === 'object') {
      for (const [root, value] of Object.entries(rows)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) savings.set(root, value)
      }
    }
  }

  const flushSavings = async () => {
    if (!savingsDirty) return
    savingsDirty = false
    try {
      await mkdir(dirname(SAVINGS_PATH), { recursive: true })
      const temporary = `${SAVINGS_PATH}.${process.pid}.tmp`
      const body = { version: 1, savedTokens: Object.fromEntries(savings) }
      await writeFile(temporary, JSON.stringify(body, null, 2), 'utf8')
      await rename(temporary, SAVINGS_PATH)
    } catch {
      // A lost tally is a cosmetic loss on one chip; never worth an error path.
    }
  }

  const io = {
    readJson,
    readSavedTokens,
    ourSavings: (root) => savings.get(root) ?? 0,
    exists: async (path) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
  }

  const vizPort = Number.isInteger(config.vizPort) && config.vizPort > 0 && config.vizPort < 65536
    ? config.vizPort
    : VIZ_PORT

  // `ctx.get` rather than `ctx.sessions`: the latter throws without a declared
  // inject, and this plugin deliberately declares none so a missing service can
  // never take the chip down with it.
  const cwdFor = (sessionId) => cwdForSession(ctx.get?.('sessions'), sessionId, fallbackFrom)

  /** root -> cached status, so two sessions on two repos do not share one answer. */
  const cache = new Map()
  /** root -> { port, child, url } for every viz server this plugin started. */
  const vizByRoot = new Map()
  /** root -> in-flight start, so a double click cannot race two spawns. */
  const vizPending = new Map()

  const vizDeps = {
    alive: vizAlive,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawn: (root, port) => {
      // Same shell-free invocation the tools use: running graft's own cli.js
      // with this Node means the child IS graft, not a cmd.exe wrapping it —
      // so an ordinary kill() reaches it and no process-tree surgery is needed.
      const how = resolveGraftCommand()
      const child = spawn(how.command, [...how.prefix, 'viz', '--port', String(port), '--no-open'], {
        cwd: root,
        shell: how.shell,
        stdio: 'ignore',
        // Not detached: the visualiser is a child of this dsh, and should not
        // outlive it as an orphan holding its port against the next run.
        windowsHide: true,
      })
      // MANDATORY, not defensive. A ChildProcess that fails to spawn emits
      // 'error' asynchronously, and an unhandled 'error' event does not
      // reject or throw where it can be caught — it takes the whole process
      // down. Without this listener a missing binary crashed dsh instead of
      // reporting that the visualiser could not start.
      child.on('error', () => {})
      return child
    },
  }

  liveOps = {
    status: async (sessionId) => {
      const from = cwdFor(sessionId)
      let root
      try {
        root = await findGraftRoot(from, io.exists)
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error), from }
      }
      if (root === undefined) return { ok: false, reason: 'no graft index above ' + from, from }

      const now = Date.now()
      const hit = cache.get(root)
      if (hit !== undefined && now - hit.at < cacheMs) return hit.value

      let value
      try {
        value = { ok: true, ...await computeStatus(root, io) }
      } catch (error) {
        // A status chip must never be the thing that breaks the composer.
        value = { ok: false, reason: String(error?.message ?? error), from }
      }
      cache.set(root, { value, at: now })
      return value
    },

    viz: async (sessionId) => {
      const from = cwdFor(sessionId)
      const root = await findGraftRoot(from, io.exists)
      if (root === undefined) return { ok: false, reason: 'no graft index above ' + from, from }

      // Already serving this repo: reuse it. Checked before the pending map so
      // a reopened tab costs nothing at all.
      const live = vizByRoot.get(root)
      if (live !== undefined && live.child.exitCode === null) {
        return { ok: true, url: live.url, root }
      }

      const inFlight = vizPending.get(root)
      if (inFlight !== undefined) return inFlight

      const start = (async () => {
        const port = await pickPort(vizPort, vizDeps)
        if (port === undefined) {
          return { ok: false, reason: `no free port for graft viz near ${vizPort}`, root }
        }
        const started = await startViz(root, port, vizDeps)
        if (started.ok && started.child !== undefined) {
          vizByRoot.set(root, { port, child: started.child, url: started.url })
        }
        return started.ok
          ? { ok: true, url: started.url, root }
          : { ok: false, reason: started.reason, root }
      })()

      vizPending.set(root, start)
      try {
        return await start
      } finally {
        vizPending.delete(root)
      }
    },
  }

  new GraftStatusRemote(ctx)

  // The model-facing half. Registered unless turned off, so a profile that
  // would rather keep the MCP server can set `tools: false` and lose nothing
  // else this plugin does.
  if (config.tools !== false) {
    const toolDeps = {
      fallbackCwd: fallbackFrom,
      findRoot: (start) => findGraftRoot(start, io.exists),
      recordSavings: (root, saved) => {
        savings.set(root, (savings.get(root) ?? 0) + saved)
        savingsDirty = true
        // The status cache would otherwise hold the pre-call figure for its
        // five seconds, so a tally that just changed would not show until the
        // chip happened to poll again.
        cache.delete(root)
        void flushSavings()
      },
    }
    for (const tool of graftTools(toolDeps)) {
      ctx.effect(() => ctx.tools.register(tool), `graft-status: ${tool.name}`)
    }
    void loadSavings()
  }

  // `/graft`. Soft-injected like the sidebar tab: a profile without the command
  // runtime still gets the chip, the tools and the auto-rebuild.
  if (config.command !== false) {
    ctx.inject(['commands'], (scope) => {
      scope.effect(
        () =>
          scope.commands.register(
            createGraftCommand({
              fallbackCwd: fallbackFrom,
              findRoot: (start) => findGraftRoot(start, io.exists),
              readJson,
              countWiring,
            }),
          ),
        'graft-status: /graft command',
      )
    })
  }

  // The standing instruction, registered on each agent's OWN context so no
  // preset can shadow it (see GRAFT_GUIDANCE for why the persona could not).
  if (config.promptSection !== false) {
    /** Agent contexts already carrying the section; a duplicate name throws. */
    const briefed = new WeakSet()

    ctx.on('agent/session-start', (payload) => {
      const agentCtx = payload?.agent?.ctx
      if (agentCtx === undefined || agentCtx === null || briefed.has(agentCtx)) return
      briefed.add(agentCtx)
      try {
        // `get` rather than `agentCtx.systemPrompt`: the property accessor
        // throws without a declared inject, and this plugin declares none for
        // it on purpose — a deployment without the service should lose the
        // sentence, not the chip and the tools.
        const prompt = agentCtx.get?.('systemPrompt')
        if (typeof prompt?.section !== 'function') return
        agentCtx.effect?.(
          () => prompt.section({ name: 'graft-status:usage', order: GUIDANCE_ORDER, text: GRAFT_GUIDANCE }),
          'graft-status: prompt guidance',
        )
      } catch {
        // A section that fails to register costs a nudge, never the session.
      }
    })
  }

  // Auto-rebuild: graft's two Claude Code hooks, on dsh's own seams.
  if (config.autoBuild !== false) {
    const autoSync = createAutoSync({
      cliPath: resolveGraftCommand().prefix[0],
      minIntervalMs: config.autoBuildMinIntervalMs,
      writeTools: config.autoBuildTools,
    })

    ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      // Only a call that SUCCEEDED can have moved the tree, and a failed edit
      // marking the graph dirty would trigger a rebuild that finds nothing.
      if (result?.isError !== true && autoSync.touches(exec?.name)) {
        // Straight off the call's own agent, the same source graft_ask uses.
        // Going via the sessions registry would be a lookup to reach a value
        // already in hand, and would differ if the two ever disagreed.
        const from = exec?.agent?.session?.header?.cwd ?? fallbackFrom
        const root = await findGraftRoot(from, io.exists)
        if (root !== undefined) void autoSync.markDirty(root)
      }
      return result
    })

    ctx.effect(() => () => autoSync.dispose(), 'graft-status: auto-sync timers')

    ctx.on('agent/turn-stopping', async (payload) => {
      const cwd = payload?.agent?.session?.header?.cwd ?? fallbackFrom
      const root = await findGraftRoot(cwd, io.exists)
      if (root === undefined) return
      const outcome = await autoSync.syncIfDirty(root)
      if (outcome === 'started') {
        // Dropped so the chip re-reads once the rebuild lands, rather than
        // showing the pre-build counts for the rest of the cache window.
        cache.delete(root)
        ctx.logger?.info?.(`graft-status: rebuilding the graft graph for ${root}`)
      }
    })
  }

  ctx.effect(() => () => {
    liveOps = null
    for (const { child } of vizByRoot.values()) {
      try {
        // A plain kill, because the child is graft itself. An earlier version
        // shelled out to `taskkill /T` to reach through a cmd.exe wrapper, and
        // that spawn ITSELF threw ENOENT wherever taskkill was not on PATH —
        // an unhandled 'error' event that crashed dsh during shutdown. The
        // wrapper is gone, so the reason for taskkill is gone with it.
        child.kill()
      } catch {
        // Teardown must not throw. A survivor costs one held port, which the
        // next start steps over when it probes for a free one.
      }
    }
    vizByRoot.clear()
  }, 'graft-status: release live operations')
}

export default { apply, inject, name }
