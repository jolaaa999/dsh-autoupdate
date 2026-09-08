/**
 * dsh-autoupdate — Host side.
 *
 * Companion shell for the standalone auto-update tool that lives next to a
 * deepseek-harness clone (.git/dsh-autoupdate/sync-dsh.ps1 + an optional
 * Windows scheduled task). This plugin never syncs anything by itself: it only
 *   - serves the latest machine-readable report  (GET  /dsh-autoupdate/report)
 *   - offers a manual trigger that runs the tool (POST /dsh-autoupdate/run)
 *   - serves a self-contained status page        (GET  /dsh-autoupdate)
 *
 * The tool is safe by construction (it owns its own lock and never touches the
 * working tree on failure), so calling it from here cannot corrupt the repo.
 * Every failure path degrades gracefully — a missing or corrupt report must
 * never break DSH startup.
 *
 * Repository location: the DSH_AUTOUPDATE_REPO environment variable wins,
 * otherwise the default is ./deepseek-harness next to the user's home
 * directory (documented in README; adjust to your checkout location).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ohDshStatus, applyOhDshUpdate, downloadDesktopInstaller, runDesktopInstaller } from "./ohdsh-update.js";

/** Harness checkout the tool syncs (override with DSH_AUTOUPDATE_REPO). */
const REPO_PATH = process.env.DSH_AUTOUPDATE_REPO || join(homedir(), "deepseek-harness");
/** Where the sync tool writes its latest machine-readable report. */
const REPORT_PATH = join(REPO_PATH, ".git", "dsh-autoupdate", "last-report.json");
/** The safe-mode sync script owned by the scheduled task. */
const SYNC_SCRIPT = join(REPO_PATH, ".git", "dsh-autoupdate", "sync-dsh.ps1");
/** Hard ceiling for one manual run; the tool's own lock protects against overlap. */
const RUN_TIMEOUT_MS = 10 * 60_000;

export const name = "dsh-autoupdate";

/** In-process mutex so POST /run cannot pile up concurrent runs. */
let runPromise = null;

/** Read + parse the tool's report; degrade gracefully when absent/corrupt. */
async function readReport() {
	try {
		const [raw, st] = await Promise.all([
			readFile(REPORT_PATH, "utf8"),
			stat(REPORT_PATH),
		]);
		return {
			ok: true,
			repo: REPO_PATH,
			report: JSON.parse(raw),
			reportMtime: st.mtime.toISOString(),
		};
	} catch (error) {
		return { ok: false, repo: REPO_PATH, error: error?.message ?? String(error) };
	}
}

/**
 * Run the sync tool once. Returns when the process exits (or the timeout
 * kills it); the response embeds the fresh report so the caller needs no
 * second round trip.
 */
function triggerRun() {
	if (runPromise !== null) {
		return Promise.resolve({ started: false, reason: "a run is already in progress; wait for it to finish" });
	}
	runPromise = new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File", SYNC_SCRIPT,
			"-RepoPath", REPO_PATH,
		], { windowsHide: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill(); } catch { /* already gone */ }
		}, RUN_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ started: true, ok: false, error: error?.message ?? String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ started: true, ok: !timedOut, timedOut, exitCode: code });
		});
	});
	const settled = runPromise.then(async (result) => {
		runPromise = null;
		return { ...result, ...(await readReport()) };
	});
	// callers get the settled shape; keep runPromise as the raw gate
	return settled;
}

function send(res, status, type, body) {
	res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
	res.end(body);
}

