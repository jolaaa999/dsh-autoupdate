/**
 * dsh-autoupdate v2.1 — Oh-DSH本体 update channel (GitHub Releases).
 *
 * Dual-surface: web (oh-dsh-web-<ver>-win-x64.zip, side-by-side dir swap)
 * and desktop (Oh-DSH-Desktop-<ver>-x64.exe, staged installer + one-click run).
 *
 * Web update strategy — "staging + atomic swap + health check":
 *   1. fetch latest release info from GitHub API (no download yet)
 *   2. download the zip to <base>\staging\, verify size
 *   3. stop DSH processes, POLl the port until actually free (lesson from
 *      the first live run: a stale process holding 3080 fails every boot)
 *   4. move current install to a fixed backup dir, extract staging zip
 *      (System32 tar.exe — Git-Bash tar misreads "E:" as a hostname)
 *   5. boot new version, health-check the local web port
 *   6. on boot failure caused by third-party plugins: disable them
 *      (remove bundle entry + node_modules junction, record for restore)
 *      and retry — up to 3 rounds. If disabling was not enough:
 *        - autoDeleteIncompatible config (local owner machine): delete the
 *          plugin files and retry once more
 *        - otherwise: roll everything back and return needsConfirmation
 *          listing the plugins; the client panel asks the user before a
 *          confirming re-run deletes them
 *   7. failure at any point after the swap → restore backup automatically
 *
 * The plugin never touches the data dir (userdata) — programs and data are
 * physically separate by design.
 */
import { readFile, writeFile, stat, rename, rm, mkdir, readdir, readFile as rf } from "node:fs/promises";
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

// ── small helpers ───────────────────────────────────────────────────────
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
			const hasManifest = await stat(join(OHDSH_BASE, name, "package.json")).then(() => true, () => false);
			if (hasManifest) candidates.push({ name, version: m[1] });
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => compareVersions(b.version, a.version));
	return { dir: join(OHDSH_BASE, candidates[0].name), name: candidates[0].name, version: candidates[0].version };
}

// ── status ──────────────────────────────────────────────────────────────
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

// ── download ────────────────────────────────────────────────────────────
async function downloadTo(url, destPath) {
	await mkdir(dirname(destPath), { recursive: true });
	const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
	await pipeline(res.body, createWriteStream(destPath));
	const st = await stat(destPath);
	if (st.size < 1_000_000) throw new Error(`downloaded file too small (${st.size} bytes)`);
	return { size: st.size };
}

// ── process control (with real port-free verification) ─────────────────
function killDshNodeProcesses(installDir) {
	return new Promise((resolve) => {
		// Match broadly on the install path appearing anywhere in the command
		// line — the first live run taught us `oh-dsh..cli` missed
		// `lib\oh-dsh\cli.js` (single-char gap).
		const ps = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*${installDir.replace(/\\/g, "\\\\")}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
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
			if (res.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

/** Boot via launcher with output captured; resolve {ok, log}. */
async function bootAndCheck(launcherCmd, logPath) {
	await new Promise((resolve) => {
		const child = execFile("cmd.exe", ["/c", `"${launcherCmd}" > "${logPath}" 2>&1`], { timeout: 150_000, windowsHide: true }, () => resolve());
		child.on("error", () => resolve());
	});
	const ok = await healthCheck(HEALTH_CHECK_MS);
	const log = await readFile(logPath, "utf8").catch(() => "");
	return { ok, log };
}

// ── third-party plugin disable / delete / restore ───────────────────────
function failingPluginsFromLog(log) {
	const pkgs = new Set();
	const re = /failed to (?:apply|import) loader entry ([\w.@/-]+) \(([^)]+)\)/g;
	let m;
	while ((m = re.exec(log)) !== null) {
		const pkg = m[2];
		if (!isProtected(pkg)) pkgs.add(pkg);
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
	// manifest snapshot wins — it is the single source of registration truth
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

// ── launcher path fix-up after a versioned dir rename ───────────────────
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

// ── the staged apply flow ───────────────────────────────────────────────
let applyPromise = null;

export function applyOhDshUpdate(confirmDelete = false) {
	if (applyPromise !== null) {
		return Promise.resolve({ started: false, reason: "an update is already in progress" });
	}
	applyPromise = runApply(confirmDelete).finally(() => { applyPromise = null; });
	return applyPromise;
}

async function runApply(confirmDelete) {
	const log = [];
	const step = (m) => { log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); };
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

		// 2) stop & verify port free — hard failure if we cannot get the port
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

		// not booted — decide: ask the user, or roll back
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

		// hard failure — full rollback including any disable/delete actions
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

// ── desktop-surface staged update ───────────────────────────────────────
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
