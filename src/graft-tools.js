/**
 * Session-aware graft tools.
 *
 * WHY THESE EXIST INSTEAD OF THE MCP SERVER
 *
 * `graft mcp` is a stdio child spawned once per dsh boot, and it resolves the
 * repo it serves — "nearest ancestor with a graft/ index" — from ITS working
 * directory at startup. Nothing can re-point it afterwards: its tools take no
 * directory argument, and the `in` parameter scopes to a sub-project WITHIN the
 * root it already chose.
 *
 * That is incompatible with how this dsh is used: launched once from wherever,
 * with the working directory chosen per session inside the UI. Measured on one
 * repo, changing only the launch directory:
 *
 *   launched in the workspace   graft_repo_map ok, find_code ok, find_all ok
 *   launched from a home dir    "no graph found — run `graft build` first"
 *
 * A tool registered here has what the MCP server cannot get: the call's own
 * agent, and therefore `agent.session.header.cwd` — the workspace that session
 * actually chose. So the repo is resolved per call, and one dsh can serve
 * several workspaces at once.
 *
 * WHAT THEY ARE
 *
 * Thin wrappers over the `graft` CLI, which is the same graph the MCP server
 * reads and needs no LLM key. Each maps to one subcommand and passes the
 * resolved root as its `[dir]` argument.
 *
 * NO BOOLEAN PARAMETERS, DELIBERATELY
 *
 * On this deployment a tool call that SETS a boolean is emitted by the server
 * as literal `<tool_call>` text instead of a structured call, and never runs
 * (see the bool-param-compat plugin). These take string enums instead, which
 * read better to a model anyway — `detail: "full"` says more than `full: true`
 * — and cannot trip that bug even if that plugin is removed.
 *
 * @module graft-status/graft-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Ceiling for one graft call.
 *
 * Every subcommand used here is the `$0, no LLM` kind — it reads a prebuilt
 * graph — so a slow one means something is wrong rather than something is
 * thinking. Declared on the tool so dsh's own timeout policy enforces it;
 * without a declared `timeoutMs` that policy takes an early return and the
 * call is unbounded.
 */
const TIMEOUT_MS = 60_000

/** Cap on returned text, so one broad query cannot swamp the context. */
const MAX_CHARS = 60_000

/**
 * How to invoke graft without a shell.
 *
 * `graft` on Windows is a `.cmd` shim, so a naive spawn cannot exec it and the
 * obvious fix — `shell: true` — is a trap: Node joins argv into one command
 * line WITHOUT quoting, so the first argument containing a space is silently
 * split. That broke every call here at once, because both the queries
 * (`"punch animation"`) and the repo path (`B:\...\Street Yeet`) contain
 * spaces.
 *
 * The shim's own body is `node <dir>/node_modules/@nanonets/graft/dist/cli.js`,
 * so finding that file on PATH and running it with the current Node needs no
 * shell at all, and argv is passed through exactly as written.
 *
 * The bare-name fallback keeps a differently-installed graft working; it is
 * only reached when the entry point cannot be found.
 *
 * WHY THE INTERPRETER IS NOT ALWAYS `process.execPath`
 *
 * execPath is Node only when the host is Node. The dsh DESKTOP app is Electron
 * (`DeepSeek Harness.exe`) running with ELECTRON_RUN_AS_NODE=1, so execPath is
 * that app binary: the script still starts, and the breakage happens one layer
 * in, inside graft's own argument parsing. The child keeps
 * `process.versions.electron`, and commander 15 picks its `electron` argv
 * convention from exactly that (`if (process.versions?.electron) from =
 * 'electron'`). That branch then keys on `process.defaultApp`, which is
 * undefined when the JS arrived as a script path rather than an app directory,
 * and slices argv from 1 instead of 2 — so the cli.js path lands where the
 * subcommand should be:
 *
 *     error: unknown command '<...>\@nanonets\graft\dist\cli.js'
 *
 * which is what the Build button and all five query tools used to return in the
 * desktop app. A real node avoids the Electron binary altogether.
 */
const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node'

/**
 * Which binary to run graft's cli.js with.
 *
 * The npm shim's own rule is the first choice — `%dp0%\node.exe`, the node that
 * was installed beside the shims — so this agrees with what typing `graft` in a
 * terminal would do. Only an Electron host needs the PATH search after it,
 * because `graft` and its node need not share a prefix. A Node host keeps using
 * its own execPath, unchanged from before.
 */
function interpreterFor(installDir, dirs, exists, execPath, electron) {
  const beside = join(installDir, NODE_EXE)
  if (exists(beside)) return beside
  if (!electron) return execPath
  for (const dir of dirs) {
    const candidate = join(dir, NODE_EXE)
    if (exists(candidate)) return candidate
  }
  // Nothing better to hand: execPath at least runs the script, and graft's own
  // stderr says what happened — the same answer as before this existed.
  return execPath
}

