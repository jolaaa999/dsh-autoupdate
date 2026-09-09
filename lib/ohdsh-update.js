/**
 * dsh-autoupdate v2.1 鈥?Oh-DSH鏈綋 update channel (GitHub Releases).
 *
 * Dual-surface: web (oh-dsh-web-<ver>-win-x64.zip, side-by-side dir swap)
 * and desktop (Oh-DSH-Desktop-<ver>-x64.exe, staged installer + one-click run).
 *
 * Web update strategy 鈥?"staging + atomic swap + health check":
 *   1. fetch latest release info from GitHub API (no download yet)
 *   2. download the zip to <base>\staging\, verify size
 *   3. stop DSH processes, POLl the port until actually free (lesson from
 *      the first live run: a stale process holding 3080 fails every boot)
 *   4. move current install to a fixed backup dir, extract staging zip
 *      (System32 tar.exe 鈥?Git-Bash tar misreads "E:" as a hostname)
 *   5. boot new version, health-check the local web port
 *   6. on boot failure caused by third-party plugins: disable them
 *      (remove bundle entry + node_modules junction, record for restore)
 *      and retry 鈥?up to 3 rounds. If disabling was not enough:
 *        - autoDeleteIncompatible config (local owner machine): delete the
 *          plugin files and retry once more
 *        - otherwise: roll everything back and return needsConfirmation
 *          listing the plugins; the client panel asks the user before a
 *          confirming re-run deletes them
 *   7. failure at any point after the swap 鈫?restore backup automatically
 *
 * The plugin never touches the data dir (userdata) 鈥?programs and data are
 * physically separate by design.
 */
import { readFile, writeFile, stat, rename, rm, mkdir, readdir, readFile as rf } from "node:fs/promises";
import { readFileSync as rfSync } from "node:fs";
import { rmdirSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const OHDSH_REPO = process.env.DSH_OHDSH_REPO || "hust-open-atom-club/oh-dsh";
/** Program base dir; contains oh-dsh-web-*-win-x64 + staging. */
const OHDSH_BASE = process.env.DSH_OHDSH_BASE || "E:\\Oh-DSH";
const STAGING_DIR = process.env.DSH_OHDSH_STAGING || join(OHDSH_BASE, "staging");
const BACKUP_DIR = join(OHDSH_BASE, "oh-dsh-web-backup");
const HEALTH_URL = process.env.DSH_OHDSH_HEALTH_URL || "http://127.0.0.1:3080/";
const HEALTH_PORT = Number(new URL(HEALTH_URL).port) || 3080;
const DSH_HOME = process.env.DSH_AUTOUPDATE_DSH_HOME || join(homedir(), ".dsh");
const PROFILE_MANIFEST = join(DSH_HOME, "profiles", "web", "package.json");
const PROFILE_WEB_NM = join(DSH_HOME, "profiles", "web", "node_modules");
const PLUGINS_ROOT = join(DSH_HOME, "plugins");
const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "config.json");
const TARBALL_EXE = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const HEALTH_CHECK_MS = 90_000;
const PORT_FREE_TIMEOUT_MS = 40_000;

/** Plugins that must never be disabled/deleted: the platform itself + this plugin. */
const PROTECTED_PREFIXES = ["@deepseek-ai/", "@oh-dsh/"];
const PROTECTED_NAMES = new Set(["dsh-autoupdate"]);

const OHDSH_WEB_DIR_RE = /^oh-dsh-web-(.+)-win-x64$/;
const OHDSH_WEB_ASSET_RE = /^oh-dsh-web-([\d.]+)-win-x64\.zip$/;
const OHDSH_DESKTOP_ASSET_RE = /^Oh-DSH-Desktop-([\d.]+)-x64\.exe$/;

export const name = "dsh-autoupdate";

// 鈹€鈹€ small helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function compareVersions(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function isProtected(pkg) {
	return PROTECTED_PREFIXES.some((p) => pkg.startsWith(p)) || PROTECTED_NAMES.has(pkg);
}

