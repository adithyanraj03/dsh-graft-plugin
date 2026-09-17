/**
 * `/graft`, end to end against a real index.
 *
 * This suite BUILDS a graft index with the real CLI, because the thing it is
 * checking is the difference between initialising and rebuilding one, and a
 * stub cannot be wrong about that. That makes graft a hard requirement, so it
 * skips rather than fails when graft is absent: a missing CLI is a setup state,
 * not a defect in this plugin, and a red suite would say the wrong thing.
 *
 * Run:  npm test
 */
import { createGraftCommand, parseArgs, workspaceOf } from '../src/command.js'
import { findGraftRoot } from '../src/index.js'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'

/** Is the graft CLI reachable? Mirrors what graft-tools.js resolves against. */
const graftInstalled = String(process.env.PATH ?? process.env.Path ?? '')
  .split(delimiter)
  .some((dir) => dir !== '' && ['graft.cmd', 'graft.exe', 'graft'].some((n) => existsSync(join(dir, n))))

if (!graftInstalled) {
  console.log('SKIP  /graft end-to-end: the graft CLI is not on PATH.')
  console.log('      Install it with:  npm install -g @nanonets/graft')
  console.log('\nSKIPPED (not a failure)')
  process.exit(0)
}

let failures = 0
const check = (l, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l + (extra ? '  -> ' + extra : '')); if (!ok) failures += 1 }
const exists = async (p) => { try { await access(p); return true } catch { return false } }
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return undefined } }

/**
 * A repo built from scratch on every run.
 *
 * The suite asserts the difference between INITIALISING and REBUILDING, so it
 * cannot reuse an index a previous run left behind — that is exactly the state
 * the first two checks are supposed to prove is absent.
 */
const FRESH = process.argv[2] ?? join(tmpdir(), 'graft-status-fixture')
await rm(FRESH, { recursive: true, force: true })
await mkdir(join(FRESH, 'src'), { recursive: true })
await writeFile(
  join(FRESH, 'src', 'shapes.py'),
  [
    'def area(w, h):',
    '    return w * h',
    '',
    'class Rect:',
    '    def __init__(self, w, h):',
    '        self.w, self.h = w, h',
    '    def area(self):',
    '        return area(self.w, self.h)',
    '',
  ].join('\n'),
)
await writeFile(
  join(FRESH, 'src', 'main.py'),
  ['from shapes import Rect', '', 'def run():', '    return Rect(3, 4).area()', ''].join('\n'),
)

const { countWiring } = await import('../src/index.js')
const cmd = createGraftCommand({ fallbackCwd: 'C:/nowhere', findRoot: (s) => findGraftRoot(s, exists), readJson, countWiring })
const invoke = (cwd, rawInput = '') => cmd.handler({ agent: { session: { header: { cwd } } }, rawInput, signal: undefined })

console.log('--- argument parsing ---')
check('bare builds', parseArgs('').mode === 'build')
check('status', parseArgs(' status ').mode === 'status')
check('deep', parseArgs('deep').mode === 'deep')
check('a typo is refused, not silently built', parseArgs('rebiuld').mode === 'unknown')

console.log('\n--- workspace resolution ---')
check('takes the session cwd', workspaceOf({ agent: { session: { header: { cwd: 'B:/x' } } } }, 'C:/f') === 'B:/x')
check('falls back', workspaceOf({}, 'C:/f') === 'C:/f')

console.log('\n--- status BEFORE any index exists ---')
const before = await invoke(FRESH, 'status')
check('says there is none, and how to fix it', /No graft index/.test(before.text) && /\/graft/.test(before.text), before.text)

console.log('\n--- /graft initialises a fresh repo ---')
const built = await invoke(FRESH)
check('reports success', built.kind === 'success', built.kind)
check('says it INITIALISED (not rebuilt)', /initialised/.test(built.text), built.text.split('\n')[0])
check('reports real counts', /\d+ nodes \/ \d+ edges/.test(built.text), built.text.split('\n')[1])
check('names the language it found', /python/i.test(built.text), built.text.split('\n')[1])
check('the index is really on disk', (await findGraftRoot(FRESH, exists)) !== undefined)

console.log('\n--- a second /graft REBUILDS rather than re-initialising ---')
const again = await invoke(FRESH)
check('wording changes to rebuilt', /rebuilt/.test(again.text), again.text.split('\n')[0])

console.log('\n--- status AFTER ---')
const after = await invoke(FRESH, 'status')
check('reports the graph and its freshness', /nodes \/ /.test(after.text) && /in sync|stale/.test(after.text), after.text.replace(/\n/g, ' | '))

console.log('\n--- an unknown option ---')
const bad = await invoke(FRESH, 'rebiuld')
check('is an error naming the valid forms', bad.kind === 'error' && /\/graft status/.test(bad.text), bad.text)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