function json(res, payload, status = 200) {
	send(res, status, "application/json", JSON.stringify(payload));
}

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Auto-update status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #f6f7f8; color: #1f2328; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #656d76; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .row { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 14px; }
  .k { min-width: 96px; color: #656d76; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .b-ok { background: #dafbe1; color: #116329; }
  .b-warn { background: #fff8c5; color: #7d4e00; }
  .b-err { background: #ffebe9; color: #a40e26; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #d0d7de; background: #f6f7f8; cursor: pointer; }
  button:hover { background: #eef0f2; }
  button:disabled { opacity: .55; cursor: default; }
  code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  pre { background: #f6f7f8; border: 1px solid #d0d7de; border-radius: 8px; padding: 10px; white-space: pre-wrap; word-break: break-all; }
  ul { margin: 6px 0 0; padding-left: 20px; font-size: 13px; }
  .msg { font-size: 13px; margin-top: 8px; color: #656d76; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border-color: #30363d; }
    .sub, .k, .msg { color: #8b949e; }
    button { background: #21262d; border-color: #30363d; color: #e6edf3; }
    button:hover { background: #30363d; }
    pre { background: #0d1117; border-color: #30363d; }
  }
</style>
</head>
<body>
<main>
  <h1>DeepSeek Harness auto-update</h1>
  <div class="sub" id="repo">Report: &lt;repo&gt;/.git/dsh-autoupdate/last-report.json</div>
  <div class="card" id="status">Loading…</div>
  <div class="card">
    <button id="run">Check for updates now</button>
    <span class="msg" id="runmsg"></span>
  </div>
  <div class="card" id="detail" hidden></div>
</main>
<script>
const ST = { ok: ["synced", "b-ok"], "up-to-date": ["up to date", "b-ok"], nochange: ["no change", "b-ok"],
  "fetch-failed": ["network failed", "b-warn"], "aborted-overlap": ["aborted (local changes overlap)", "b-warn"],
  "aborted-conflict": ["conflict aborted", "b-err"], error: ["error", "b-err"] };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
async function load() {
  const el = document.getElementById("status");
  try {
    const r = await fetch("/dsh-autoupdate/report", { cache: "no-store" });
    const d = await r.json();
    if (d.repo) document.getElementById("repo").textContent = "Repo: " + d.repo;
    if (!d.ok) { el.innerHTML = "<b>Report unavailable</b><div class='msg'>" + esc(d.error) + "</div>"; return; }
    const p = d.report, m = ST[p.status] || [p.status, "b-warn"];
    let rows = "<div class='row'><span class='k'>Status</span><span class='badge " + m[1] + "'>" + esc(m[0]) + "</span></div>";
    rows += "<div class='row'><span class='k'>Checked at</span>" + esc(p.ts) + "</div>";
    rows += "<div class='row'><span class='k'>Report written</span>" + esc(d.reportMtime) + "</div>";
    rows += "<div class='row'><span class='k'>Branch</span>" + esc(p.branch) + " → " + esc(p.upstream) + " (behind " + esc(p.behind) + " commits)</div>";
    rows += "<div class='row'><span class='k'>Exit code</span>" + esc(p.exitCode) + " (0 ok / 2 error / 3 aborted)</div>";
    el.innerHTML = rows;
    const det = document.getElementById("detail");
    let h = "<b>Details</b>";
    if (p.changedCount > 0 || (p.changed && p.changed.length)) h += "<ul>" + (p.changed || []).map(c => "<li>" + esc(c) + "</li>").join("") + "</ul>";
    if (p.blockedBy && p.blockedBy.length) h += "<div class='msg'>Blocked by local changes to:</div><ul>" + p.blockedBy.map(c => "<li><code>" + esc(c) + "</code></li>").join("") + "</ul>";
    if (p.detail) h += "<pre>" + esc(p.detail) + "</pre>";
    det.innerHTML = h;
    det.hidden = !(p.detail || (p.changed && p.changed.length) || (p.blockedBy && p.blockedBy.length));
  } catch (e) { el.innerHTML = "<b>Cannot read report</b><div class='msg'>" + esc(e.message || e) + "</div>"; }
}
document.getElementById("run").addEventListener("click", async () => {
  const b = document.getElementById("run"), m = document.getElementById("runmsg");
  b.disabled = true; m.textContent = "Running the sync script (this can take a few minutes)…";
  try {
    const r = await fetch("/dsh-autoupdate/run", { method: "POST" });
    const d = await r.json();
    if (!d.started) { m.textContent = d.reason || "not started"; }
    else if (d.timedOut) { m.textContent = "timed out and was killed"; }
    else { m.textContent = "finished, exit code " + d.exitCode; }
  } catch (e) { m.textContent = "request failed: " + (e.message || e); }
  b.disabled = false;
  load();
});
load();
setInterval(load, 60000);
</script>
</body>
</html>
`;

/** Prefix-route dispatcher for everything under /dsh-autoupdate. */
async function handle(req, res) {
	const path = new URL(req.url ?? "/", "http://localhost").pathname;
	if ((req.method === "GET" || req.method === "HEAD") && (path === "/dsh-autoupdate" || path === "/dsh-autoupdate/")) {
		send(res, 200, "text/html", PAGE_HTML);
		return;
	}
	if ((req.method === "GET" || req.method === "HEAD") && path === "/dsh-autoupdate/report") {
		json(res, await readReport());
		return;
	}
	if (req.method === "POST" && path === "/dsh-autoupdate/run") {
		json(res, await triggerRun());
		return;
	}
	// ── Oh-DSH本体 update channel (v2.0) ──
	if ((req.method === "GET" || req.method === "HEAD") && path === "/dsh-autoupdate/ohdsh/status") {
		json(res, await ohDshStatus().catch((e) => ({ ok: false, error: e?.message ?? String(e) })));
		return;
	}
	if (req.method === "POST" && path === "/dsh-autoupdate/ohdsh/apply") {
		let body = {};
		try {
			const chunks = [];
			for await (const ch of req) chunks.push(ch);
			if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		} catch { /* empty or invalid body = plain trigger */ }
		json(res, await applyOhDshUpdate(body.confirmDelete === true));
		return;
	}
	if ((req.method === "GET" || req.method === "HEAD") && path === "/dsh-autoupdate/ohdsh/config") {
		try {
			const { readConfig } = await import("./ohdsh-update.js");
			json(res, { ok: true, ...(await readConfig()) });
		} catch (e) { json(res, { ok: false, error: e?.message ?? String(e) }); }
		return;
	}
	if (req.method === "POST" && path === "/dsh-autoupdate/ohdsh/config") {
		try {
			const chunks = [];
			for await (const ch of req) chunks.push(ch);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const { writeConfig } = await import("./ohdsh-update.js");
			await writeConfig(body);
			json(res, { ok: true });
		} catch (e) { json(res, { ok: false, error: e?.message ?? String(e) }); }
		return;
	}
	if (req.method === "POST" && path === "/dsh-autoupdate/ohdsh/desktop-download") {
		json(res, await downloadDesktopInstaller().catch((e) => ({ ok: false, error: e?.message ?? String(e) })));
		return;
	}
	if (req.method === "POST" && path === "/dsh-autoupdate/ohdsh/desktop-run") {
		json(res, await runDesktopInstaller().catch((e) => ({ ok: false, error: e?.message ?? String(e) })));
		return;
	}
	send(res, 404, "text/plain", "not found");
}

/**
 * Register the routes once the host web server is composed.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "prefix",
			path: "/dsh-autoupdate",
			handler: (req, res) => handle(req, res),
		}), "dsh-autoupdate: status routes");
	});
}
