/**
 * `/graft` — index this session's workspace, or report on it.
 *
 * WHY A COMMAND AND NOT JUST THE TOOLS
 *
 * Every graft tool needs a `graft/` index to exist, and until one does they all
 * answer the same way: "No graft index for this workspace — run `graft build`
 * in it once." That is a correct answer and a bad experience: it sends you to a
 * terminal, in the right directory, to run a command whose name you have to
 * remember, for a repo dsh already knows the path of.
 *
 * `/graft` closes that loop. It resolves the session's own workspace, builds
 * there, and reports what it produced.
 *
 * WHAT `/graft` COSTS
 *
 * Nothing. The bare form runs the plain structural build — `$0`, offline, no
 * API key — which is also what the auto-rebuild runs. `/graft deep` is the one
 * form that calls an LLM, and it is never reached except by typing that word,
 * which is the whole reason it is a separate subcommand rather than a flag on
 * the default path.
 *
 * @module graft-status/command
 */

import { join } from 'node:path'

import { runGraft } from './graft-tools.js'

/** How long a build may take before the command gives up, in ms. */
const BUILD_TIMEOUT_MS = 180_000

/** The workspace this invocation belongs to. */
export function workspaceOf(invocation, fallback) {
  const cwd = invocation?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback
}

/**
 * What the user asked for, from the text after the command name.
 *
 * Unknown words are an error rather than a silent build: someone typing
 * `/graft rebiuld` meant something, and quietly doing the default would hide
 * the typo behind a plausible-looking success.
 */
export function parseArgs(rawInput) {
  const word = String(rawInput ?? '').trim().toLowerCase()
  if (word === '') return { mode: 'build' }
  if (word === 'status' || word === 'check') return { mode: 'status' }
  if (word === 'deep' || word === '--deep') return { mode: 'deep' }
  return { mode: 'unknown', word }
}

/**
 * The stats for a root, however they can be had.
 *
 * A plain `graft build` writes the graph but NOT `graft/.cache/stats.json` —
 * that file is written by graft's `sync-run`, which builds and then patches it.
 * So straight after an initialise there are no stats to read, and reporting
 * "no stats written" for a build that just succeeded reads as a failure. The
 * wiring graph is the same numbers one layer down; this is the precedence the
 * status chip already uses, kept identical so the two never disagree.
 */
async function statsFor(root, deps) {
  const stats = await deps.readJson(join(root, 'graft', '.cache', 'stats.json'))
  if (stats !== undefined && typeof stats.nodeCount === 'number') return stats
  const wiring = await deps.readJson(join(root, 'graft', '.graph', 'wiring.json'))
  const counted = deps.countWiring?.(wiring)
  if (counted === undefined) return undefined
  // The graph keeps its summary under `meta`, not at the top level — the same
  // place its own nodeCount/edgeCount live.
  return { ...counted, languages: wiring?.meta?.languages ?? wiring?.languages }
}

/** A one-line summary of a built graph. */
function describe(stats) {
  if (stats === undefined) return 'no graph written'
  const nodes = typeof stats.nodeCount === 'number' ? stats.nodeCount.toLocaleString('en-US') : '?'
  const edges = typeof stats.edgeCount === 'number' ? stats.edgeCount.toLocaleString('en-US') : '?'
  const languages = Array.isArray(stats.languages) && stats.languages.length > 0
    ? ` · ${stats.languages.join(', ')}`
    : ''
  return `${nodes} nodes / ${edges} edges${languages}`
}

export function createGraftCommand(deps) {
  return {
    name: 'graft',
    description: 'Index this workspace for graft, or report on its graph',
    input: { hint: '[status|deep]' },
    handler: async (invocation) => {
      const cwd = workspaceOf(invocation, deps.fallbackCwd)
      const args = parseArgs(invocation?.rawInput)

      if (args.mode === 'unknown') {
        return {
          kind: 'error',
          text: `Unknown option "${args.word}". Use /graft, /graft status, or /graft deep.`,
        }
      }

      const existing = await deps.findRoot(cwd)

      if (args.mode === 'status') {
        if (existing === undefined) {
          return { kind: 'success', text: `No graft index for ${cwd}. Run /graft to build one.` }
        }
        const stats = await statsFor(existing, deps)
        const drift = stats?.dirty === true ? ' · stale, run /graft' : ' · in sync'
        return { kind: 'success', text: `graft: ${existing}\n${describe(stats)}${drift}` }
      }

      // An index found ABOVE the workspace is rebuilt where it lives; without
      // one, the workspace itself becomes the new root. That is what makes the
      // bare command mean "initialize here" in a fresh repo and "refresh" in a
      // repo already indexed, with no flag to choose between them.
      const target = existing ?? cwd
      const initialising = existing === undefined

      const result = await runGraft(
        args.mode === 'deep' ? ['build', '--deep', target] : ['build', target],
        target,
        { ...deps, timeoutMs: BUILD_TIMEOUT_MS, signal: invocation?.signal },
      )

      const stats = await statsFor(target, deps)
      const built = await deps.findRoot(target)
      if (built === undefined) {
        // The build produced no index. graft's own message is the useful part —
        // an unsupported language, an empty tree, a missing key on --deep.
        return {
          kind: 'error',
          text: `graft build did not produce an index in ${target}.\n\n${result.text.slice(0, 1200)}`,
        }
      }

      const headline = initialising ? `graft initialised in ${target}` : `graft rebuilt for ${target}`
      const deepNote = args.mode === 'deep'
        ? '\nDeep pass done — the meaning layer and manifest.json now exist.'
        : ''
      return {
        kind: 'success',
        text: `${headline}\n${describe(stats)}${deepNote}\n\nThe graft tools now work in this session, and the graph rebuilds itself at the end of any turn that changes files.`,
      }
    },
  }
}
