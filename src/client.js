window.__ModuleLoader__.load({
  id: "graft-status",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

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
    const CODEC = { mode: "strict", typeSymbol: "graft-status/json", schema: { parse: identity } };
    const descriptor = (method, names) => ({
      id: "graft-status#graftStatus/" + method,
      service: "graftStatus",
      namespace: "graftStatus",
      method,
      invocation: { kind: "direct" },
      parameters: names.map((name) => ({ name, wire: name, source: "json", codec: CODEC })),
      result: { mode: "strict", typeSymbol: "graft-status/json", schema: { parse: identity } },
      sourceLocation: { file: "graft-status/client.js", line: 1, column: 1 },
    });
    const CONTRIBUTION = {
      package: "graft-status",
      descriptors: [descriptor("status", ["sessionId"]), descriptor("viz", ["sessionId"])],
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
        "border-radius:13px;border:1px solid var(--dsh-border,rgba(128,128,128,.28));",
        "background:var(--dsh-surface-2,rgba(128,128,128,.08));color:var(--dsh-text-2,inherit);",
        "font-size:12px;line-height:1;white-space:nowrap;cursor:default;max-width:200px}",
        ".gs-chip .gs-name{font-weight:600;overflow:hidden;text-overflow:ellipsis}",
        ".gs-chip .gs-sep{opacity:.45}",
        ".gs-chip .gs-dot{font-size:9px;line-height:1}",
        ".gs-ok .gs-dot{color:#3fa45b}",
        ".gs-warn .gs-dot{color:#d08442}",
        ".gs-busy .gs-dot{color:#4b8bd6;display:inline-block;animation:gs-spin 900ms linear infinite}",
        "@keyframes gs-spin{to{transform:rotate(360deg)}}",
        /* A rebuild takes about a second, so the chip also breathes: the dot
           alone is small enough to miss at a glance. */
        ".gs-chip.gs-busy{animation:gs-breathe 1.4s ease-in-out infinite}",
        "@keyframes gs-breathe{0%,100%{opacity:1}50%{opacity:.62}}",
        "@media (prefers-reduced-motion:reduce){.gs-busy .gs-dot{animation:none}.gs-chip.gs-busy{animation:none}}",
        ".gs-idle .gs-dot{color:var(--dsh-text-3,#888)}",
        ".gs-chip.gs-muted{opacity:.6}",
        ".gs-chip.gs-clickable{cursor:pointer}",
        ".gs-chip.gs-clickable:hover{border-color:var(--dsh-border-strong,rgba(128,128,128,.5))}",
        ".gs-chip.gs-clickable:focus-visible{outline:2px solid var(--dsh-accent,#4b8bd6);outline-offset:2px}",
        ".gs-viz{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
        "padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsh-text-2,inherit);",
        "cursor:pointer;--accent:var(--dsh-accent,#e5484d)}",
        ".gs-viz:hover{background:var(--dsh-surface-2,rgba(128,128,128,.14))}",
        ".gs-viz:disabled{opacity:.5;cursor:progress}",
        ".gs-viz.gs-err{color:var(--dsh-danger,#e5484d)}",
        /* The tab: a header row in the sidebar's own idiom (short row, hairline
           rule, icon control on the right), then the visualiser filling the rest. */
        ".gs-tabwrap{display:flex;flex-direction:column;height:100%;min-height:0}",
        ".gs-tabbar{display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;min-height:32px;",
        "border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.22));font-size:11.5px;",
        "white-space:nowrap;overflow:hidden;flex:0 0 auto}",
        ".gs-tb-brand{color:var(--dsh-accent,#e5484d);font-weight:700}",
        ".gs-tb-sep{opacity:.38}",
        ".gs-tb-dim{opacity:.72;overflow:hidden;text-overflow:ellipsis}",
        ".gs-tb-fresh{font-weight:600}",
        ".gs-tb-fresh.gs-ok{color:#5cbe78}",
        ".gs-tb-fresh.gs-warn{color:#e0a066}",
        ".gs-tb-fresh.gs-busy{color:#79aee8}",
        ".gs-tb-fresh.gs-idle{color:var(--dsh-text-3,#9a9a9a)}",
        ".gs-tb-saved{color:#79aee8}",
        ".gs-refresh{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;",
        "width:24px;height:24px;flex:0 0 auto;padding:0;border:0;border-radius:6px;background:transparent;",
        "color:var(--dsh-text-2,inherit);cursor:pointer;opacity:.75}",
        ".gs-refresh:hover{background:var(--dsh-surface-2,rgba(128,128,128,.16));opacity:1}",
        ".gs-refresh.gs-spinning svg{animation:gs-spin 600ms linear}",
        ".gs-tabframe{width:100%;flex:1 1 auto;min-height:0;border:0;background:#fff;display:block}",
        ".gs-tabmsg{padding:14px;font-size:12px;line-height:1.6;opacity:.85}",
        ".gs-tabreason{margin-top:6px;opacity:.7;font-family:ui-monospace,monospace;font-size:11px;word-break:break-word}",
        /* The hover card. Anchored to the wrap, which is why the wrap is
           positioned; `pointer-events:none` so it can never swallow a click
           meant for the button underneath it. */
        ".gs-wrap{position:relative}",
        ".gs-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:80;width:296px;",
        "padding:12px 13px;border-radius:12px;pointer-events:none;text-align:left;",
        "border:1px solid var(--dsh-border,rgba(128,128,128,.3));",
        "background:var(--dsh-surface,#1b1b1e);color:var(--dsh-text,inherit);",
        "box-shadow:0 10px 30px rgba(0,0,0,.34);font-size:12px;line-height:1.5;",
        "opacity:0;transform:translateY(4px);animation:gs-pop-in .13s ease-out forwards}",
        "@keyframes gs-pop-in{to{opacity:1;transform:none}}",
        ".gs-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}",
        ".gs-pop-head .gs-pop-title{font-weight:700;letter-spacing:.02em}",
        ".gs-pill{margin-left:auto;font-size:9.5px;font-weight:700;text-transform:uppercase;",
        "letter-spacing:.07em;padding:3px 8px;border-radius:999px;white-space:nowrap}",
        ".gs-pill.gs-p-ok{background:rgba(63,164,91,.18);color:#5cbe78}",
        ".gs-pill.gs-p-warn{background:rgba(208,132,66,.2);color:#e0a066}",
        ".gs-pill.gs-p-busy{background:rgba(75,139,214,.2);color:#79aee8}",
        ".gs-pill.gs-p-idle{background:rgba(128,128,128,.2);color:var(--dsh-text-3,#9a9a9a)}",
        ".gs-pop-repo{font-weight:600;font-size:12.5px;margin-bottom:2px}",
        ".gs-pop-path{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;",
        "opacity:.58;word-break:break-all}",
        ".gs-pop-stats{display:flex;gap:18px;margin:11px 0 0;padding:10px 0 2px;",
        "border-top:1px solid var(--dsh-border,rgba(128,128,128,.2))}",
        ".gs-stat b{display:block;font-size:15px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}",
        ".gs-stat i{display:block;font-style:normal;font-size:9.5px;text-transform:uppercase;",
        "letter-spacing:.07em;opacity:.55;margin-top:1px}",
        ".gs-pop-note{margin-top:10px;padding-top:9px;font-size:11px;opacity:.68;",
        "border-top:1px solid var(--dsh-border,rgba(128,128,128,.2))}",
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
      const { status } = props;
      if (status === null || status === undefined) {
        return h(
          "div",
          { className: "gs-pop", role: "tooltip" },
          h("div", { className: "gs-pop-head" }, h("span", { className: "gs-pop-title" }, "graft")),
          h("div", { className: "gs-pop-note" }, "Checking this workspace…"),
        );
      }

      if (status.ok !== true) {
        return h(
          "div",
          { className: "gs-pop", role: "tooltip" },
          h(
            "div",
            { className: "gs-pop-head" },
            h("span", { className: "gs-pop-title" }, "graft"),
            h("span", { className: "gs-pill gs-p-idle" }, "no graph"),
          ),
          h("div", null, "No graft index for this workspace."),
          h("div", { className: "gs-pop-reason" }, String(status.reason ?? "unknown reason")),
          h("div", { className: "gs-pop-note" }, "Run `graft build` in it once — no API key needed."),
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
          h("span", { className: "gs-pill " + pill.className }, pill.label),
        ),
        h("div", { className: "gs-pop-repo" }, basename(status.root)),
        h("div", { className: "gs-pop-path" }, status.root),
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
      return [
        "<!doctype html><meta charset=utf-8>",
        "<title>graft viz — ", repo, "</title>",
        "<style>body{margin:0;display:grid;place-items:center;height:100vh;",
        "font:14px system-ui,sans-serif;background:#161616;color:#ddd}</style>",
        "<div>Starting <b>graft viz</b> for ", repo, "…</div>",
      ].join("");
    }

    /** The tab type contributed to dsh-better-sidebar. */
    const TAB_TYPE = "graft-status:viz";

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
        const visible = props?.visible !== false;
        // The sidebar's own scope. Its `sessionId` is what tells the host WHICH
        // workspace to resolve — the same session whose cwd the sidebar shows.
        const sessionId = props?.scope?.sessionId;

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
              )
            : h("span", { className: "gs-tb-dim" }, status === null ? "…" : "no graph"),
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
            // as "outside" and closed twice.
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
                if (live) setStatus(unwrap(answer));
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
          // to watch and the slow interval is right again.
          const timer = window.setInterval(pull, settled ? 15000 : 2000);
          return () => {
            live = false;
            window.clearInterval(timer);
          };
          // `settled` is a dependency, not just a value read inside: without it
          // the interval would keep whatever cadence it had at mount — 2s, from
          // the initial unknown state — and never slow down again.
        }, [sessionId, settled]);

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

          // Fallback for a profile with no dsh-better-sidebar: a browser tab.

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
          card ? h(StatusCard, { status }) : null,
          h(
            "div",
            {
              className: "gs-chip gs-clickable " + tone + (ok ? "" : " gs-muted"),
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
            h("span", null, label),
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