async function readLocalConfig() {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

/** Public config accessors (persisted next to the plugin, plain JSON). */
export async function readConfig() {
	return readLocalConfig();
}

export async function writeConfig(patch) {
	const cur = await readLocalConfig();
	const next = { ...cur, ...patch };
	await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
	return next;
}

/** Resolve the current install dir: highest-versioned oh-dsh-web-*-win-x64 under base. */
async function resolveInstallDir() {
	const entries = await readdir(OHDSH_BASE).catch(() => []);
	const candidates = [];
	for (const name of entries) {
		const m = OHDSH_WEB_DIR_RE.exec(name);
		if (m) {
			// only accept pure numeric versions 鈥?skip leftover/experimental dirs
			// whose version suffix doesn't parse (NaN would poison the sort)
			if (!/^\d+(\.\d+)*$/.test(m[1])) continue;
			const hasManifest = await stat(join(OHDSH_BASE, name, "package.json")).then(() => true, () => false);
			if (hasManifest) candidates.push({ name, version: m[1] });
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => compareVersions(b.version, a.version));
	return { dir: join(OHDSH_BASE, candidates[0].name), name: candidates[0].name, version: candidates[0].version };
}

// 鈹€鈹€ status 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function fetchLatestRelease() {
	const res = await fetch(`https://api.github.com/repos/${OHDSH_REPO}/releases/latest`, {
		headers: { "accept": "application/vnd.github+json", "user-agent": "dsh-autoupdate" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status}`);
	const body = await res.json();
	const assets = (body.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
	return {
		ok: true,
		tag: body.tag_name,
		version: String(body.tag_name || "").replace(/^v/, ""),
		publishedAt: body.published_at,
		releaseNotes: body.body ?? "",
		releaseUrl: body.html_url,
		webAsset: assets.find((a) => OHDSH_WEB_ASSET_RE.test(a.name)) ?? null,
		desktopAsset: assets.find((a) => OHDSH_DESKTOP_ASSET_RE.test(a.name)) ?? null,
	};
}

export async function ohDshStatus() {
	const install = await resolveInstallDir();
	const out = { ok: true, repo: OHDSH_REPO, installDir: install?.dir ?? null };
	out.installedVersion = install?.version ?? null;
	try {
		Object.assign(out, await fetchLatestRelease());
		if (out.installedVersion && out.version) out.updateAvailable = compareVersions(out.version, out.installedVersion) > 0;
	} catch (error) {
		out.releaseError = error?.message ?? String(error);
	}
	return out;
}

// 鈹€鈹€ download 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function downloadTo(url, destPath) {
	await mkdir(dirname(destPath), { recursive: true });
	const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
	await pipeline(res.body, createWriteStream(destPath));
	const st = await stat(destPath);
	if (st.size < 1_000_000) throw new Error(`downloaded file too small (${st.size} bytes)`);
	return { size: st.size };
}

// 鈹€鈹€ process control (with real port-free verification) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function killDshNodeProcesses(installDir) {
	return new Promise((resolve) => {
		// WQL LIKE avoids nested-quote hell: backslashes are literal in WQL,
		// single quotes survive the execFile argv pass intact.
		const like = installDir.replace(/'/g, "''");
		const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND CommandLine LIKE '%${like}%'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
		execFile("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 30_000, windowsHide: true }, () => resolve());
	});
}

/** Last-resort: kill whatever process is LISTENING on the health port. */
function killPortListener(port) {
	return new Promise((resolve) => {
		const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
		execFile("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 30_000, windowsHide: true }, () => resolve());
	});
}

function isPortListening(port) {
	return new Promise((resolve) => {
		execFile("powershell.exe", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) -ne $null`], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
			resolve(!err && String(stdout).trim() === "True");
		});
	});
}

