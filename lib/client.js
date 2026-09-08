/**
 * dsh-autoupdate — client bundle.
 *
 * Adds an "Auto-update" status row to the DSH web UI General settings page:
 * shows the latest sync report (from the host plugin's /dsh-autoupdate/report
 * route) and offers a manual "Check now" trigger (POST /dsh-autoupdate/run).
 * Live data comes from the host half; this file only renders.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the exact
 * shape the client-modules host half serves at `/plugins/dsh-autoupdate/client.js`.
 */
window.__ModuleLoader__.load({
	id: "dsh-autoupdate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---- imports available in the boot seed graph ----
		var jsxRuntime = require("react/jsx-runtime");
		var react = require("react");

		// =====================================================================
		// locale dictionaries
		// =====================================================================
		var NS = "settings.dshAutoupdate";

		var zh = {
			"autoupdate.title": "自动更新（deepseek-harness）",
			"autoupdate.status": "状态",
			"autoupdate.checkedAt": "上次检查",
			"autoupdate.behind": "落后提交",
			"autoupdate.run": "立即检查更新",
			"autoupdate.running": "正在运行同步脚本…",
			"autoupdate.openPage": "打开完整状态页",
			"autoupdate.loadFail": "报告读取失败",
			"autoupdate.runDone": "已完成，退出码",
			"autoupdate.runBusy": "已有一个检查在运行中"
		};
		var en = {
			"autoupdate.title": "Auto-update (deepseek-harness)",
			"autoupdate.status": "Status",
			"autoupdate.checkedAt": "Last check",
			"autoupdate.behind": "Commits behind",
			"autoupdate.run": "Check for updates now",
			"autoupdate.running": "Running the sync script…",
			"autoupdate.openPage": "Open full status page",
			"autoupdate.loadFail": "Failed to read report",
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
		// styles (injected once at activation)
		// =====================================================================
		var cssText =
			".dsh-au-row{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
			".dsh-au-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:400}" +
			".dsh-au-line{display:flex;gap:8px;align-items:baseline;font-size:13px;color:var(--dsw-alias-label-secondary)}" +
			".dsh-au-k{min-width:72px}" +
			".dsh-au-badge{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600}" +
			".dsh-au-badge[data-kind=ok]{background:color-mix(in oklch,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}" +
			".dsh-au-badge[data-kind=warn]{background:color-mix(in oklch,var(--dsw-alias-state-warning-primary) 18%,transparent);color:var(--dsw-alias-state-warning-primary)}" +
			".dsh-au-badge[data-kind=err]{background:color-mix(in oklch,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary)}" +
			".dsh-au-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
			".dsh-au-btn{font:inherit;font-size:13px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}" +
			".dsh-au-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dsh-au-btn:disabled{opacity:.55;cursor:default}" +
			".dsh-au-link{font-size:12px;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline}";
		var tagId = "dsh-autoupdate/row.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='" + tagId + "']") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-autoupdate";
			tag.dataset.pluginCss = tagId;
			tag.textContent = cssText;
			document.head.appendChild(tag);
		}

		// =====================================================================
		// status row component
		// =====================================================================
		function StatusRow(props) {
			var t = props.t;
			var state = react.useState({ phase: "loading" });
			var info = state[0], setInfo = state[1];
			var runningState = react.useState(false);
			var running = runningState[0], setRunning = runningState[1];
			var noteState = react.useState("");
			var note = noteState[0], setNote = noteState[1];

			var refresh = react.useCallback(function () {
				fetch("/dsh-autoupdate/report", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setInfo({ phase: "ready", data: d }); })
					.catch(function (e) { setInfo({ phase: "error", error: (e && e.message) || String(e) }); });
			}, []);
			react.useEffect(function () { refresh(); }, [refresh]);

			function runNow() {
				setRunning(true);
				setNote(t("autoupdate.running"));
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

			var children = [jsxRuntime.jsx("div", { className: "dsh-au-title", children: t("autoupdate.title") }, "title")];

			if (info.phase === "loading") {
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: "…" }, "loading"));
			} else if (info.phase === "error") {
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: t("autoupdate.loadFail") + ": " + info.error }, "err"));
			} else if (info.data && info.data.ok && info.data.report) {
				var p = info.data.report;
				var m = STATUS_ZH[p.status] || [p.status, "warn"];
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
					jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.status") }, "k1"),
					jsxRuntime.jsx("span", { className: "dsh-au-badge", "data-kind": m[1], children: m[0] }, "b1")
				] }, "status"));
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
					jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.checkedAt") }, "k2"),
					p.ts
				] }, "ts"));
				if (typeof p.behind === "number") {
					children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: [
						jsxRuntime.jsx("span", { className: "dsh-au-k", children: t("autoupdate.behind") }, "k3"),
						p.behind
					] }, "behind"));
				}
			} else if (info.data && !info.data.ok) {
				children.push(jsxRuntime.jsx("div", { className: "dsh-au-line", children: t("autoupdate.loadFail") + ": " + info.data.error }, "noreport"));
			}

			children.push(jsxRuntime.jsx("div", { className: "dsh-au-actions", children: [
				jsxRuntime.jsx("button", {
					type: "button",
					className: "dsh-au-btn",
					disabled: running,
					onClick: runNow,
					children: running ? t("autoupdate.running") : t("autoupdate.run")
				}, "btn"),
				jsxRuntime.jsx("span", {
					className: "dsh-au-link",
					onClick: function () { window.open("/dsh-autoupdate", "_blank"); },
					children: t("autoupdate.openPage")
				}, "link"),
				note ? jsxRuntime.jsx("span", { className: "dsh-au-line", children: note }, "note") : null
			] }, "actions"));

			return jsxRuntime.jsx("div", { className: "dsh-au-row", children: children }, "row");
		}

		// =====================================================================
		// plugin entry
		// =====================================================================
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-autoupdate: settings row dictionaries");

			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "dsh-autoupdate",
					order: 99,
					locale: NS
				}, StatusRow);
			});
		}

		var inject = ["slots", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
