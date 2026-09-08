/**
 * dsh-autoupdate v2.0 — client bundle.
 *
 * Unified update center in the DSH web UI General settings page:
 *   Card 1 — Oh-DSH本体 (GitHub Releases channel): version badge
 *            current → latest, changelog timeline (upstream release notes),
 *            one-click web update (staged swap + health check + auto-rollback),
 *            desktop installer download & run.
 *   Card 2 — deepseek-harness git sync (existing channel): status badge,
 *            last check, commits behind, manual trigger.
 *
 * UI ideas borrowed from the community: Z-6354's version capsule,
 * xz1996618's changelog timeline, lc23313's explicit rollback messaging.
 */
window.__ModuleLoader__.load({
	id: "dsh-autoupdate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var jsxRuntime = require("react/jsx-runtime");
		var react = require("react");

		// =====================================================================
		// locale dictionaries
		// =====================================================================
		var NS = "settings.dshAutoupdate";

		var zh = {
			"autoupdate.title": "更新中心",
			// ohdsh card
			"au.ohdsh.title": "Oh-DSH 本体",
			"au.ohdsh.current": "当前版本",
			"au.ohdsh.latest": "最新版本",
			"au.ohdsh.uptodate": "已是最新版本",
			"au.ohdsh.updateAvailable": "有新版本",
			"au.ohdsh.changelog": "更新日志",
			"au.ohdsh.updateWeb": "一键更新（网页版）",
			"au.ohdsh.updating": "正在更新：下载 → 停止服务 → 切换 → 健康检查（失败自动回滚）…",
			"au.ohdsh.getDesktop": "下载桌面版安装包",
			"au.ohdsh.runDesktop": "运行已下载的安装包",
			"au.ohdsh.desktopStaged": "桌面版安装包已就绪",
			"au.ohdsh.releaseUrl": "在 GitHub 查看发布",
			// git card
			"autoupdate.subtitle": "deepseek-harness 仓库同步",
			"autoupdate.status": "状态",
			"autoupdate.checkedAt": "上次检查",
			"autoupdate.behind": "落后提交",
			"autoupdate.run": "立即检查更新",
			"autoupdate.running": "正在运行同步脚本…",
			"autoupdate.loadFail": "读取失败",
			"autoupdate.runDone": "已完成，退出码",
			"autoupdate.runBusy": "已有一个检查在运行中"
		};
		var en = {
			"autoupdate.title": "Update Center",
			"au.ohdsh.title": "Oh-DSH core",
			"au.ohdsh.current": "Current",
			"au.ohdsh.latest": "Latest",
			"au.ohdsh.uptodate": "Up to date",
			"au.ohdsh.updateAvailable": "Update available",
			"au.ohdsh.changelog": "Changelog",
			"au.ohdsh.updateWeb": "Update now (web)",
			"au.ohdsh.updating": "Updating: download → stop → swap → health check (auto-rollback on failure)…",
			"au.ohdsh.getDesktop": "Download desktop installer",
			"au.ohdsh.runDesktop": "Run downloaded installer",
			"au.ohdsh.desktopStaged": "Desktop installer staged",
			"au.ohdsh.releaseUrl": "View release on GitHub",
			"autoupdate.subtitle": "deepseek-harness repo sync",
			"autoupdate.status": "Status",
			"autoupdate.checkedAt": "Last check",
			"autoupdate.behind": "Commits behind",
			"autoupdate.run": "Check for updates now",
			"autoupdate.running": "Running the sync script…",
			"autoupdate.loadFail": "Failed to load",
			"autoupdate.runDone": "Finished, exit code",
			"autoupdate.runBusy": "A check is already running"
		};

		var STATUS_ZH = {
			ok: ["同步成功", "ok"],
			"up-to-date": ["已是最新", "ok"],
			nochange: ["无变更", "ok"],
			"fetch-failed": ["网络失败", "warn"],
			"aborted-overlap": ["安全中止（本地有未提交改动）", "warn"],
			"aborted-conflict": ["冲突中止", "err"],
			"aborted-busy": ["已有同步在运行", "warn"],
			error: ["出错", "err"]
		};

		// =====================================================================
		// styles
		// =====================================================================
		var cssText =
			".dsh-au-row{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
			".dsh-au-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:600}" +
			".dsh-au-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}" +
			".dsh-au-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}" +
			".dsh-au-line{display:flex;gap:8px;align-items:baseline;font-size:13px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}" +
			".dsh-au-k{min-width:72px}" +
			".dsh-au-badge{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600}" +
			".dsh-au-badge[data-kind=ok]{background:color-mix(in oklch,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}" +
			".dsh-au-badge[data-kind=warn]{background:color-mix(in oklch,var(--dsw-alias-state-warning-primary) 18%,transparent);color:var(--dsw-alias-state-warning-primary)}" +
			".dsh-au-badge[data-kind=err]{background:color-mix(in oklch,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary)}" +
			".dsh-au-badge[data-kind=info]{background:color-mix(in oklch,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}" +
			".dsh-au-ver{font-family:ui-monospace,Consolas,monospace;font-size:13px}" +
			".dsh-au-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
			".dsh-au-btn{font:inherit;font-size:13px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}" +
			".dsh-au-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dsh-au-btn:disabled{opacity:.55;cursor:default}" +
			".dsh-au-btn[data-primary=1]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}" +
			".dsh-au-link{font-size:12px;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline}" +
			".dsh-au-note{font-size:12px;color:var(--dsw-alias-label-secondary)}" +
			".dsh-au-timeline{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}" +
			".dsh-au-tl-item{display:flex;gap:8px;font-size:12px;line-height:1.5}" +
			".dsh-au-tl-bullet{color:var(--dsw-alias-state-business-primary);flex-shrink:0}" +
			".dsh-au-tl-text{color:var(--dsw-alias-label-secondary);word-break:break-word}" +
			".dsh-au-log{font-family:ui-monospace,Consolas,monospace;font-size:11px;max-height:140px;overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-all}";
		var tagId = "dsh-autoupdate/center.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='" + tagId + "']") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-autoupdate";
			tag.dataset.pluginCss = tagId;
			tag.textContent = cssText;
			document.head.appendChild(tag);
		}

		// =====================================================================
		// shared bits
		// =====================================================================
		function Badge(props) {
			return jsxRuntime.jsx("span", { className: "dsh-au-badge", "data-kind": props.kind, children: props.text }, props.key);
		}

		/** Parse upstream release notes (markdown bullets) into a timeline. */
		function parseChangelog(body) {
			if (!body) return [];
			return body.split("\n")
				.map(function (l) { return l.trim(); })
				.filter(function (l) { return l.length > 0 && !l.startsWith("#") && !l.startsWith("<"); })
				.map(function (l) { return l.replace(/^[-*]\s*/, "").replace(/\s*in https:\S+$/, ""); })
				.slice(0, 30);
		}

		// =====================================================================
		// card 1: Oh-DSH本体 (GitHub Releases)
		// =====================================================================
		function OhDshCard(props) {
			var t = props.t;
			var s0 = react.useState({ phase: "loading" });
			var info = s0[0], setInfo = s0[1];
			var b0 = react.useState(false);
			var busy = b0[0], setBusy = b0[1];
			var n0 = react.useState(null);
			var note = n0[0], setNote = n0[1];

			var refresh = react.useCallback(function () {
				fetch("/dsh-autoupdate/ohdsh/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setInfo({ phase: "ready", data: d }); })
					.catch(function (e) { setInfo({ phase: "error", error: (e && e.message) || String(e) }); });
			}, []);
			react.useEffect(function () { refresh(); }, [refresh]);

			function updateWeb() {
				if (!window.confirm(t("au.ohdsh.updating"))) return;
				setBusy(true); setNote(t("au.ohdsh.updating"));
				fetch("/dsh-autoupdate/ohdsh/apply", { method: "POST" })
					.then(function (r) { return r.json(); })
					.then(function (d) {
						if (d.started && d.ok && d.noop) setNote(t("au.ohdsh.uptodate"));
						else if (d.started && d.ok) setNote("✓ " + (d.version || "") + "  (backup: " + (d.backup || "") + ")");
						else setNote("✗ " + (d.error || "unknown") + (d.rolledBack ? " → " + t("au.ohdsh.uptodate") + " (rollback)" : ""));
					})
					.catch(function (e) { setNote("✗ " + ((e && e.message) || e)); })
					.finally(function () { setBusy(false); refresh(); });
			}
			function desktopDownload() {
				setBusy(true);
				fetch("/dsh-autoupdate/ohdsh/desktop-download", { method: "POST" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setNote(d.ok ? t("au.ohdsh.desktopStaged") + ": " + d.path : "✗ " + (d.error || "")); })
					.catch(function (e) { setNote("✗ " + ((e && e.message) || e)); })
					.finally(function () { setBusy(false); });
			}
			function desktopRun() {
				fetch("/dsh-autoupdate/ohdsh/desktop-run", { method: "POST" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setNote(d.ok ? "→ " + d.installer : "✗ " + (d.error || "")); })
					.catch(function (e) { setNote("✗ " + ((e && e.message) || e)); });
			}

			var children = [jsxRuntime.jsx("div", { className: "dsh-au-title", children: t("au.ohdsh.title") }, "t")];
			var d = info.data;

			if (info.phase === "loading") children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: "…" }, "l"));
			else if (info.phase === "error") children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: t("autoupdate.loadFail") + ": " + info.error }, "e"));
			else {
				// version capsule: current → latest
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
					jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("au.ohdsh.current") }, "k1"),
					jsxRuntime.jsx("span", { className: "dsh-au-ver", children: d.installedVersion || "?" }, "v1"),
					jsxRuntime.jsx("span", { children: "→" }, "arrow"),
					jsxRuntime.jsx("span", { className: "dsh-au-ver", children: d.version || "?" }, "v2"),
					d.updateAvailable === true
						? jsxRuntime.jsx(Badge, { kind: "info", text: t("au.ohdsh.updateAvailable") }, "b1")
						: (d.updateAvailable === false ? jsxRuntime.jsx(Badge, { kind: "ok", text: t("au.ohdsh.uptodate") }, "b1") : null)
				] }, "vers"));

				// changelog timeline
				var items = parseChangelog(d.releaseNotes);
				if (items.length > 0 && d.updateAvailable === true) {
					children.push(jsxRuntime.jsx("div", { className: "dsh-au-sub", children: t("au.ohdsh.changelog") }, "cl-h"));
					children.push(jsxRuntime.jsx("div", { className: "dsh-au-timeline", children: items.map(function (line, i) {
						return jsxRuntime.jsx("div", { className: "dsh-au-tl-item", children: [
							jsxRuntime.jsx("span", { className: "dsh-au-tl-bullet", children: "•" }, "b" + i),
							jsxRuntime.jsx("span", { className: "dsh-au-tl-text", children: line }, "x" + i)
						] }, "tl" + i);
					}) }, "tl"));
				}

				children.push(jsxRuntime.jsx("div", { className: "dsh-au-actions", children: [
					d.updateAvailable === true
						? jsxRuntime.jsx("button", { className: "dsh-au-btn", "data-primary": "1", disabled: busy, onClick: updateWeb, children: t("au.ohdsh.updateWeb") }, "u")
						: null,
					jsxRuntime.jsx("button", { className: "dsh-au-btn", disabled: busy, onClick: desktopDownload, children: t("au.ohdsh.getDesktop") }, "dd"),
					jsxRuntime.jsx("button", { className: "dsh-au-btn", disabled: busy, onClick: desktopRun, children: t("au.ohdsh.runDesktop") }, "dr"),
					jsxRuntime.jsx("span", { className: "dsh-au-link", onClick: function () { window.open(d.releaseUrl || ("https://github.com/" + d.repo + "/releases"), "_blank"); }, children: t("au.ohdsh.releaseUrl") }, "gh")
				] }, "acts"));
			}
			if (note) children.push(jsxRuntime.jsx("div", { className: "dsh-au-note", children: note }, "note"));

			return jsxRuntime.jsx("div", { className: "dsh-au-card", children: children }, "card1");
		}

		// =====================================================================
		// card 2: harness git sync (existing)
		// =====================================================================
		function GitSyncCard(props) {
			var t = props.t;
			var s0 = react.useState({ phase: "loading" });
			var info = s0[0], setInfo = s0[1];
			var r0 = react.useState(false);
			var running = r0[0], setRunning = r0[1];
			var n0 = react.useState("");
			var note = n0[0], setNote = n0[1];

			var refresh = react.useCallback(function () {
				fetch("/dsh-autoupdate/report", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setInfo({ phase: "ready", data: d }); })
					.catch(function (e) { setInfo({ phase: "error", error: (e && e.message) || String(e) }); });
			}, []);
			react.useEffect(function () { refresh(); }, [refresh]);

			function runNow() {
				setRunning(true); setNote(t("autoupdate.running"));
				fetch("/dsh-autoupdate/run", { method: "POST" })
					.then(function (r) { return r.json(); })
					.then(function (d) {
						if (!d.started) setNote(t("autoupdate.runBusy"));
						else if (d.timedOut) setNote(t("autoupdate.runDone") + " timeout");
						else setNote(t("autoupdate.runDone") + " " + d.exitCode);
					})
					.catch(function (e) { setNote(t("autoupdate.loadFail") + ": " + ((e && e.message) || e)); })
					.finally(function () { setRunning(false); refresh(); });
			}

			var children = [jsxRuntime.jsx("div", { className: "dsh-au-title", children: t("autoupdate.subtitle") }, "t")];
			if (info.phase === "loading") children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: "…" }, "l"));
			else if (info.phase === "error") children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: t("autoupdate.loadFail") + ": " + info.error }, "e"));
			else if (info.data && info.data.ok && info.data.report) {
				var p = info.data.report;
				var m = STATUS_ZH[p.status] || [p.status, "warn"];
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
					jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.status") }, "k1"),
					jsxRuntime.jsx(Badge, { kind: m[1], text: m[0] }, "b1")
				] }, "st"));
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
					jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.checkedAt") }, "k2"), p.ts
				] }, "ts"));
				if (typeof p.behind === "number") {
					children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
						jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.behind") }, "k3"), p.behind
					] }, "be"));
				}
			} else if (info.data && !info.data.ok) {
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: t("autoupdate.loadFail") + ": " + info.data.error }, "nr"));
			}
			children.push(jsxRuntime.jsx("div", { className: "dsh-au-actions", children: [
				jsxRuntime.jsx("button", { type: "button", className: "dsh-au-btn", disabled: running, onClick: runNow, children: running ? t("autoupdate.running") : t("autoupdate.run") }, "btn"),
				jsxRuntime.jsx("span", { className: "dsh-au-link", onClick: function () { window.open("/dsh-autoupdate", "_blank"); }, children: "↗" }, "link")
			] }, "acts"));
			if (note) children.push(jsxRuntime.jsx("div", { className: "dsh-au-note", children: note }, "note"));
			return jsxRuntime.jsx("div", { className: "dsh-au-card", children: children }, "card2");
		}

		// =====================================================================
		// plugin entry
		// =====================================================================
		function UpdateCenter(props) {
			var t = props.t;
			return jsxRuntime.jsx("div", { className: "dsh-au-row", children: [
				jsxRuntime.jsx("div", { className: "dsh-au-title", children: t("autoupdate.title") }, "h"),
				jsxRuntime.jsx(OhDshCard, { t: t }, "c1"),
				jsxRuntime.jsx(GitSyncCard, { t: t }, "c2")
			] }, "center");
		}

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-autoupdate: update center dictionaries");

			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "dsh-autoupdate",
					order: 99,
					locale: NS
				}, UpdateCenter);
			});
		}

		var inject = ["slots", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
