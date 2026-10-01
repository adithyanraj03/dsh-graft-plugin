window.__ModuleLoader__.load({
  id: "dsh-graft-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /**
     * dsh's own themed modal chrome, the same package permission-presets
     * renders its RiskConfirmation from — body-portaled, Escape + mask-click
     * handled, themed through the --dsw-* variables for free.
     *
     * Guarded: if the package is ever unresolvable the confirm falls back to
     * window.confirm, so the gate can never go missing silently.
     */
    let Primitives = null;
    try {
      Primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      Primitives = null;
    }

    /* ================================================================== *
     * graft-status — the browser half.
     *
     * Two things in the composer's trailing row, beside the model name: a
     * chip naming the repo whose graph this session is using and whether it
     * still matches the code, and a button that opens `graft viz`.
     *
     * WHERE THE VISUALISER OPENS
     *
     * As a tab in dsh-better-sidebar, through its public `ctx.betterSidebar`
     * service — `registerTab` to contribute the tab type and `openTab` to bring
     * it up. Nothing in that plugin is modified; the README states third-party
     * tabs and its own built-in eight go through the same API.
     *
     * Two earlier attempts were worse. A drawer of this plugin's own put a
     * second sidebar beside the one dsh already has. A real browser tab threw
     * the graph out of the workspace entirely. The service was there the whole
     * time; the client SLOT catalogue simply does not describe it, which is why
     * the first search for an extension point came up empty.
     *
     * The browser-tab path survives only as the fallback for a profile without
     * dsh-better-sidebar installed, where `ctx.get('betterSidebar')` is
     * undefined.
     *
     * WHY THE TRAILING ROW AND NOT THE DOCK
     *
     * `conversation.input.dock` renders in the zone ABOVE the composer — a
     * first version put the chip there and it landed adrift at the far left,
     * nowhere near the model. `conversation.input.right` is a list slot
     * rendered inside the trailing div immediately before
     * `conversation.input.model`, which is literally "next to the model name".
     *
     * WHY THE REPO NAME IS THE HEADLINE
     *
     * Counts are reassuring and almost never actionable; the wrong repo is
     * actionable and looks exactly like the right one. So the basename leads,
     * the freshness word follows, and the counts live in the hover card.
     * ================================================================== */

    function identity(value) {
      return value;
    }
    // dsh 0.1.7 strict codecs require a create() factory returning the schema;
    // the old schema:{parse} shape is refused at $mount and the client entry
    // fails to activate. Payloads are plain JSON, so parse is identity.
    const CODEC = { mode: "strict", typeSymbol: "graft-status/json", create: () => ({ parse: identity }) };
    const descriptor = (method, names) => ({
      id: "graft-status#graftStatus/" + method,
      service: "graftStatus",
      namespace: "graftStatus",
      method,
      invocation: { kind: "direct" },
      parameters: names.map((name) => ({ name, wire: name, source: "json", codec: CODEC })),
      result: { mode: "strict", typeSymbol: "graft-status/json", create: () => ({ parse: identity }) },
      sourceLocation: { file: "graft-status/client.js", line: 1, column: 1 },
    });
    const CONTRIBUTION = {
      package: "graft-status",
      descriptors: [descriptor("status", ["sessionId"]), descriptor("viz", ["sessionId"]), descriptor("build", ["sessionId"])],
    };

    /**
     * Unwrap one gateway response.
     *
     * The envelope is `{ ok, value }` / `{ ok: false, error }`. Reading a field
     * off the envelope instead yields `undefined` with no rejection — which is
     * exactly how the first version of this chip rendered as an empty "graft ·"
     * with no repo name: it was displaying the envelope, whose `ok: true` it
     * mistook for the payload's. Unwrapped once here so that cannot recur.
     */
    function unwrap(answer) {
      if (answer && answer.ok === false && answer.error) {
        const error = answer.error || {};
        throw new Error((error.code ? error.code + ": " : "") + (error.message || "the host refused the call"));
      }
      if (answer && Object.prototype.hasOwnProperty.call(answer, "value")) return answer.value;
      return answer;
    }

    /* ================================================================== *
     * Presentation
     * ================================================================== */

    /** 1106 -> "1,106"; the counts are read, not compared, so grouping wins. */
    function count(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return value.toLocaleString("en-US");
    }

    /**
     * 150427 -> "~150k". Abbreviated because an exact token estimate implies a
     * precision it does not have.
     */
    function tokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
      if (value < 1000) return "~" + value;
      if (value < 1000000) return "~" + Math.round(value / 100) / 10 + "k";
      return "~" + Math.round(value / 100000) / 10 + "M";
    }

    /** The last path segment, which is what a person calls the repo. */
    function basename(path) {
      if (typeof path !== "string" || path.length === 0) return "";
      const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
      return parts[parts.length - 1] || path;
    }

    const TONE = { synced: "gs-ok", stale: "gs-warn", syncing: "gs-busy", unknown: "gs-idle" };
    /** Shape as well as colour, never colour alone. */
    const GLYPH = { synced: "●", stale: "▲", syncing: "◐", unknown: "○" };

    function styles() {
      return [
        ".gs-wrap{display:inline-flex;align-items:center;gap:4px}",
        ".gs-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;",
        "border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:var(--dsw-alias-label-secondary,inherit);",
        "font-size:12px;line-height:1;white-space:nowrap;cursor:default;max-width:200px}",
        ".gs-chip .gs-name{font-weight:600;overflow:hidden;text-overflow:ellipsis}",
        // The repo name in the trailing-row chip. The chip caps at 200px but
        // the name itself had no ellipsis of its own, so a long workspace name
        // stretched the composer instead of collapsing to "name…". The brand
        // ("graft") and separators never shrink; this span takes the cut.
        ".gs-chip .gs-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}",
        ".gs-chip .gs-sep{opacity:.45}",
        ".gs-chip .gs-dot{font-size:9px;line-height:1}",
        ".gs-ok .gs-dot{color:var(--dsw-alias-state-success-primary,#3fa45b)}",
        ".gs-warn .gs-dot{color:var(--dsw-alias-state-warn-primary,#d08442)}",
        ".gs-busy .gs-dot{color:var(--dsw-alias-state-business-primary,#4b8bd6);display:inline-block;animation:gs-spin 900ms linear infinite}",
        "@keyframes gs-spin{to{transform:rotate(360deg)}}",
        ".gs-chip.gs-busy{animation:gs-breathe 1.4s ease-in-out infinite}",
        "@keyframes gs-breathe{0%,100%{opacity:1}50%{opacity:.62}}",
        "@media (prefers-reduced-motion:reduce){.gs-busy .gs-dot{animation:none}.gs-chip.gs-busy{animation:none}}",
        ".gs-idle .gs-dot{color:var(--dsw-alias-label-tertiary,#888)}",
        // A graft tool is running: the dot blinks violet, on and off. The
        // blinking itself is JS toggling `gs-live`; this only paints it.
        // Violet is pinned, not an alias: dsw's state palette has no violet,
        // and it must NOT borrow the busy blue — the two states would be
        // indistinguishable. Against both green and orange it also pops.
        ".gs-chip.gs-live .gs-dot{color:#8b5cf6}",
        ".gs-chip.gs-muted{opacity:.6}",
        ".gs-chip.gs-clickable{cursor:pointer}",
        ".gs-chip.gs-clickable:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.5))}",
        ".gs-chip.gs-clickable:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4b8bd6));outline-offset:2px}",
        ".gs-viz{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
        "padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);",
        "cursor:pointer;--accent:var(--dsw-alias-brand-primary,#e5484d)}",
        ".gs-viz:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
        ".gs-viz:disabled{opacity:.5;cursor:progress}",
        ".gs-viz.gs-err{color:var(--dsw-alias-state-error-primary,#e5484d)}",
        ".gs-tabwrap{display:flex;flex-direction:column;height:100%;min-height:0}",
        ".gs-tabbar{display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;min-height:32px;",
        "border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));font-size:11.5px;",
        "color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;flex:0 0 auto}",
        ".gs-tb-brand{color:var(--dsw-alias-brand-primary,#e5484d);font-weight:700}",
        ".gs-tb-sep{opacity:.38}",
        ".gs-tb-dim{color:var(--dsw-alias-label-tertiary,currentColor);opacity:.72;overflow:hidden;text-overflow:ellipsis}",
        ".gs-tb-fresh{font-weight:600}",
        ".gs-tb-fresh.gs-ok{color:var(--dsw-alias-state-success-primary,#5cbe78)}",
        ".gs-tb-fresh.gs-warn{color:var(--dsw-alias-state-warn-primary,#e0a066)}",
        ".gs-tb-fresh.gs-busy{color:var(--dsw-alias-state-business-primary,#79aee8)}",
        ".gs-tb-fresh.gs-idle{color:var(--dsw-alias-label-tertiary,#9a9a9a)}",
        ".gs-tb-saved{color:var(--dsw-alias-link,#79aee8)}",
        ".gs-refresh{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;",
        "width:24px;height:24px;flex:0 0 auto;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;",
        "color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;opacity:.75}",
        ".gs-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));opacity:1}",
        ".gs-refresh.gs-spinning svg{animation:gs-spin 600ms linear}",
        ".gs-tabframe{width:100%;flex:1 1 auto;min-height:0;border:0;background:var(--dsw-alias-bg-base,transparent);display:block}",
        ".gs-tabmsg{padding:14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}",
        ".gs-tabreason{margin-top:6px;opacity:.7;font-family:ui-monospace,monospace;font-size:11px;word-break:break-word}",
        ".gs-wrap{position:relative}",
        ".gs-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:80;width:296px;",
        "padding:12px 13px;border-radius:12px;pointer-events:none;text-align:left;",
        "border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));",
        "background:var(--dsw-alias-bg-layer-2,#1b1b1e);color:var(--dsw-alias-label-primary,inherit);",
        "box-shadow:0 10px 30px rgba(0,0,0,.34);font-size:12px;line-height:1.5;",
        "opacity:0;transform:translateY(4px);animation:gs-pop-in .13s ease-out forwards}",
        "@keyframes gs-pop-in{to{opacity:1;transform:none}}",
        ".gs-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}",
        ".gs-pop-head .gs-pop-title{font-weight:700;letter-spacing:.02em}",
        // Pill + Build travel as ONE group at the header's right: the wrapper
        // carries the row's only auto margin, so the 8px flex gap is the only
        // thing between the pair and nothing can split them — either apart or
        // across the header.
        ".gs-pop-group{margin-left:auto;display:inline-flex;align-items:center;gap:8px}",
        ".gs-pill{font-size:9.5px;font-weight:700;text-transform:uppercase;",
        "letter-spacing:.07em;padding:3px 8px;border-radius:999px;white-space:nowrap}",
        ".gs-pill.gs-p-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fa45b) 18%,transparent);color:var(--dsw-alias-state-success-primary,#5cbe78)}",
        ".gs-pill.gs-p-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d08442) 20%,transparent);color:var(--dsw-alias-state-warn-primary,#e0a066)}",
        ".gs-pill.gs-p-busy{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4b8bd6) 20%,transparent);color:var(--dsw-alias-state-business-primary,#79aee8)}",
        ".gs-pill.gs-p-idle{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 20%,transparent);color:var(--dsw-alias-label-tertiary,#9a9a9a)}",
        ".gs-pop-repo{font-weight:600;font-size:12.5px;margin-bottom:2px}",
        ".gs-pop-path{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;",
        "color:var(--dsw-alias-label-tertiary,inherit);opacity:.58;word-break:break-all}",
        ".gs-pop-stats{display:flex;gap:18px;margin:11px 0 0;padding:10px 0 2px;",
        "border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}",
        ".gs-stat b{display:block;font-size:15px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}",
        ".gs-stat i{display:block;font-style:normal;font-size:9.5px;text-transform:uppercase;",
        "letter-spacing:.07em;opacity:.55;margin-top:1px}",
        ".gs-pop-note{margin-top:10px;padding-top:9px;font-size:11px;opacity:.68;",
        "border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}",
        // The popup's Build button, grouped with the status pill at the
        // header's right (see .gs-pop-group). Quiet at header scale — an
        // outline button, not the brand fill — because a 24px solid pill
        // would dominate the 9.5px status pill it sits beside. Disabled (and
        // labelled Building…) while the build runs, so a double click cannot
        // queue two of them.
        //
        // pointer-events:auto is load-bearing, not cosmetic: the card itself
        // is pointer-events:none (pure text needs no clicks and must not eat
        // them), so without this the button renders but can never be pressed.
        ".gs-build{pointer-events:auto;display:inline-flex;align-items:center;height:20px;padding:0 10px;",
        "border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:999px;",
        "background:transparent;color:var(--dsw-alias-label-secondary,inherit);",
        "font-size:10.5px;font-weight:600;cursor:pointer;white-space:nowrap}",
        ".gs-build:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
        ".gs-build:disabled{opacity:.6;cursor:progress}",
        // The confirm modal's footer: Cancel beside a brand-fill accept, in
        // the theme's own button language. The Modal itself (mask, card,
        // Escape, focus) is dsh's chrome and needs no styles here.
        ".gs-modal-foot{display:flex;gap:8px;justify-content:flex-end}",
        ".gs-build.gs-confirm{background:var(--dsw-alias-brand-primary,#e5484d);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
        ".gs-pop-reason{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;",
        "opacity:.75;word-break:break-word;margin-top:4px}",
      ].join("");
    }

    function injectStyles() {
      const id = "graft-status-styles";
      if (document.getElementById(id) !== null) return;
      const tag = document.createElement("style");
      tag.id = id;
      tag.textContent = styles();
      document.head.appendChild(tag);
    }

    /** The freshness word as a short, colour-coded pill. */
    const PILL = {
      synced: { className: "gs-p-ok", label: "in sync" },
      stale: { className: "gs-p-warn", label: "stale" },
      syncing: { className: "gs-p-busy", label: "syncing" },
      unknown: { className: "gs-p-idle", label: "unknown" },
    };

    /**
     * The hover card.
     *
     * Replaces a `title` attribute, which the browser rendered as a wall of
     * plain grey text with the repo path, the counts and a caveat all weighted
     * identically. Here the two things that decide something — WHICH repo, and
     * whether it is current — lead and are colour-coded, and the numbers sit
     * under them as supporting detail.
     */
    function StatusCard(props) {
      const { status, runBuild, onSynced } = props;
      const [building, setBuilding] = React.useState(false);
      const [buildError, setBuildError] = React.useState(null);
      // Whether the themed confirm modal is open (no index yet). Held here
      // because only the no-graph path ever asks.
      const [confirming, setConfirming] = React.useState(false);

      // The popup's Build button runs the same rebuild the automatic hooks
      // run, for this session's repo — or the plain offline initialise when
      // there is no index yet. It holds Building… until OBSERVED freshness
      // flips to synced — not until the build call lands, which only means
      // "started". A bare `graft build` was tried here first and shipped as
      // a press that changed nothing: the child exited while stats.json still
      // read dirty, the button re-enabled against a pill that still said
      // STALE, and the pill only moved when some later rebuild rewrote stats.
      // A timed-out wait re-enables with the last error rather than holding
      // Building… forever.
      const proceed = React.useCallback(() => {
        if (building || typeof runBuild !== "function") return;
        // Indexed: rebuild at once, no question. Unindexed: indexing a tree
        // writes a graft/ directory into it, so the press asks first and a
        // decline builds nothing. A blind press that silently indexed whatever
        // happened to be open shipped once; this gate is the reason it will
        // not ship again.
        if (status !== null && status.ok === true) {
          startBuild();
          return;
        }
        if (Primitives !== null && typeof Primitives.Modal === "function") {
          setConfirming(true);
          return;
        }
        // Primitives unresolvable: the ugly box is better than no gate.
        if (
          window.confirm(
            "Build a new graft index in this workspace?\n\n" +
              String(status.from ?? status.root ?? "") +
              "\n\nPlain structural build — offline, no API key needed.",
          )
        ) {
          startBuild();
        }
      }, [building, runBuild, status]);
      const startBuild = React.useCallback(() => {
        if (building || typeof runBuild !== "function") return;
        setBuilding(true);
        setBuildError(null);
        setConfirming(false);
        const finish = (ok, reason) => {
          setBuilding(false);
          if (!ok) setBuildError(String(reason || "unknown reason"));
        };
        Promise.resolve(runBuild()).then(
          (answer) => {
            let started;
            try {
              started = unwrap(answer);
            } catch (error) {
              finish(false, String(error?.message ?? error));
              return;
            }
            if (!started || started.ok !== true) {
              finish(false, String((started && started.reason) || "unknown reason"));
              return;
            }
            // A fresh initialise has no stats.json yet for a freshness poll to
            // observe, so there is nothing to wait for — the next status poll
            // picks the new graph up on its own.
            if (started.initialising === true) {
              finish(true);
              return;
            }
            if (typeof onSynced === "function") {
              Promise.resolve(onSynced()).then(
                (synced) => finish(synced === true, synced === true ? null : "the rebuild did not report in sync — try again"),
                (error) => finish(false, String(error?.message ?? error)),
              );
            } else {
              finish(true);
            }
          },
          (error) => {
            finish(false, String(error?.message ?? error));
          },
        );
      }, [building, runBuild, onSynced]);

      // One pair, rendered in both pill-carrying heads: pill and button
      // grouped at the header's right, travelling together.
      const headGroup = (pill) =>
        h(
          "div",
          { className: "gs-pop-group" },
          pill,
          h(
            "button",
            {
              type: "button",
              className: "gs-build",
              onClick: () => proceed(),
              disabled: building,
            },
            building ? "Building…" : "Build",
          ),
        );
      const buildFailure =
        buildError === null ? null : h("div", { className: "gs-pop-reason" }, buildError);
      if (status === null || status === undefined) {
        return h(
          "div",
          { className: "gs-pop", role: "tooltip" },
          h("div", { className: "gs-pop-head" }, h("span", { className: "gs-pop-title" }, "graft")),
          h("div", { className: "gs-pop-note" }, "Checking this workspace…"),
        );
      }

      if (status.ok !== true) {
        // The themed confirm: dsh's own Modal, same chrome as every other
        // dialog in the app. Rendered here (not in the head) because a modal
        // portals to the body — it must not live inside the click-through
        // card. Cancel/Escape/mask-click closes and builds nothing; the
        // accept starts the initialise.
        const confirmModal =
          Primitives !== null && typeof Primitives.Modal === "function"
            ? h(
                Primitives.Modal,
                {
                  open: confirming,
                  onClose: () => {
                    if (!building) setConfirming(false);
                  },
                  title: "Build graft index?",
                  description:
                    "Index " +
                    basename(String(status.from ?? status.root ?? "")) +
                    " with a plain structural build — offline, no API key needed. Writes a graft/ directory there.",
                  closeLabel: "Close",
                  footer: h(
                    "div",
                    { className: "gs-modal-foot" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "gs-build",
                        onClick: () => setConfirming(false),
                        disabled: building,
                      },
                      "Cancel",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "gs-build gs-confirm",
                        onClick: () => startBuild(),
                        disabled: building,
                        "data-modal-autofocus": true,
                      },
                      building ? "Building…" : "Build index",
                    ),
                  ),
                },
              )
            : null;
        return h(
          "div",
          { className: "gs-pop", role: "tooltip" },
          h(
            "div",
            { className: "gs-pop-head" },
            h("span", { className: "gs-pop-title" }, "graft"),
            headGroup(h("span", { className: "gs-pill gs-p-idle" }, "no graph")),
          ),
          h("div", null, "No graft index for this workspace."),
          h("div", { className: "gs-pop-reason" }, String(status.reason ?? "unknown reason")),
          status.worktreeOf
            ? h("div", { className: "gs-pop-note" }, "git worktree of " + basename(status.worktreeOf) + " — /graft here seeds the first graph from it.")
            : null,
          h("div", { className: "gs-pop-note" }, "Run `graft build` in it once — no API key needed."),
          buildFailure,
          confirmModal,
        );
      }

      const freshness = status.freshness ?? "unknown";
      const pill = PILL[freshness] ?? PILL.unknown;
      const saved = tokens(status.savedTokens);

      return h(
        "div",
        { className: "gs-pop", role: "tooltip" },
        h(
          "div",
          { className: "gs-pop-head" },
          h("span", { className: "gs-pop-title" }, "graft"),
          headGroup(h("span", { className: "gs-pill " + pill.className }, pill.label)),
        ),
        h("div", { className: "gs-pop-repo" }, basename(status.root)),
        h("div", { className: "gs-pop-path" }, status.root),
        status.worktreeOf
          ? h("div", { className: "gs-pop-note" }, "git worktree of " + basename(status.worktreeOf))
          : null,
        h(
          "div",
          { className: "gs-pop-stats" },
          h("div", { className: "gs-stat" }, h("b", null, count(status.nodeCount)), h("i", null, "nodes")),
          h("div", { className: "gs-stat" }, h("b", null, count(status.edgeCount)), h("i", null, "edges")),
          saved === null ? null : h("div", { className: "gs-stat" }, h("b", null, saved), h("i", null, "tokens saved")),
        ),
        freshness === "stale"
          ? h("div", { className: "gs-pop-note" }, "The code changed since the last sync — run `graft build` to catch the graph up.")
          : status.source === "graph"
            // Said plainly rather than hidden: without the cache there is no
            // drift signal at all, so "in sync" is an absence of evidence.
            ? h("div", { className: "gs-pop-note" }, "Read from the graph itself; no live drift signal.")
            : null,
        buildFailure,
      );
    }

    /** The graph mark, exactly as supplied. `--accent` is set by `.gs-viz`. */
    function GraphIcon() {
      return h(
        "svg",
        { width: 19, height: 19, viewBox: "0 0 24 24", "aria-hidden": "true" },
        h(
          "g",
          { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" },
          h("path", { d: "M12 21 V12" }),
          h("path", { d: "M12 12 L6.8 6.6" }),
          h("path", { stroke: "var(--accent)", d: "M12 12 L17.4 7.6" }),
        ),
        h("circle", { cx: 12, cy: 12, r: 2.1, fill: "currentColor" }),
        h("circle", { cx: 6.8, cy: 6.6, r: 1.7, fill: "currentColor" }),
        h("circle", { cx: 17.4, cy: 7.6, r: 1.7, fill: "var(--accent)" }),
      );
    }

    /**
     * The placeholder the new tab shows while `graft viz` boots.
     *
     * The tab has to be opened synchronously inside the click handler or the
     * popup blocker eats it, but the URL is not known for up to ten seconds
     * (the server has to come up and start accepting). Without this the user
     * stares at a blank white tab and assumes it broke.
     */
    function waitingDocument(repo) {
      // A popped-out document cannot see the app's theme variables; the best
      // it can do is follow the OS preference.
      const dark = window.matchMedia !== undefined && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const bg = dark ? "#161616" : "#f6f6f6";
      const fg = dark ? "#ddd" : "#333";
      return [
        "<!doctype html><meta charset=utf-8>",
        "<title>graft viz — ", repo, "</title>",
        "<style>body{margin:0;display:grid;place-items:center;height:100vh;",
        "font:14px system-ui,sans-serif;background:", bg, ";color:", fg, "}</style>",
        "<div>Starting <b>graft viz</b> for ", repo, "…</div>",
      ].join("");
    }

    /** This viewer's identity: better-sidebar's tab type, and dsh's tab id. */
    const TAB_TYPE = "graft-status:viz";

    /**
     * The kind dsh's own right sidebar opens this page type by.
     *
     * dsh 0.1.5 splits a tab type in two: a static registration naming the kind
     * (`ctx.sidebarRightTabs`), and the body under the registration's id in the
     * keyed `sidebar.right.pane.tab` seat. `ctx.sidebarRight.openTab(kind)`
     * then opens it AND expands a collapsed column in the same step.
     */
    const VIZ_KIND = "graft-viz";

    /**
     * The sidebar tab: `graft viz` in an iframe.
     *
     * `visible` is false while the tab exists but is not the focused one, and
     * the host's own note says live views should pause then. So the server is
     * not started until the tab is actually looked at — opening it from the +
     * menu and never selecting it should not spawn a process.
     */
    /** Counts as graft's own statusline prints them: no digit grouping. */
    const plain = (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "—");

    /**
     * The savings figure in full, grouped for the reader's own locale.
     *
     * The chip abbreviates this to `~664k` because it is one line among four in
     * a small card. Here it has a bar to itself, so it is shown the way graft's
     * own statusline shows it — and with no locale argument, so a reader whose
     * system groups as `6,63,783` sees exactly that rather than a US regrouping
     * of their own number.
     */
    function tokensFull(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
      return "~" + Math.round(value).toLocaleString() + " tok saved";
    }

    const FRESH_MARK = { synced: "✓ synced", stale: "▲ stale", syncing: "◐ syncing", unknown: "○ unknown" };

    /**
     * How long the Build button waits for observed sync before giving up.
     *
     * Two minutes of 2s polls: a structural rebuild of a normal repo takes
     * about a second, a large one can take minutes, and a wedged one must not
     * hold Building… forever.
     */
    const SYNC_WAIT_MS = 120000;

    /** ⟳ — the one control adopted from the sidebar's own tab headers. */
    function RefreshIcon() {
      return h(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
        h("path", { d: "M21 3v6h-6" }),
      );
    }

    function makeVizTab(ctx) {
      return function GraftVizTab(props) {
        const [viz, setViz] = React.useState(null);
        const [status, setStatus] = React.useState(null);
        const [reload, setReload] = React.useState(0);
        const [busy, setBusy] = React.useState(false);
        // Visible by default: better-sidebar passes `visible: false` for a tab
        // that exists but is not focused (and asks live views to pause then);
        // dsh's sidebar mounts only what it draws and passes nothing.
        const visible = props?.visible !== false;
        // Which workspace to resolve. Both hosts supply the session, in their
        // own shape: dsh passes `sessionId` straight to the body, while
        // better-sidebar wraps it in the tab's `scope`.
        const sessionId = props?.sessionId ?? props?.scope?.sessionId;

        React.useEffect(() => {
          if (!visible || viz !== null) return;
          let live = true;
          const service = ctx.get("remote.graftStatus");
          if (service === undefined || service === null) {
            setViz({ ok: false, reason: "graft-status host half is not mounted" });
            return;
          }
          // Always asked, never seeded from `tab.path`. The seed's only job is
          // to make `openTab` treat this as a content open so a collapsed panel
          // expands; trusting it as the URL would iframe a stale address after
          // the server was restarted for another repo.
          Promise.resolve(service.viz(sessionId)).then(
            (answer) => {
              if (live) setViz(unwrap(answer));
            },
            (error) => {
              if (live) setViz({ ok: false, reason: String(error?.message ?? error) });
            },
          );
          return () => {
            live = false;
          };
        }, [visible, viz, sessionId]);

        // The header's own data. Separate from `viz` because the numbers move
        // whenever the graph is rebuilt while the server URL does not, so they
        // are re-read on every refresh and the iframe is left alone unless the
        // reader asks for it.
        React.useEffect(() => {
          if (!visible) return;
          let live = true;
          const service = ctx.get("remote.graftStatus");
          if (service === undefined || service === null) return;
          Promise.resolve(service.status(sessionId)).then(
            (answer) => {
              if (live) setStatus(unwrap(answer));
            },
            () => {},
          );
          return () => {
            live = false;
          };
        }, [visible, sessionId, reload]);

        const refresh = React.useCallback(() => {
          setBusy(true);
          // Bumping the key remounts the iframe, which reloads it without
          // touching the URL. A cache-busting query parameter would work too,
          // but it would put a parameter graft never asked for into the address
          // the reader can copy out.
          setReload((n) => n + 1);
          window.setTimeout(() => setBusy(false), 600);
        }, []);

        const ok = status !== null && status.ok === true;
        const freshness = ok ? status.freshness ?? "unknown" : "unknown";
        const saved = ok ? tokensFull(status.savedTokens) : null;
        const wt = status !== null && status.worktreeOf ? basename(status.worktreeOf) : null;

        const bar = h(
          "div",
          { className: "gs-tabbar" },
          h("span", { className: "gs-tb-brand" }, "graft"),
          ok
            ? h(
                React.Fragment,
                null,
                h("span", { className: "gs-tb-sep" }, "·"),
                h("span", { className: "gs-tb-dim" }, plain(status.nodeCount) + " nodes / " + plain(status.edgeCount) + " edges"),
                h("span", { className: "gs-tb-sep" }, "·"),
                h("span", { className: "gs-tb-fresh " + (TONE[freshness] ?? TONE.unknown) }, FRESH_MARK[freshness] ?? FRESH_MARK.unknown),
                saved === null ? null : h("span", { className: "gs-tb-sep" }, "·"),
                saved === null ? null : h("span", { className: "gs-tb-saved" }, saved),
                wt === null ? null : h("span", { className: "gs-tb-sep" }, "·"),
                wt === null ? null : h("span", { className: "gs-tb-dim" }, "worktree of " + wt),
              )
            : h("span", { className: "gs-tb-dim" }, status === null ? "…" : wt === null ? "no graph" : "no graph — worktree of " + wt),
          h(
            "button",
            {
              type: "button",
              className: "gs-refresh" + (busy ? " gs-spinning" : ""),
              onClick: refresh,
              title: "Reload the visualisation",
              "aria-label": "Reload the visualisation",
            },
            h(RefreshIcon),
          ),
        );

        let body;
        if (viz === null) {
          body = h("div", { className: "gs-tabmsg" }, "Starting graft viz…");
        } else if (viz.ok !== true) {
          body = h(
            "div",
            { className: "gs-tabmsg" },
            h("div", null, "graft viz could not start."),
            h("div", { className: "gs-tabreason" }, String(viz.reason ?? "unknown reason")),
          );
        } else {
          body = h("iframe", { key: reload, className: "gs-tabframe", src: viz.url, title: "graft visualisation" });
        }

        return h("div", { className: "gs-tabwrap" }, bar, body);
      };
    }

    function makeSeat(ctx) {
      return function GraftSeat(props) {
        // Supplied by the slot registration's own `inject(sessionId)` below.
        const sessionId = props?.sessionId;
        const [status, setStatus] = React.useState(null);
        const [viz, setViz] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [card, setCard] = React.useState(false);
        const dwell = React.useRef(null);
        const wrap = React.useRef(null);

        // Whether the dot should be blinking violet right now: a graft tool call
        // was seen and its blink window has not run out yet.
        const [flick, setFlick] = React.useState(false);
        // Whether a graft tool was seen recently. Outlives the blink on
        // purpose: it holds the fast poll for a tail after the last pulse, so
        // the NEXT call in an active burst is caught within one fast tick
        // instead of waiting out the slow settled cadence — exactly the lag a
        // second tool call used to show.
        const [recent, setRecent] = React.useState(false);
        const recentTimer = React.useRef(null);
        // The last pulse consumed, as { root, count }: the blink fires when the
        // count MOVES for the repo this chip describes, never on first sight.
        const pulseSeen = React.useRef(null);
        const flickTimers = React.useRef([]);

        // Whether the graph is at rest. Drives the poll cadence below.
        const settled = status !== null && status.ok === true && status.freshness === "synced";

        /**
         * Two seconds of dwell before the card appears.
         *
         * Long on purpose. The chip sits in the composer, which the pointer
         * crosses constantly on its way to the send button, and a card that
         * appeared on contact would flash on every pass. Two seconds is
         * unmistakably "I am looking at this".
         */
        const enter = React.useCallback(() => {
          window.clearTimeout(dwell.current);
          dwell.current = window.setTimeout(() => setCard(true), 2000);
        }, []);
        const leave = React.useCallback(() => {
          window.clearTimeout(dwell.current);
          // Only hover-opened cards close on leave. One opened by a CLICK is a
          // deliberate act and stays until it is dismissed, so the pointer can
          // move away — to read it, or to reach for something else — without
          // the card vanishing mid-sentence.
          setCard((open) => (open === "click" ? open : false));
        }, []);

        // Clicking the chip shows the card at once, and clicking again hides
        // it: the same affordance without waiting out the dwell.
        const toggleCard = React.useCallback(() => {
          window.clearTimeout(dwell.current);
          setCard((open) => (open === "click" ? false : "click"));
        }, []);

        // A click-opened card is dismissed by clicking away from it, the way
        // every other popover in this UI behaves. Only that mode listens: a
        // hover card already closes on mouse-out, and a document-wide listener
        // for it would fire on every click in the composer for nothing.
        React.useEffect(() => {
          if (card !== "click") return;
          const onDocument = (event) => {
            // `contains` rather than a target comparison, so a click on the
            // card's own text — or on the chip, which toggles — is not treated
            // as "outside" and closed twice. Clicks inside the confirm modal
            // are ALSO inside: it portals to document.body, outside the wrap,
            // so without this guard the capture-phase closer unmounts the card
            // (modal included) before the accept's own click ever dispatches —
            // an accept that hides the dialog and builds nothing.
            const inModal =
              event.target instanceof Element && event.target.closest('[role="dialog"], .gs-modal-foot') !== null;
            if (inModal) return;
            if (wrap.current !== null && wrap.current.contains(event.target)) return;
            setCard(false);
          };
          // Capture phase: a handler that stops propagation somewhere in the
          // composer would otherwise leave the card stuck open.
          document.addEventListener("mousedown", onDocument, true);
          return () => document.removeEventListener("mousedown", onDocument, true);
        }, [card]);
        // A pending timer that fires after unmount would set state on a dead
        // component; one that fires after the session switched would show the
        // previous workspace's card.
        React.useEffect(() => () => window.clearTimeout(dwell.current), []);
        // The blink must not cross a session boundary — this component stays
        // mounted across one — and its timers must not outlive it. Effect
        // cleanup runs for both, so this one block is the whole hygiene.
        React.useEffect(
          () => () => {
            for (const t of flickTimers.current) window.clearTimeout(t);
            flickTimers.current = [];
            window.clearTimeout(recentTimer.current);
            pulseSeen.current = null;
            setFlick(false);
            setRecent(false);
          },
          [sessionId],
        );

        // Blink the dot violet on and off — intermittent, never solid — for just
        // under two seconds, toggling every 175ms. The mark list is EVEN on
        // purpose: the final toggle is always "off", so the dot returns to its
        // resting colour instead of sticking on violet. A pulse arriving
        // mid-blink restarts the run, so a burst of graft calls reads as one
        // flicker that ends when they do.
        const blink = React.useCallback(() => {
          for (const t of flickTimers.current) window.clearTimeout(t);
          flickTimers.current = [];
          for (const ms of [0, 175, 350, 525, 700, 875, 1050, 1225, 1400, 1575, 1750, 1925]) {
            const on = flickTimers.current.length % 2 === 0;
            flickTimers.current.push(window.setTimeout(() => setFlick(on), ms));
          }
        }, []);

        // Consume one polled status: blink when its tool-use count has moved
        // for THIS repo. A first look — or the first look after the chip
        // switched repos — only sets the baseline, so history never blinks.
        const pulseCheck = React.useCallback(
          (next) => {
            const count = next?.toolUse?.count;
            if (typeof count !== "number") return;
            const seen = pulseSeen.current;
            if (seen === null || seen.root !== next.root) {
              pulseSeen.current = { root: next.root, count };
              return;
            }
            if (count > seen.count) {
              pulseSeen.current = { root: next.root, count };
              blink();
              // Hold the fast poll for a tail after the last use, so the next
              // call in a burst is seen within one tick of the harness's own
              // tool feedback.
              setRecent(true);
              window.clearTimeout(recentTimer.current);
              recentTimer.current = window.setTimeout(() => setRecent(false), 20000);
            }
          },
          [blink],
        );

        React.useEffect(() => {
          let live = true;
          const pull = () => {
            const service = ctx.get("remote.graftStatus");
            if (service === undefined || service === null) {
              if (live) setStatus({ ok: false, reason: "graft-status host half is not mounted" });
              return;
            }
            Promise.resolve(service.status(sessionId)).then(
              (answer) => {
                if (!live) return;
                const next = unwrap(answer);
                setStatus(next);
                pulseCheck(next);
              },
              (error) => {
                if (live) setStatus({ ok: false, reason: String(error?.message ?? error) });
              },
            );
          };
          pull();
          // Adaptive, because a fixed 15s interval made the `syncing` state
          // effectively invisible: a rebuild of a small repo finishes in about
          // a second, so the odds of a poll landing inside that window were
          // near zero and the chip appeared to jump straight from stale back
          // to green. While the graph is MOVING — stale, mid-sync, or not yet
          // known — it is watched closely; once it is in sync there is nothing
          // to watch. Even at rest it still polls at 4s rather than the old
          // 15s, because graft tool feedback must keep up with the harness's
          // own tool feedback — a settled chip that only looked twice a minute
          // was the reported lag on every call after the first. The server
          // caches status for 5s, so 4s adds no real reads; a pulse then holds
          // the 2s cadence for a 20s tail.
          const timer = window.setInterval(pull, settled && !recent ? 4000 : 2000);
          return () => {
            live = false;
            window.clearInterval(timer);
          };
          // `settled` is a dependency, not just a value read inside: without it
          // the interval would keep whatever cadence it had at mount — 2s, from
          // the initial unknown state — and never slow down again.
        }, [sessionId, settled, recent, pulseCheck]);

        // The build the popup button triggers. Resolved here, in a callback
        // like every other remote access, rather than in render.
        const runBuild = React.useCallback(() => {
          const service = ctx.get("remote.graftStatus");
          if (service === undefined || service === null) {
            return Promise.reject(new Error("graft-status host half is not mounted"));
          }
          return service.build(sessionId);
        }, [sessionId]);

        // Re-read status on demand — after the popup's Build lands — rather
        // than waiting out the poll. Returns the observed freshness, so a
        // waiter can hold until the rebuild is VISIBLE, not just started.
        const repull = React.useCallback(() => {
          const service = ctx.get("remote.graftStatus");
          if (service === undefined || service === null) return Promise.resolve(null);
          return Promise.resolve(service.status(sessionId)).then(
            (answer) => {
              const next = unwrap(answer);
              setStatus(next);
              pulseCheck(next);
              return next !== null && next.ok === true ? next.freshness ?? "unknown" : null;
            },
            () => null,
          );
        }, [sessionId, pulseCheck]);

        // Hold until a re-read OBSERVES `synced`, not until the build call
        // lands: the rebuild runs detached, so "started" says nothing about
        // what stats.json reads yet. Bounded — two minutes of 2s polls — so a
        // wedged rebuild re-enables the button with the last error rather
        // than holding Building… forever.
        const waitForSynced = React.useCallback(() => {
          const started = Date.now();
          const look = () =>
            Promise.resolve(repull()).then((freshness) => {
              if (freshness === "synced") return true;
              if (Date.now() - started > SYNC_WAIT_MS) return false;
              return new Promise((resolve) => window.setTimeout(() => resolve(look().then(resolve)), 2000));
            });
          return look();
        }, [repull]);

        const openViz = React.useCallback(() => {
          const repo = basename((status && status.root) || "");

          // Preferred path: a tab in the sidebar dsh already has.
          //
          // No window is opened here, so none of the popup-blocker timing
          // below applies — the await is free.
          const sidebar = ctx.get("betterSidebar");
          if (sidebar !== undefined && sidebar !== null) {
            // ALWAYS carries a `url`, even when there is no server yet.
            //
            // `openTab` expands a collapsed panel only for a CONTENT open (a
            // `path` or `url` seed); a type-only open is documented to leave
            // the panel exactly as it found it, so clicking the button with
            // the sidebar collapsed would appear to do nothing at all. The tab
            // component never reads this value — it asks the host itself on
            // every mount — so the placeholder is inert, and its only job is
            // to make the open a content open.
            const open = (url) =>
              sidebar.openTab({ type: TAB_TYPE, title: "Graft", url: url || "graft://starting" });

            if (viz !== null && viz.ok === true && viz.url) {
              open(viz.url);
              return;
            }
            // Opened FIRST, before the await: the panel comes out on the click
            // itself, showing "Starting graft viz…" while the server boots,
            // rather than staying shut for the ten seconds that can take.
            open(null);

            const service = ctx.get("remote.graftStatus");
            if (service === undefined || service === null) {
              setViz({ ok: false, reason: "graft-status host half is not mounted" });
              return;
            }
            setBusy(true);
            Promise.resolve(service.viz(sessionId)).then(
              (answer) => {
                setViz(unwrap(answer));
                setBusy(false);
              },
              (error) => {
                setViz({ ok: false, reason: String(error?.message ?? error) });
                setBusy(false);
              },
            );
            return;
          }

          // Next: dsh's own right sidebar (0.1.5+). `openTab` names the KIND,
          // reveals the column, and reuses the tab that is already open, so a
          // second click focuses the graph rather than stacking another.
          // The body starts the server itself on mount, so nothing is awaited
          // here and no popup-blocker timing applies.
          const right = ctx.get("sidebarRight");
          if (right !== undefined && right !== null && typeof right.openTab === "function") {
            try {
              right.openTab(VIZ_KIND);
              return;
            } catch (error) {
              // openTab throws for a kind nothing registered — which is the
              // case when the tab registry was absent at load. Fall through to
              // the browser tab rather than leaving the click dead.
              console.warn("[graft-status] right sidebar refused the viz tab:", error);
            }
          }

          // Last resort, for a profile with neither sidebar: a browser tab.

          // Opened SYNCHRONOUSLY, before any await. A tab opened from a
          // resolved promise is a popup as far as the browser is concerned and
          // is blocked; opened from the click itself it is a user gesture.
          //
          // NOT `noopener`. Per the HTML spec, window.open returns NULL when
          // noopener is set — the whole point of the flag is to sever the
          // handle. A first version passed it and then tried to use the handle
          // it had just given away, so the tab opened, stayed at about:blank,
          // and was never written to or navigated: a permanent white page.
          // The handle is required here because the URL is not known yet.
          // The cost is that graft viz gets a cross-origin `window.opener` —
          // acceptable for a localhost tool this plugin spawned itself.
          const tab = window.open("", "_blank");
          if (tab !== null && tab.document !== undefined) {
            try {
              tab.document.write(waitingDocument(repo));
              tab.document.close();
            } catch {
              // A blocker can hand back a tab that is not writable. The
              // navigation below still works, so this is cosmetic only.
            }
          }

          const land = (url) => {
            if (tab !== null) {
              tab.location.href = url;
              return;
            }
            // The tab was blocked. Say so with the URL rather than failing
            // silently — the server is running either way.
            setViz({ ok: false, reason: "your browser blocked the new tab — open " + url + " yourself" });
          };

          // `graft viz` holds a fixed port and the host adopts a server that is
          // already up, so a second click is cheap; the known URL just skips
          // the round trip.
          if (viz !== null && viz.ok === true && viz.url) {
            land(viz.url);
            return;
          }

          const service = ctx.get("remote.graftStatus");
          if (service === undefined || service === null) {
            if (tab !== null) tab.close();
            setViz({ ok: false, reason: "graft-status host half is not mounted" });
            return;
          }

          setBusy(true);
          Promise.resolve(service.viz(sessionId)).then(
            (answer) => {
              const next = unwrap(answer);
              setViz(next);
              setBusy(false);
              if (next && next.ok === true && next.url) land(next.url);
              else if (tab !== null) tab.close();
            },
            (error) => {
              setViz({ ok: false, reason: String(error?.message ?? error) });
              setBusy(false);
              if (tab !== null) tab.close();
            },
          );
        }, [status, viz]);

        // NEVER returns null.
        //
        // The first version hid itself whenever the status was not ok, on the
        // theory that a chip reading "no graft" is furniture in a repo that
        // does not use graft. That was wrong twice over: the plugin is only
        // installed by someone who does use graft, and hiding took the VIZ
        // BUTTON with it — so the one situation that needs explaining (graft
        // resolved to nothing) produced a blank composer and no way to ask
        // why. A failure you can see is worth more than a tidy bar.
        const ok = status !== null && status.ok === true;
        const freshness = ok ? status.freshness ?? "unknown" : "unknown";
        const tone = ok ? TONE[freshness] ?? TONE.unknown : TONE.unknown;
        const glyph = status === null ? "◌" : ok ? GLYPH[freshness] ?? GLYPH.unknown : GLYPH.unknown;
        const label = status === null ? "…" : ok ? basename(status.root) : "no graph";
        // A failed start stays visible on the button rather than vanishing on
        // the next render: the tab it would have explained itself in is gone.
        const failed = viz !== null && viz.ok === false;

        return h(
          "div",
          { className: "gs-wrap", ref: wrap },
          card
            ? h(StatusCard, {
                status,
                runBuild,
                // The button holds Building… until this OBSERVES synced, so
                // the pill flips first and the button follows — never the
                // other way round.
                onSynced: waitForSynced,
              })
            : null,
          h(
            "div",
            {
              className:
                "gs-chip gs-clickable " + tone + (ok ? "" : " gs-muted") + (flick ? " gs-live" : ""),
              onMouseEnter: enter,
              onMouseLeave: leave,
              onClick: toggleCard,
              // Reachable without a pointer, and announced as what it is: a
              // control that discloses detail, not a button that acts.
              role: "button",
              tabIndex: 0,
              "aria-expanded": card !== false,
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleCard();
                } else if (event.key === "Escape") {
                  leave();
                  setCard(false);
                }
              },
              // No `title`: the browser would render its own grey box over the
              // card, on its own schedule, saying the same thing worse.
            },
            h("span", { className: "gs-dot", "aria-hidden": "true" }, glyph),
            h("span", { className: "gs-name" }, "graft"),
            h("span", { className: "gs-sep" }, "·"),
            h("span", { className: "gs-label" }, label),
            ok && freshness === "stale" ? h("span", { className: "gs-sep" }, "·") : null,
            ok && freshness === "stale" ? h("span", null, "stale") : null,
          ),
          h(
            "button",
            {
              type: "button",
              className: "gs-viz" + (failed ? " gs-err" : ""),
              onClick: openViz,
              disabled: busy,
              title: busy
                ? "Starting graft viz…"
                : failed
                  ? "graft viz: " + viz.reason
                  : "Open the graph",
              "aria-label": "Open the graph visualisation",
            },
            h(GraphIcon),
          ),
        );
      };
    }

    /* ================================================================== *
     * Wiring
     * ================================================================== */
    const inject = ["slots", "remote"];

    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(CONTRIBUTION);
      ctx.effect(() => disposeRemote, "graft-status: remote contribution");

      injectStyles();

      // Breadcrumb, not logging noise. If the chip is invisible this is the
      // only way to tell "the bundle never loaded" from "the slot never
      // rendered" without a second round trip through the user.
      console.info("graft-status: client mounted, registering conversation.input.right");

      // A `list` slot in the composer's trailing div, rendered immediately
      // before `conversation.input.model` — so this sits directly left of the
      // model name without displacing the model seat.
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "graft-status",
            order: 20,
            label: "graft",
            // The slot hands the session id to its `inject`, and that is the
            // only way this seat learns WHICH workspace it is describing. The
            // host resolves the repo from that session's own cwd, so a dsh
            // launched from somewhere else still reports the right project.
            inject: (sessionId) => ({ sessionId }),
          },
          makeSeat(ctx),
        ),
      );

      // Contributed through dsh-better-sidebar's PUBLIC service, not by
      // touching that plugin. `ctx.inject` rather than the module-level
      // `inject` list on purpose: a hard dependency would keep this whole
      // plugin — chip included — from activating in a profile that does not
      // have the sidebar installed. This way the tab appears when the service
      // does, and the button falls back to a browser tab when it never comes.
      // dsh's own right sidebar (0.1.5+). Two registrations: the static type,
      // and the body in the keyed seat under the SAME id. `ctx.inject` rather
      // than the module-level list for the same reason as below — a profile
      // without this sidebar must still get the chip and the button.
      ctx.inject(["sidebarRightTabs", "slots"], (scope) => {
        scope.effect(
          () =>
            scope.sidebarRightTabs.register({
              id: TAB_TYPE,
              kind: VIZ_KIND,
              // A page type, opened by kind: it recognises no resource address,
              // so it declares no patterns. "extension" is the band for a type
              // from outside the product, and the default.
              priority: "extension",
              title: () => "Graft",
              guide: [
                {
                  order: 60,
                  title: () => "Graft",
                  description: () => "The graft graph for this workspace",
                  icon: GraphIcon,
                },
              ],
            }),
          "graft-status: right sidebar tab type",
        );
        scope.effect(
          () =>
            scope.slots.inject("sidebar.right.pane.tab", () =>
              scope.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE }, makeVizTab(ctx)),
            ),
          "graft-status: right sidebar tab body",
        );
      });

      ctx.inject(["betterSidebar"], (scope) => {
        scope.effect(
          () =>
            scope.betterSidebar.registerTab({
              id: TAB_TYPE,
              title: "Graft",
              icon: () => h(GraphIcon),
              order: 60,
              // One graph per repo, so a second open focuses the tab that is
              // already there instead of stacking duplicates on one port.
              single: true,
              component: makeVizTab(ctx),
            }),
          "graft-status: sidebar tab",
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // Exported for the harness; pure, and never read by the host.
    exports.unwrap = unwrap;
    exports.tokens = tokens;
    exports.basename = basename;
    exports.count = count;

    return module.exports;
  },
});