/** Stop DSH, then poll until the port is REALLY free. Returns true when free. */
async function stopAndWaitPortFree(installDir) {
	for (let round = 0; round < 3; round++) {
		await killDshNodeProcesses(installDir);
		// safety net: also kill whatever is actually holding the port 鈥?		// the DSH web listener is by definition the thing we must stop
		await killPortListener(HEALTH_PORT);
		const deadline = Date.now() + PORT_FREE_TIMEOUT_MS / 3;
		while (Date.now() < deadline) {
			if (!(await isPortListening(HEALTH_PORT))) return true;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	return !(await isPortListening(HEALTH_PORT));
}

function startDsh(launcherCmd) {
	return new Promise((resolve) => {
		const child = spawn("cmd.exe", ["/c", "start", "\"Oh-DSH - DSH Host\"", "/min", launcherCmd], {
			detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
		});
		child.on("error", () => resolve(false));
		child.unref();
		setTimeout(() => resolve(true), 1500);
	});
}

async function healthCheck(timeoutMs = HEALTH_CHECK_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
			// 401 counts as healthy: 0.1.12+ serves a token-auth challenge on the
			// web port, which still proves the HTTP server is up and responding.
			if (res.ok || res.status === 401 || res.status === 403) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

/** Boot via launcher with output captured; resolve {ok, log}. */
async function bootAndCheck(launcherCmd, logPath) {
	await new Promise((resolve) => {
		const ps = `& '${launcherCmd.replace(/'/g, "''")}' *> '${logPath.replace(/'/g, "''")}'`;
		const child = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
	const ok = await healthCheck(HEALTH_CHECK_MS);
	const log = await readFile(logPath, "utf8").catch(() => "");
	return { ok, log };
}

// 鈹€鈹€ third-party plugin disable / delete / restore 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function failingPluginsFromLog(log) {
	const pkgs = new Set();
	const re = /failed to (?:apply|import) loader entry ([\w.@/-]+) \(([^)]+)\)/g;
	let m;
	while ((m = re.exec(log)) !== null) {
		const pkg = m[2];
		// skip the include mechanism itself and platform packages
		if (pkg === "cordis:include") continue;
		if (!pkg.includes("/") || isProtected(pkg)) continue;
		pkgs.add(pkg);
	}
	return [...pkgs];
}

async function readManifest() {
	return JSON.parse(await readFile(PROFILE_MANIFEST, "utf8"));
}

async function writeManifest(obj) {
	await writeFile(PROFILE_MANIFEST, JSON.stringify(obj, null, 2), "utf8"); // utf8, never a BOM
}

/** Disable = remove bundle entry + dependency + node_modules junction. Records for restore. */
async function disablePlugin(pkg, record) {
	const manifest = await readManifest();
	manifest.dependencies = manifest.dependencies ?? {};
	manifest.dsh = manifest.dsh ?? {};
	manifest.dsh.profile = manifest.dsh.profile ?? {};
	const hadBundle = Array.isArray(manifest.dsh.profile.bundles) && manifest.dsh.profile.bundles.includes(pkg);
	const depValue = manifest.dependencies[pkg];
	const linkPath = join(PROFILE_WEB_NM, pkg);
	let linkTarget = null;
	let hadLink = false;
	try {
		const st = await stat(linkPath); // throws when absent
		hadLink = true;
		try { linkTarget = (await import("node:fs")).readlinkSync(linkPath); } catch { linkTarget = null; }
	} catch { /* absent */ }
	if (!hadBundle && depValue === undefined && !hadLink) return false;
	if (hadBundle) manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== pkg);
	if (depValue !== undefined) delete manifest.dependencies[pkg];
	await writeManifest(manifest);
	if (hadLink) {
		try { rm(linkPath, { recursive: true, force: true }); } catch { /* best effort */ }
	}
	record.disabled.push({ pkg, hadBundle, depValue, hadLink, linkTarget });
	return true;
}

/** Delete = remove the plugin's real files when they live under plugins root. */
async function deletePlugin(pkg, record) {
	const linkPath = join(PROFILE_WEB_NM, pkg);
	let target = null;
	try { target = (await import("node:fs")).readlinkSync(linkPath); } catch { /* gone already */ }
	// remove any remaining resolvability
	try { rm(linkPath, { recursive: true, force: true }); } catch { /* best effort */ }
	let deleted = null;
	if (target) {
		const t = target.replace(/\//g, "\\");
		if (t.toLowerCase().startsWith(PLUGINS_ROOT.toLowerCase())) {
			await rm(t, { recursive: true, force: true }).catch(() => {});
			deleted = t;
		}
	}
	record.deleted.push({ pkg, path: deleted });
	return true;
}

async function restoreFromRecord(record) {
	// manifest snapshot wins 鈥?it is the single source of registration truth
	if (record.manifestBackup) await writeManifest(record.manifestBackup);
	for (const d of record.disabled) {
		if (d.hadLink && d.linkTarget) {
			const linkPath = join(PROFILE_WEB_NM, d.pkg);
			await mkdir(dirname(linkPath), { recursive: true }).catch(() => {});
			try { rmdirSync(linkPath); } catch { /* not a link anymore */ }
			await new Promise((resolve) => {
				const child = spawn("cmd.exe", ["/c", "mklink", "/J", `"${linkPath}"`, `"${d.linkTarget}"`], { windowsHide: true, windowsVerbatimArguments: true });
				child.on("error", () => resolve());
				child.on("close", () => resolve());
			});
		}
	}
}

// 鈹€鈹€ launcher path fix-up after a versioned dir rename 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function patchLaunchers(oldDirName, newDirName) {
	const files = [
		join(DSH_HOME, "launcher", "start-dsh.cmd"),
		join(OHDSH_BASE, "dsh-desktop-electron"),
	];
	const targets = [];
	const first = files[0];
	if (first) targets.push(first);
	// desktop launcher: find the only *.cmd at the electron dir root (non-ASCII name, locate structurally)
	try {
		const entries = await readdir(files[1], { withFileTypes: true });
		for (const e of entries) if (e.isFile() && e.name.toLowerCase().endsWith(".cmd")) targets.push(join(files[1], e.name));
	} catch { /* dir may not exist on other machines */ }
	for (const f of targets) {
		try {
			const c = await readFile(f, "utf8");
			if (c.includes(oldDirName)) {
				await writeFile(f, c.split(oldDirName).join(newDirName), "utf8");
			}
		} catch { /* best effort */ }
	}
}

// 鈹€鈹€ the staged apply flow 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// The apply flow KILLS the process that serves it (stopping DSH means
// stopping the plugin host too). So the actual work runs in a detached
// PowerShell child that drives a tiny node runner; state goes through a
// JSON file the plugin (and the panel) can poll across the restart.
const APPLY_STATE_PATH = join(STAGING_DIR, "apply-state.json");
const APPLY_LOCK_PATH = join(STAGING_DIR, "apply.lock");

function readApplyState() {
	try {
		return JSON.parse(rfSync(APPLY_STATE_PATH, "utf8"));
	} catch {
		return { done: true, phase: "idle", log: [], result: null };
	}
}

export function applyOhDshState() {
	return readApplyState();
}

export async function applyOhDshUpdate(confirmDelete = false) {
	const cur = readApplyState();
	if (!cur.done) {
		return Promise.resolve({ started: false, reason: "an update is already in progress", phase: cur.phase });
	}
	const runnerSrc = join(STAGING_DIR, "apply-runner.mjs");
	await writeFile(runnerSrc, APPLY_RUNNER_SRC, "utf8");
	await writeFile(APPLY_STATE_PATH, JSON.stringify({ done: false, phase: "starting", log: [], result: null }), "utf8");
	await writeFile(APPLY_LOCK_PATH, String(Date.now()), "utf8");
	// detached powershell 鈫?node runner: survives the death of this process
	const child = spawn("powershell.exe", [
		"-NoProfile", "-Command",
		`Start-Process -FilePath '${nodeExePath()}' -ArgumentList '\"${runnerSrc}\"','\"${APPLY_STATE_PATH}\"','${confirmDelete ? "1" : "0"}' -WindowStyle Hidden`,
	], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
	return Promise.resolve({ started: true, phase: "spawned" });
}

function nodeExePath() {
	// prefer the running node (this plugin is loaded by node)
	return process.execPath;
}

/** The runner: a standalone script that calls runApply and writes state. */
const APPLY_RUNNER_SRC = String.raw`
import { writeFile } from "node:fs/promises";
const [statePath, confirmDel] = process.argv.slice(2);
// The runner imports the plugin's own engine by absolute path.
const engineUrl = "file:///" + process.env.DSH_AU_ENGINE_PATH.replace(/\\/g, "/");
try {
  const mod = await import(engineUrl);
  const result = await mod.runApplyStandalone(confirmDel === "1", (line) => {
    // progress callbacks are best-effort; the final write is authoritative
  });
  await writeFile(statePath, JSON.stringify({ done: true, phase: "done", log: result.log ?? [], result }), "utf8");
} catch (error) {
  await writeFile(statePath, JSON.stringify({ done: true, phase: "done", log: [], result: { started: true, ok: false, error: String(error && error.message || error) } }), "utf8");
}
`;

/**
 * Called by the standalone runner (in its own process) 鈥?same flow as
 * runApply but exported for that purpose. Safe to call in-process too.
 */
export async function runApplyStandalone(confirmDelete, onProgress) {
	return runApply(confirmDelete);
}

async function runApply(confirmDelete) {
	const log = [];
	const step = (m) => {
		const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
		log.push(line);
		if (typeof applyState !== "undefined" && applyState) { applyState.phase = m; applyState.log = log.slice(); }
	};
	const record = { manifestBackup: null, disabled: [], deleted: [] };
	let swapped = false;
	let backupMoved = false;
	let oldInstall = null;

	try {
		const status = await ohDshStatus();
		if (!status.webAsset) return { started: true, ok: false, log, error: "no web asset in latest release" };
		if (status.installedVersion && compareVersions(status.version, status.installedVersion) <= 0) {
			return { started: true, ok: true, noop: true, log, detail: "already up to date" };
		}
		const config = await readLocalConfig();
		const autoDelete = config.autoDeleteIncompatible === true;

		// 1) download
		step(`downloading ${status.webAsset.name} (${Math.round(status.webAsset.size / 1048576)} MB)`);
		const zipPath = join(STAGING_DIR, status.webAsset.name);
		if (!(await stat(zipPath).then((s) => s.size === status.webAsset.size, () => false))) {
			await downloadTo(status.webAsset.url, zipPath);
		} else {
			step("using fully-downloaded staging zip");
		}

		// 2) stop & verify port free 鈥?hard failure if we cannot get the port
		oldInstall = await resolveInstallDir();
		if (!oldInstall) return { started: true, ok: false, log, error: "no existing oh-dsh-web install found" };
		record.manifestBackup = await readManifest();
		step("stopping DSH and waiting for the port to free");
		const portFree = await stopAndWaitPortFree(oldInstall.dir);
		if (!portFree) {
			return { started: true, ok: false, log, error: `port ${HEALTH_PORT} is still occupied by an unknown process; aborting before any change` };
		}
		step("port free");

		// 3) swap
		const newDirName = `oh-dsh-web-${status.version}-win-x64`;
		const newDir = join(OHDSH_BASE, newDirName);
		step("backing up current install");
		await rm(BACKUP_DIR, { recursive: true, force: true });
		await rename(oldInstall.dir, BACKUP_DIR);
		backupMoved = true;
		try {
			step("extracting new version");
			const extractDir = join(STAGING_DIR, "extract");
			await rm(extractDir, { recursive: true, force: true });
			await mkdir(extractDir, { recursive: true });
			await new Promise((resolve, reject) => {
				execFile(TARBALL_EXE, ["-xf", zipPath, "-C", extractDir], { timeout: 10 * 60_000, windowsHide: true }, (err) => err ? reject(err) : resolve());
			});
			const entries = await readdir(extractDir);
			let sourceDir = extractDir;
			if (entries.length === 1) {
				const only = join(extractDir, entries[0]);
				if ((await stat(only)).isDirectory()) sourceDir = only;
			}
			await rename(sourceDir, newDir);
			swapped = true;
			step(`moved into place: ${newDirName}`);
		} catch (swapError) {
			step(`swap failed (${swapError?.message ?? swapError}); restoring backup`);
			await rename(BACKUP_DIR, oldInstall.dir).catch(() => {});
			backupMoved = false;
			throw swapError;
		}

		// 4) boot loop with third-party plugin handling
		const launcher = join(newDir, "bin", "oh-dsh-web.cmd");
		const bootLog = join(STAGING_DIR, "boot.log");
		let booted = false;
		let attemptedDelete = false;
		for (let attempt = 1; attempt <= 5; attempt++) {
			step(`boot attempt ${attempt}`);
			const r = await bootAndCheck(launcher, bootLog);
			if (r.ok) { booted = true; step("health check OK"); break; }
			const bad = failingPluginsFromLog(r.log);
			if (bad.length === 0) { step("boot failed for a non-plugin reason"); break; }
			if (attemptedDelete) { step("still failing after deletion"); break; }
			// disable round; when the config allows it and a previous disable
			// round already happened with no effect, delete instead
			const alreadyDisabled = bad.every((p) => record.disabled.some((d) => d.pkg === p));
			const shouldDelete = alreadyDisabled && record.disabled.length > 0 && (autoDelete || confirmDelete);
			for (const p of bad) {
				if (shouldDelete) {
					step(`DELETING incompatible plugin: ${p}`);
					await deletePlugin(p, record);
					attemptedDelete = true;
				} else {
					step(`disabling incompatible plugin: ${p}`);
					await disablePlugin(p, record);
				}
			}
		}

		// 5) outcome
		if (booted) {
			step("patching launchers to the new install dir");
			await patchLaunchers(oldInstall.name, newDirName);
			await rm(BACKUP_DIR, { recursive: true, force: true }).catch(() => {}); // keep no stale backup on success
			await rm(zipPath, { force: true }).catch(() => {});
			await rm(join(STAGING_DIR, "extract"), { recursive: true, force: true }).catch(() => {});
			return {
				started: true, ok: true, version: status.version,
				disabled: record.disabled.map((d) => d.pkg),
				deleted: record.deleted.map((d) => d.pkg),
				log,
			};
		}

		// not booted 鈥?decide: ask the user, or roll back
		if (!autoDelete && !confirmDelete && record.disabled.length > 0) {
			// roll everything back first: old version keeps serving
			step("rolling back to keep the current version running");
			await killDshNodeProcesses(newDir);
			if (swapped) await rm(newDir, { recursive: true, force: true }).catch(() => {});
			if (backupMoved) await rename(BACKUP_DIR, oldInstall.dir).catch(() => {});
			await restoreFromRecord(record);
			await startDsh(join(oldInstall.dir, "bin", "oh-dsh-web.cmd"));
			await healthCheck(60_000);
			return {
				started: true, ok: false, rolledBack: true, needsConfirmation: true,
				plugins: record.disabled.map((d) => d.pkg),
				log, error: "incompatible third-party plugins need deletion; user confirmation required",
			};
		}

		// hard failure 鈥?full rollback including any disable/delete actions
		step("update failed; rolling back everything");
		await killDshNodeProcesses(newDir);
		if (swapped) await rm(newDir, { recursive: true, force: true }).catch(() => {});
		if (backupMoved) await rename(BACKUP_DIR, oldInstall.dir).catch(() => {});
		await restoreFromRecord(record);
		await startDsh(join(oldInstall.dir, "bin", "oh-dsh-web.cmd"));
		await healthCheck(60_000);
		return { started: true, ok: false, rolledBack: true, log, error: "boot failed after plugin handling; previous version restored" };
	} catch (error) {
		step(`ERROR ${error?.message ?? error}`);
		// best-effort rollback of an interrupted swap
		try {
			const cur = await resolveInstallDir();
			const newish = join(OHDSH_BASE, `oh-dsh-web-`);
			if (backupMoved && cur && cur.dir !== oldInstall?.dir) {
				await killDshNodeProcesses(cur.dir);
				await rm(cur.dir, { recursive: true, force: true }).catch(() => {});
				await rename(BACKUP_DIR, oldInstall.dir);
				await restoreFromRecord(record);
				await startDsh(join(oldInstall.dir, "bin", "oh-dsh-web.cmd"));
			}
		} catch { /* nothing more we can do */ }
		return { started: true, ok: false, log, error: error?.message ?? String(error) };
	}
}

// 鈹€鈹€ desktop-surface staged update 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
export async function downloadDesktopInstaller() {
	const status = await ohDshStatus();
	if (!status.desktopAsset) return { ok: false, error: "no desktop asset in latest release" };
	const dest = join(STAGING_DIR, status.desktopAsset.name);
	if (!(await stat(dest).then((s) => s.size === status.desktopAsset.size, () => false))) {
		const dl = await downloadTo(status.desktopAsset.url, dest);
		return { ok: true, path: dest, size: dl.size, version: status.version };
	}
	return { ok: true, path: dest, version: status.version };
}

export async function runDesktopInstaller() {
	const files = await readdir(STAGING_DIR).catch(() => []);
	const installer = files.filter((f) => OHDSH_DESKTOP_ASSET_RE.test(f)).sort().pop();
	if (!installer) return { ok: false, error: "no staged desktop installer; download one first" };
	const child = spawn("cmd.exe", ["/c", "start", "", `"${join(STAGING_DIR, installer)}"`], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
	return { ok: true, installer };
}