export function resolveGraftCommand(
  env = process.env,
  exists = existsSync,
  execPath = process.execPath,
  electron = process.versions?.electron !== undefined,
) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    const cli = join(dir, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
    if (exists(cli)) return { command: interpreterFor(dir, dirs, exists, execPath, electron), prefix: [cli], shell: false }
  }
  // A bun global install puts only the shim on PATH; the package lives under
  // $BUN_INSTALL/install/global. Missing it left prefix empty, which auto-sync
  // used to turn into a fatal dirname(undefined).
  const bunRoot = env.BUN_INSTALL ?? join(env.HOME ?? env.USERPROFILE ?? '.', '.bun')
  if (typeof bunRoot === 'string' && bunRoot !== '') {
    const bunInstall = join(bunRoot, 'install', 'global')
    const bunCli = join(bunInstall, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
    if (exists(bunCli)) return { command: interpreterFor(bunInstall, dirs, exists, execPath, electron), prefix: [bunCli], shell: false }
  }
  return { command: 'graft', prefix: [], shell: process.platform === 'win32' }
}

let cachedCommand

/**
 * Run one graft subcommand and return its stdout.
 *
 * stderr is folded into the result rather than dropped: graft reports "no
 * graph", drift warnings and bad-argument errors there, and a tool that
 * swallowed them would answer "(no output)" to a question that has a specific,
 * actionable reason behind it.
 */
export function runGraft(args, cwd, deps = {}) {
  const spawnFn = deps.spawn ?? spawn
  const how = deps.command ?? (cachedCommand ??= resolveGraftCommand())
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(how.command, [...how.prefix, ...args], {
        cwd,
        shell: how.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ text: `graft could not be run: ${String(error?.message ?? error)}` })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    let timer
    let abort
    const finish = (text) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abort !== undefined) deps.signal?.removeEventListener?.('abort', abort)
      resolve({ text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text })
    }

    // A build is the one call here that can genuinely run long, so both an
    // upper bound and the caller's own cancellation have to reach the child —
    // otherwise a wedged graft holds a slash command open with no way out.
    const limit = Number.isInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : TIMEOUT_MS
    timer = setTimeout(() => {
      child.kill()
      finish(`graft timed out after ${Math.round(limit / 1000)}s.\n${out}${err}`)
    }, limit)
    if (deps.signal !== undefined) {
      abort = () => {
        child.kill()
        finish('Cancelled.')
      }
      if (deps.signal.aborted) abort()
      else deps.signal.addEventListener?.('abort', abort, { once: true })
    }

    child.stdout?.on('data', (chunk) => { out += chunk.toString() })
    child.stderr?.on('data', (chunk) => { err += chunk.toString() })
    child.on('error', (error) => finish(`graft could not be run: ${String(error?.message ?? error)}`))
    child.on('close', () => {
      const combined = [out.trim(), err.trim()].filter(Boolean).join('\n')
      finish(combined === '' ? '(graft produced no output)' : combined)
    })
  })
}

/**
 * The repo root for the call's own session.
 *
 * `exec.agent.session.header.cwd` is the workspace chosen inside dsh for THIS
 * session — the value its entry in the session list shows — which is the whole
 * reason these tools exist. The process cwd is only the fallback, for a call
 * with no agent (a direct dispatch) or a session created without one.
 */
export function repoFor(exec, fallback) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback
}

/** `graft <sub> … <root>`, with the shared plumbing applied. */
function graftTool(spec, deps) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      const root = repoFor(exec, deps.fallbackCwd)
      const found = await deps.findRoot(root)
      if (found === undefined) {
        return {
          text:
            `No graft index for this workspace (${root}).\n` +
            'Run `graft build` in it once — it needs no API key — and this tool will work from then on.',
        }
      }
      // Announced BEFORE the run, so the chip's dot flickers while graft is
      // actually working, not only after it has answered.
      deps.noteUse?.(found)
      const result = await runGraft([...spec.argv(args), found], found, deps)
      const saved = savedTokensIn(result.text)
      if (saved > 0) deps.recordSavings?.(found, saved)
      return result
    },
  })
}

/** Only pass a flag when the model actually chose the non-default. */
const when = (condition, ...flag) => (condition ? flag : [])

/**
 * The token count graft claims it saved on one call.
 *
 * Every retrieval command opens its output with a line like
 * `[graft] tokens saved ≈ 26,730 (99%) — this output ≈ 308 tok vs …`, which is
 * graft's own estimate and the same number its Claude Code statusline totals.
 * Reading it back is what lets the dsh chip show a running total too: graft
 * keeps that tally in per-session files written by ITS hooks, and dsh has none,
 * so without parsing it here the figure would sit at zero forever no matter how
 * much the tools were used.
 *
 * Digit grouping is stripped rather than parsed by locale — graft renders these
 * with the host's separators (`1,50,427` on this machine's Indian grouping), so
 * anything that is not a digit between the number's ends is punctuation.
 */
