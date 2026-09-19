---
layout: default
title: dsh-graft-plugin
---

# dsh-graft-plugin

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts [graft](https://github.com/trailhq/Graft) — a prebuilt graph of every symbol, its `file:line` span, and who calls what — in front of both you and the model.

[View on GitHub](https://github.com/adithyanraj03/dsh-graft-plugin){: .btn }

![language](https://img.shields.io/badge/language-javascript-f7dc6f) ![style](https://img.shields.io/badge/style-vanilla-gray) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen) ![dsh](https://img.shields.io/badge/dsh-web%20profile-orange) ![runtime](https://img.shields.io/badge/runtime-offline_%C2%B7_100%25_local-brightgreen) ![tests](https://img.shields.io/badge/tests-passing-brightgreen)

---

## Install

```sh
dsh plugin --profile web add dsh-graft-plugin
dsh --profile web
```

Every tool here shells out to the `graft` CLI, so it needs `@nanonets/graft` on PATH — `npm install -g @nanonets/graft`. A `postinstall` does this for you when your package manager runs lifecycle scripts; pnpm 10+ blocks them by default, so treat that command as the required step there.

If `add` ends with `ERR_PNPM_IGNORED_BUILDS`, dsh skips writing the plugin's bundle row — the dependency lands, the plugin stays invisible, and dsh starts up cleanly. Approve and re-run:

```sh
cd ~/.dsh/profiles/web && pnpm approve-builds
dsh plugin --profile web add dsh-graft-plugin
```

Then index a repo once:

```sh
cd <your repo>
graft build
```

That is the whole setup. The chip appears in the composer and the model gets the tools.

---

## What it does

### Names the graph you are actually on

A chip beside the model name, resolved from **the session's workspace** rather than from wherever dsh was launched:

```
● graft · my-repo      in sync
◐ graft · my-repo      syncing
▲ graft · my-repo      stale
```

![The chip in the composer, with its hover card](assets/chip.png)

This is the reason the plugin exists rather than the `graft mcp` server. `graft mcp` resolves its repo once, from its own working directory at startup, and nothing can re-point it afterwards. Launched from a home directory it answers *"no graph found"* for every workspace you open — while the CLI, run in the same repo, answers fine.

### Gives the model five tools

| tool | what it answers |
|---|---|
| `graft_ask` | "how does X work" / "where is Y" — ranked hits, code inlined at exact `file:line` |
| `graft_grep` | every occurrence, grouped by enclosing symbol |
| `graft_callers` | who calls it, what it calls, the blast radius before a rename |
| `graft_skeleton` | a file's whole API in ~200 tokens |
| `graft_map` | orientation in an unfamiliar tree |

Each is resolved per session, so one dsh can serve several workspaces at once.

None of them take a boolean parameter — they take string enums, which reads better to a model and avoids a real failure mode on some OpenAI-compatible servers where a call that *sets* a boolean is emitted as literal `<tool_call>` text and never runs.

### Keeps the index current

`/graft` builds or rebuilds on demand. After the model edits files the index rebuilds in the background, debounced so a long turn does not rebuild constantly. It reuses graft's own sync runner, so it cannot drift from what `graft build` does.

### Draws the graph

A `graft viz` button opens the visualiser as a tab — in dsh's built-in right sidebar on `0.1.5`+ (where it is also listed on the sidebar's guide page), in [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) if that is mounted, and in a browser tab as the last resort.

> **Compatibility.** `dsh-better-sidebar` 0.18.x requires `@deepseek-ai/dsh-client-ui-primitives`, which dsh removed in `0.1.5-rc.2` — on that version or later the tab will not mount. Everything else in the plugin is unaffected.

![The graph in the sidebar — context view](assets/viz-context.png)

The code view drills into a single file — what it contains, what it depends on, what depends on it:

![The graph in the sidebar — code view](assets/viz-code.png)

---

## Configuration

On the plugin's row in your profile's `cordis.patch.yml` — all optional:

```yaml
- id: graft-status
  name: 'dsh-graft-plugin'
  config:
    cwd: 'C:/path/to/repo'   # pin to one repo instead of resolving per session
    tools: false             # drop the graft_* tools, keep the chip
    command: false           # drop /graft
    promptSection: false     # stop telling the model to prefer graft
    autoBuild: false         # stop rebuilding after edits
```

---

## Requirements

| dsh | status |
|---|---|
| `0.1.2-rc.1` – `0.1.0-rc.7` | tested, full feature set — the `graft viz` tab via `dsh-better-sidebar` |
| `0.1.5-rc.2` / `0.1.5` | tested — chip, tools, `/graft` and auto-rebuild work; on `0.1.5` the `graft viz` button opens the graph in the built-in right sidebar |

- Node 22+
- the `graft` CLI on PATH (`npm install -g @nanonets/graft`)

The client bundle requires only `react`, which is why it survives the dsh `0.1.5-rc.2` client-package removals that broke several neighbouring plugins.

---

Licensed MIT. Issues and pull requests at [github.com/adithyanraj03/dsh-graft-plugin](https://github.com/adithyanraj03/dsh-graft-plugin).
