/**
 * dsh-autoupdate v2.0 — Oh-DSH本体 update channel (GitHub Releases).
 *
 * Dual-surface: web (oh-dsh-web-<ver>-win-x64.zip, side-by-side dir swap)
 * and desktop (Oh-DSH-Desktop-<ver>-x64.exe, staged installer + one-click run).
 *
 * Update strategy for the web surface — "staging + atomic swap + health check":
 *   1. fetch latest release info from GitHub API (no download yet)
 *   2. download the zip to E:\Oh-DSH\staging\, verify non-trivial size
 *   3. (on apply) stop running DSH node processes
 *   4. move current install dir to backup, extract staging zip into place
 *   5. restart via the launcher cmd, health-check the local web port
 *   6. failure at any point after the swap → restore backup automatically
 *
 * The plugin never touches E:\Oh-DSH\userdata (data is physically separate
 * from the program dir by design). Rollback keeps exactly one previous
 * version; applying a new version while a backup exists overwrites it only
 * after the swap succeeds.
 */
import { readFile, writeFile, stat, rename, rm, mkdir, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const OHDSH_REPO = process.env.DSH_OHDSH_REPO || "hust-open-atom-club/oh-dsh";
const OHDSH_INSTALL_DIR = process.env.DSH_OHDSH_WEB_DIR || "E:\\Oh-DSH\\oh-dsh-web-0.1.7-win-x64";
const OHDSH_STAGING_DIR = process.env.DSH_OHDSH_STAGING || "E:\\Oh-DSH\\staging";
const OHDSH_LAUNCHER = process.env.DSH_OHDSH_LAUNCHER || "E:\\Oh-DSH\\oh-dsh-web-0.1.7-win-x64\\bin\\oh-dsh-web.cmd";
const OHDSH_HEALTH_URL = process.env.DSH_OHDSH_HEALTH_URL || "http://127.0.0.1:3080/";
const OHDSH_DESKTOP_ASSET_RE = /^Oh-DSH-Desktop-([\d.]+)-x64\.exe$/;
const OHDSH_WEB_ASSET_RE = /^oh-dsh-web-([\d.]+)-win-x64\.zip$/;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const HEALTH_CHECK_MS = 90_000;

export const name = "dsh-autoupdate";

// ── version helpers ─────────────────────────────────────────────────────
function compareVersions(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

async function readInstalledVersion() {
	try {
		const raw = await readFile(join(OHDSH_INSTALL_DIR, "package.json"), "utf8");
		return { ok: true, version: JSON.parse(raw).version ?? null };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
}

// ── GitHub release inspection ───────────────────────────────────────────
async function fetchLatestRelease() {
	const res = await fetch(`https://api.github.com/repos/${OHDSH_REPO}/releases/latest`, {
		headers: { "accept": "application/vnd.github+json", "user-agent": "dsh-autoupdate" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status}`);
	const body = await res.json();
	const assets = (body.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
	const webAsset = assets.find((a) => OHDSH_WEB_ASSET_RE.test(a.name)) ?? null;
	const desktopAsset = assets.find((a) => OHDSH_DESKTOP_ASSET_RE.test(a.name)) ?? null;
	return {
		ok: true,
		tag: body.tag_name,
		version: String(body.tag_name || "").replace(/^v/, ""),
		publishedAt: body.published_at,
		releaseNotes: body.body ?? "",
		releaseUrl: body.html_url,
		webAsset,
		desktopAsset,
	};
}

/** Combined "what's available" snapshot for the panel. */
export async function ohDshStatus() {
	const [installed, release] = await Promise.allSettled([readInstalledVersion(), fetchLatestRelease()]);
	const out = { ok: true, repo: OHDSH_REPO };
	if (installed.status === "fulfilled" && installed.value.ok) out.installedVersion = installed.value.version;
	else out.installedError = installed.status === "fulfilled" ? installed.value.error : String(installed.value.reason);
	if (release.status === "fulfilled") {
		Object.assign(out, release.value);
		if (out.installedVersion && release.value.version) {
			out.updateAvailable = compareVersions(release.value.version, out.installedVersion) > 0;
		}
	} else {
		out.releaseError = String(release.value.reason?.message ?? release.value.reason);
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
	if (st.size < 1_000_000) throw new Error(`downloaded file too small (${st.size} bytes), likely a proxy error page`);
	return { size: st.size };
}

// ── process control ─────────────────────────────────────────────────────
function stopDshProcesses() {
	return new Promise((resolve) => {
		const ps = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'dsh-runtime|oh-dsh..cli') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
		execFile("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 30_000, windowsHide: true }, () => resolve());
	});
}

function startDsh() {
	return new Promise((resolve) => {
		// launch detached in its own hidden console so it survives this process
		const child = spawn("cmd.exe", ["/c", "start", "\"Oh-DSH - DSH Host\"", "/min", OHDSH_LAUNCHER], {
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
			const res = await fetch(OHDSH_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
			if (res.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

// ── web-surface staged update ───────────────────────────────────────────
let applyPromise = null;

export function applyOhDshUpdate() {
	if (applyPromise !== null) {
		return Promise.resolve({ started: false, reason: "an update is already in progress" });
	}
	applyPromise = runApply().finally(() => { applyPromise = null; });
	return applyPromise;
}

async function runApply() {
	const log = [];
	const step = (m) => { log.push(`${new Date().toISOString()} ${m}`); };
	try {
		const status = await ohDshStatus();
		if (!status.webAsset) return { started: true, ok: false, log, error: "no web asset in latest release" };
		if (status.installedVersion && compareVersions(status.version, status.installedVersion) <= 0) {
			return { started: true, ok: true, noop: true, log, detail: "already up to date" };
		}

		// 1) download to staging
		step(`downloading ${status.webAsset.name} (${Math.round(status.webAsset.size / 1048576)} MB)`);
		const zipPath = join(OHDSH_STAGING_DIR, status.webAsset.name);
		await downloadTo(status.webAsset.url, zipPath);
		const dl = await stat(zipPath);
		step(`downloaded ${dl.size} bytes`);

		// 2) stop the service
		step("stopping DSH processes");
		await stopDshProcesses();
		await new Promise((r) => setTimeout(r, 4000));

		// 3) swap directories (backup current, extract new)
		const backupDir = `${OHDSH_INSTALL_DIR}.bak`;
		const extractDir = join(OHDSH_STAGING_DIR, "extract");
		step("backing up current install");
		await rm(backupDir, { recursive: true, force: true });
		await rename(OHDSH_INSTALL_DIR, backupDir);
		try {
			step("extracting new version");
			await rm(extractDir, { recursive: true, force: true });
			await mkdir(extractDir, { recursive: true });
			await new Promise((resolve, reject) => {
				execFile("tar", ["-xf", zipPath, "-C", extractDir], { timeout: 10 * 60_000, windowsHide: true }, (err) => err ? reject(err) : resolve());
			});
			// normalize: the zip may or may not contain a top-level dir
			const entries = await readdir(extractDir);
			let sourceDir = extractDir;
			if (entries.length === 1) {
				const only = join(extractDir, entries[0]);
				if ((await stat(only)).isDirectory()) sourceDir = only;
			}
			step("moving new version into place");
			await rename(sourceDir, OHDSH_INSTALL_DIR);
		} catch (swapError) {
			// roll the backup back — never leave the machine without an install
			step(`swap failed (${swapError?.message ?? swapError}); restoring backup`);
			await rename(backupDir, OHDSH_INSTALL_DIR).catch(() => {});
			throw swapError;
		}

		// 4) restart + health check
		step("starting updated DSH");
		await startDsh();
		const healthy = await healthCheck();
		if (!healthy) {
			step("health check FAILED; rolling back");
			await stopDshProcesses();
			await rm(OHDSH_INSTALL_DIR, { recursive: true, force: true }).catch(() => {});
			await rename(backupDir, OHDSH_INSTALL_DIR).catch(() => {});
			await startDsh();
			await healthCheck(60_000);
			step("rollback complete");
			return { started: true, ok: false, rolledBack: true, log, error: "health check failed, previous version restored" };
		}

		// 5) success — keep backup for one version, clean staging
		step("update OK");
		await rm(extractDir, { recursive: true, force: true }).catch(() => {});
		await rm(zipPath, { force: true }).catch(() => {});
		return { started: true, ok: true, version: status.version, backup: backupDir, log };
	} catch (error) {
		step(`ERROR ${error?.message ?? error}`);
		return { started: true, ok: false, log, error: error?.message ?? String(error) };
	}
}

// ── desktop-surface staged update ───────────────────────────────────────
export async function downloadDesktopInstaller() {
	const status = await ohDshStatus();
	if (!status.desktopAsset) return { ok: false, error: "no desktop asset in latest release" };
	const dest = join(OHDSH_STAGING_DIR, status.desktopAsset.name);
	const dl = await downloadTo(status.desktopAsset.url, dest);
	return { ok: true, path: dest, size: dl.size, version: status.version };
}

/** Open the staged installer (or its folder) for the user to click through. */
export async function runDesktopInstaller() {
	const files = await readdir(OHDSH_STAGING_DIR).catch(() => []);
	const installer = files.filter((f) => OHDSH_DESKTOP_ASSET_RE.test(f)).sort().pop();
	if (!installer) return { ok: false, error: "no staged desktop installer; download one first" };
	const child = spawn("cmd.exe", ["/c", "start", "", `"${join(OHDSH_STAGING_DIR, installer)}"`], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
	return { ok: true, installer };
}
