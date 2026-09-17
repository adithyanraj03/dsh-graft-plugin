/**
 * Keep the graft graph current as the model edits code.
 *
 * WHAT CLAUDE CODE GETS THAT dsh DOES NOT
 *
 * `graft init` installs two hooks there: a post-edit hook that marks the graph
 * dirty, and a Stop hook that rebuilds it at the end of a turn. dsh is not one
 * of the agents `graft init` knows (`--list-agents`: agents, adal, cursor,
 * gemini, grok, hermes, antigravity, copilot, kiro, windsurf, claude), so a dsh
 * user is left running `graft build` by hand and, in practice, forgetting to.
 *
 * This is the same two hooks on dsh's own seams — `tools/execute` for the edit
 * signal, `agent/turn-stopping` for the rebuild — plus a third trigger graft
 * does not need: a debounced rebuild DURING a turn. Claude Code turns are short;
 * one turn here can run half an hour across dozens of edits, and waiting for its
 * end would leave the model querying a graph it had already invalidated.
 *
 * IT REUSES GRAFT'S OWN SCRIPT, NOT A REIMPLEMENTATION
 *
 * The rebuild is graft's `dist/claude/sync-run.js`, spawned exactly as its Stop
 * hook spawns it, and the dirty/lock bookkeeping goes through graft's own
 * `state.js`. That matters for three reasons: `sync-run` already patches
 * `stats.json` on the way out (clearing `dirty`, stamping `syncedAt`, writing
 * the new counts), which is the file the status chip reads — so the chip shows
 * "syncing" then "in sync" for free; the lock is graft's, so a dsh rebuild and
 * a Claude Code rebuild in the same repo cannot run over each other; and its
 * money guard travels with it.
 *
 * THE MONEY GUARD
 *
 * `sync-run.js` carries the comment "MONEY GUARD: plain `graft build` only —
 * structural, $0, offline. Never --deep." Calling that script rather than
 * assembling an argv here is what keeps that promise true: an automatic
 * rebuild can never start billing an LLM, because the code that decides the
 * arguments is graft's, not this plugin's.
 *
 * @module graft-status/auto-sync
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Tools whose success means the working tree may have moved.
 *
 * THESE ARE dsh's REAL WIRE NAMES. The list previously read `write_file`,
 * `terminal` and `shell` — none of which dsh registers — while omitting `write`
 * and `str_replace_editor`, which it does. The effect was worst in exactly the
 * case it should have handled best: in a NEW repo every file arrives through
 * `write`, so nothing was ever marked dirty and the graph stayed at whatever
 * `/graft` first built until someone ran `graft build` by hand. `edit` and the
 * shells worked, which is why it looked intermittent rather than broken.
 *
 * Source of truth, from the packages that register them:
 *   dsh-tool-fs                  write · edit   (also read, read_image)
 *   dsh-tool-str-replace-editor  str_replace_editor
 *   dsh-tool-bash / -pwsh        bash · pwsh
 *
 * The shells are on the list deliberately. graft's own post-edit hook watches
 * file-editing tools, but in this deployment most files arrive from a script
 * the model runs — a Blender export, a Godot build — and an edit-tools-only
 * trigger would miss exactly the changes that matter most. The cost of being
 * broad is bounded by the design: the flag only marks the graph dirty, and the
 * debounce collapses a burst of writes into a single rebuild.
 *
 * Override with the row's `autoBuildTools` if a deployment registers others.
 */
const DEFAULT_WRITE_TOOLS = ['write', 'edit', 'str_replace_editor', 'pwsh', 'bash']

/** Graft's own state helpers, loaded from wherever graft is installed. */
async function loadGraftState(cliPath) {
  const claudeDir = join(dirname(cliPath), 'claude')
  const statePath = join(claudeDir, 'state.js')
  const syncRun = join(claudeDir, 'sync-run.js')
  if (!existsSync(statePath) || !existsSync(syncRun)) return undefined
  try {
    const state = await import(pathToFileURL(statePath).href)
    if (typeof state.readStats !== 'function' || typeof state.patchStats !== 'function') return undefined
    return { state, syncRun }
  } catch {
    // A graft too old or too new to expose these. Auto-sync simply does not
    // run; every other part of this plugin is unaffected.
    return undefined
  }
}

/**
 * @param deps.cliPath - graft's `dist/cli.js`, from which its `claude/` dir is found.
 * @param deps.minIntervalMs - floor between rebuilds of the same repo.
 */
