import { graftTools, repoFor, runGraft } from '../src/graft-tools.js'
import { findGraftRoot } from '../src/index.js'
import { access } from 'node:fs/promises'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''))
  if (!ok) failures += 1
}
const exists = async (p) => { try { await access(p); return true } catch { return false } }

const HOME = 'C:/Users/adith'
const STREET = 'B:/Research/Local_LLmtest/Street Yeet'
const deps = { fallbackCwd: HOME, findRoot: (s) => findGraftRoot(s, exists) }
const tools = graftTools(deps)
const byName = new Map(tools.map((t) => [t.name, t]))

console.log('--- the repo comes from the CALL, not the process ---')
check('session cwd wins', repoFor({ agent: { session: { header: { cwd: STREET } } } }, HOME) === STREET)
check('no agent falls back', repoFor(undefined, HOME) === HOME)
check('agent with no cwd falls back', repoFor({ agent: { session: { header: {} } } }, HOME) === HOME)

console.log('\n--- the five tools are registered ---')
for (const n of ['graft_ask', 'graft_grep', 'graft_callers', 'graft_skeleton', 'graft_map']) {
  check(n + ' exists', byName.has(n))
}
check('none declares a boolean parameter (the leak bug)',
  tools.every((t) => Object.values(t.parameters?.properties ?? {}).every((p) => p.type !== 'boolean')))
check('all declare a timeout so dsh bounds them', tools.every((t) => typeof t.timeoutMs === 'number'))

console.log('\n--- real calls against the REAL repos ---')
// dsh's process cwd is deliberately HOME here: the exact broken situation.
const street = { agent: { session: { header: { cwd: STREET } } } }
const map = await byName.get('graft_map').execute({ max_dirs: 3 }, street)
check('graft_map answers about Street Yeet', /tokens saved/.test(map.text) && !/no graph/i.test(map.text), map.text.split('\n')[0].slice(0, 80))

const ask = await byName.get('graft_ask').execute({ query: 'punch animation' }, street)
check('graft_ask finds code there', /tokens saved/.test(ask.text), ask.text.split('\n')[0].slice(0, 80))

const grep = await byName.get('graft_grep').execute({ pattern: 'def ', match: 'literal' }, street)
check('graft_grep runs with an enum flag', !/error|unknown option/i.test(grep.text), grep.text.split('\n')[0].slice(0, 80))

// A different session in the SAME dsh must get a different repo.
const dsh = { agent: { session: { header: { cwd: 'C:/Users/adith/.dsh' } } } }
const dshMap = await byName.get('graft_map').execute({ max_dirs: 3 }, dsh)
check('a second workspace gets ITS own graph', /tokens saved/.test(dshMap.text) && dshMap.text !== map.text)

console.log('\n--- a workspace with no index explains itself ---')
const bare = await byName.get('graft_map').execute({}, { agent: { session: { header: { cwd: 'C:/Windows' } } } })
check('says how to fix it, does not just fail', /Run `graft build`/.test(bare.text), bare.text.split('\n')[0].slice(0, 90))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