export function savedTokensIn(text) {
  const match = /tokens saved\s*≈\s*([\d.,   ]+?)\s*\(/.exec(String(text ?? ''))
  if (match === null) return 0
  const digits = match[1].replace(/\D/g, '')
  if (digits === '') return 0
  const value = Number.parseInt(digits, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function graftTools(deps) {
  return [
    graftTool(
      {
        name: 'graft_ask',
        description:
          'Search this repo\'s prebuilt code graph in plain words and get ranked results with the ' +
          'code inlined at exact file:line. The first thing to reach for on "how does X work" or ' +
          '"where is Y" — one call usually replaces several file reads. Costs no API key.',
        parameters: {
          query: { type: 'string', required: true, description: 'What you are looking for, in plain words.' },
          detail: {
            type: 'string',
            enum: ['crux', 'full'],
            description: 'How much of each hit to inline: "crux" (default, <=8 lines) or "full" (the whole span).',
          },
          in: { type: 'string', description: 'Limit to one sub-project path, for a monorepo (e.g. "packages/core/").' },
        },
        argv: (args) => [
          'ask', String(args.query), '--source',
          ...when(args.detail === 'full', '--full'),
          ...when(typeof args.in === 'string' && args.in !== '', '--in', String(args.in)),
        ],
      },
      deps,
    ),

    graftTool(
      {
        name: 'graft_grep',
        description:
          'Exhaustive search over the indexed files, with hits grouped by their enclosing symbol ' +
          'and ranked by how much depends on them. Use when you need EVERY occurrence — graft_ask ' +
          'is ranked top-N and will miss some.',
        parameters: {
          pattern: { type: 'string', required: true, description: 'Regular expression, or a literal when match is "literal".' },
          match: {
            type: 'string',
            enum: ['regex', 'literal'],
            description: 'Treat pattern as a regex (default) or as literal text.',
          },
          case: {
            type: 'string',
            enum: ['sensitive', 'insensitive'],
            description: 'Case sensitivity; defaults to sensitive.',
          },
          in: { type: 'string', description: 'Limit to one sub-project path, for a monorepo.' },
        },
        argv: (args) => [
          'grep', String(args.pattern),
          ...when(args.match === 'literal', '--fixed'),
          ...when(args.case === 'insensitive', '--ignore-case'),
          ...when(typeof args.in === 'string' && args.in !== '', '--in', String(args.in)),
        ],
      },
      deps,
    ),

    graftTool(
      {
        name: 'graft_callers',
        description:
          'The exact call/import/extends edges for one symbol: who calls it (default), what it ' +
          'calls, or the full blast radius. Run this BEFORE renaming or changing a symbol — ' +
          'editing the obvious file and missing its callers is the classic mistake.',
        parameters: {
          symbol: { type: 'string', required: true, description: 'The symbol name to trace.' },
          direction: {
            type: 'string',
            enum: ['in', 'out'],
            description: '"in" (default) = who calls it; "out" = what it calls.',
          },
          depth: {
            type: 'string',
            description: 'How far to walk: a number ("2"), or "all" for every connected source. Default 1.',
          },
          in: { type: 'string', description: 'Limit to one sub-project path, for a monorepo.' },
        },
        argv: (args) => [
          'callers', String(args.symbol),
          ...when(args.direction === 'out', '--direction', 'out'),
          ...when(typeof args.depth === 'string' && args.depth !== '', '--depth', String(args.depth)),
          ...when(typeof args.in === 'string' && args.in !== '', '--in', String(args.in)),
        ],
      },
      deps,
    ),

    graftTool(
      {
        name: 'graft_skeleton',
        description:
          'One file\'s whole API — every signature with its line span, no bodies. About a tenth ' +
          'the tokens of reading the file, and usually enough to decide what to open.',
        parameters: {
          file: { type: 'string', required: true, description: 'Repo-relative path to the file.' },
        },
        argv: (args) => ['skeleton', String(args.file)],
      },
      deps,
    ),

    graftTool(
      {
        name: 'graft_map',
        description:
          'Orientation in an unfamiliar repo: directory clusters, per-directory hubs, and the ' +
          'global hotspots. One call is the answer — do not follow it by reading every file it names.',
        parameters: {
          max_dirs: { type: 'number', description: 'Cap on the directories listed.' },
        },
        argv: (args) => [
          'map',
          ...when(Number.isFinite(args.max_dirs) && args.max_dirs > 0, '--max-dirs', String(args.max_dirs)),
        ],
      },
      deps,
    ),
  ]
}