export function createAutoSync(deps = {}) {
  const writeTools = new Set(Array.isArray(deps.writeTools) ? deps.writeTools : DEFAULT_WRITE_TOOLS)
  /**
   * Floor between rebuild ATTEMPTS on one repo.
   *
   * Was 30s, which was wrong: a structural build of a normal repo takes about a
   * second, so a 30s floor meant that in a quick back-and-forth most turns were
   * refused with `too-soon` and the graph simply stayed stale — the opposite of
   * the point. Overlapping builds are already prevented by graft's own lock,
   * which is what that lock is for; this is only a brake on a spawn storm if
   * the lock is ever unavailable.
   */
  const minIntervalMs = Number.isInteger(deps.minIntervalMs) ? deps.minIntervalMs : 5_000
  const spawnFn = deps.spawn ?? spawn
  const now = deps.now ?? (() => Date.now())

  /**
   * Quiet period after the last write before rebuilding mid-turn.
   *
   * The turn boundary alone is not enough. One agentic turn here routinely runs
   * for tens of minutes across dozens of edits — a graph marked dirty in its
   * first minute then stayed stale for the next thirty-five, and every
   * `graft_ask` the model made in between answered from it. Waiting for a lull
   * instead of for the turn means a burst of edits still costs ONE rebuild,
   * while a long turn no longer reasons about its own stale graph.
   *
   * Set to 0 to go back to turn-end-only.
   */
  const debounceMs = Number.isInteger(deps.debounceMs) ? deps.debounceMs : 20_000

  /** Roots edited since their last rebuild. */
  const pending = new Set()
  /** root -> when a rebuild was last STARTED, for the interval floor. */
  const lastRun = new Map()
  /** root -> pending debounce timer. */
  const timers = new Map()
  const setTimer = deps.setTimeout ?? setTimeout
  const clearTimer = deps.clearTimeout ?? clearTimeout

  let loaded
  const graft = async () => {
    if (loaded === undefined) {
      loaded = deps.graft !== undefined ? deps.graft : await loadGraftState(deps.cliPath)
      if (loaded === undefined) loaded = null
    }
    return loaded
  }

  const api = {
    /** Whether a finished tool call means the tree may have changed. */
    touches: (toolName) => writeTools.has(toolName),

    /**
     * Record that a repo's code moved.
     *
     * Written through graft's `patchStats` so the flag lands in the same field,
     * in the same file, that graft's own hooks and `graft check` use — a chip
     * reading `dirty` cannot then disagree with the CLI about the same repo.
     */
    markDirty: async (root) => {
      if (typeof root !== 'string' || root === '') return
      pending.add(root)

      // Restarted on every write, so a run of edits rebuilds once at the end of
      // the burst rather than once per file.
      if (debounceMs > 0) {
        clearTimer(timers.get(root))
        timers.set(
          root,
          setTimer(() => {
            timers.delete(root)
            void api.syncIfDirty(root)
          }, debounceMs),
        )
      }

      const g = await graft()
      if (g === null) return
      try {
        g.state.patchStats(root, { dirty: true })
      } catch {
        // The in-memory `pending` set still carries the turn-end trigger, so a
        // failed write costs the chip's live dirty flag, not the rebuild.
      }
    },

    /**
     * Rebuild one repo if it needs it. Called at the turn boundary, and from
     * the debounce timer once writing has gone quiet mid-turn.
     *
     * @returns why it did or did not run, for the harness and the log.
     */
    syncIfDirty: async (root) => {
      if (typeof root !== 'string' || root === '') return 'no-root'
      const g = await graft()
      if (g === null) return 'graft-unavailable'

      const since = now() - (lastRun.get(root) ?? -Infinity)
      if (since < minIntervalMs) return 'too-soon'

      // graft's own gate: its `dirty` flag is the shared source of truth, so an
      // edit made in another client counts, and a repo nothing touched is
      // never rebuilt just because a turn ended here.
      let stats
      try {
        stats = g.state.readStats(root)
      } catch {
        return 'unreadable'
      }
      if (stats?.dirty !== true && !pending.has(root)) return 'clean'

      // The lock is graft's, so a rebuild already running — started here, or by
      // Claude Code in the same repo — is left alone rather than raced.
      try {
        if (typeof g.state.acquireLock === 'function' && !g.state.acquireLock(root)) return 'locked'
        g.state.patchStats(root, { syncing: true })
      } catch {
        return 'unreadable'
      }

      pending.delete(root)
      lastRun.set(root, now())
      try {
        /*
         * NOT detached, and that is load-bearing on Windows.
         *
         * `sync-run.js` does its actual work through
         *
         *     execFileSync(process.execPath, [cli, 'build', '.'], { stdio: 'ignore' })
         *
         * with no `windowsHide`. A console process started without
         * CREATE_NO_WINDOW inherits its parent's console — but DETACHED_PROCESS
         * (which is what `detached: true` means here) leaves this child with no
         * console at all, so there is nothing to inherit and Windows gives the
         * grandchild a brand new, VISIBLE one.
         *
         * That is the terminal that flashes on every rebuild, and a new console
         * window takes foreground: it minimises a fullscreen game. Measured,
         * `detached: true` leaves the child with no console while
         * `windowsHide: true` alone gives it its own CREATE_NO_WINDOW console —
         * invisible, and inherited by the grandchild, which is exactly what is
         * wanted.
         *
         * The cost is that a rebuild no longer survives dsh exiting mid-build.
         * That is cheap: the repo simply stays marked dirty and the next write
         * triggers it again. `unref()` still keeps it from holding dsh open,
         * and `sync-run` clears `syncing` and releases the lock on its own way
         * out either way.
         */
        const child = spawnFn(process.execPath, [g.syncRun, root], {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on?.('error', () => {})
        child.unref?.()
      } catch {
        return 'spawn-failed'
      }
      return 'started'
    },

    /** Drop any pending debounce timers, so a disposed plugin fires nothing. */
    dispose: () => {
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
    },
  }

  return api
}
