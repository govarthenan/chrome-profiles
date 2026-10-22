#!/usr/bin/env node
/**
 * chrome-profiles: list the Chrome profiles on this computer, report whether
 * the running Chrome accepts a DevTools connection, and open a window for one
 * profile inside the Chrome that is already running.
 *
 * No dependencies. Output is JSON on stdout. Errors are JSON on stderr.
 *
 *   node chrome-profiles.mjs status
 *   node chrome-profiles.mjs list
 *   node chrome-profiles.mjs open <profile> [url]
 *
 * <profile> is a profile folder ("Profile 1"), a display name ("Work") or an
 * account email. Matching ignores case.
 *
 * Environment overrides: CHROME_USER_DATA_DIR, CHROME_BIN.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/**
 * Write one JSON error record to stderr and exit.
 * @param {string} message - What went wrong.
 * @param {object} [context] - Extra fields that help the reader act on it.
 * @param {number} [code] - Process exit code.
 */
function fail(message, context = {}, code = EXIT_ERROR) {
  process.stderr.write(JSON.stringify({ error: message, ...context }, null, 2) + "\n");
  process.exit(code);
}

/**
 * Write a result as pretty JSON to stdout.
 * @param {unknown} value - The result.
 */
function emit(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Find the user data folder of Google Chrome (stable) for this OS.
 * @returns {string} Absolute path. It can be absent on disk.
 */
function userDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
    default:
      return join(homedir(), ".config", "google-chrome");
  }
}

/**
 * Find an executable on PATH.
 * @param {string} name - Program name.
 * @returns {string|null} Absolute path, or null.
 */
function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder. Try the next one.
    }
  }
  return null;
}

/**
 * Find the Chrome program for this OS.
 * @returns {string|null} Absolute path, or null when Chrome is not found.
 */
function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  switch (platform()) {
    case "darwin": {
      const app = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      return existsSync(app) ? app : null;
    }
    case "win32": {
      const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
      for (const root of roots.filter(Boolean)) {
        const exe = join(root, "Google", "Chrome", "Application", "chrome.exe");
        if (existsSync(exe)) return exe;
      }
      return null;
    }
    default:
      return onPath("google-chrome") ?? onPath("google-chrome-stable");
  }
}

/**
 * Read Chrome's "Local State" file, which holds the profile catalog.
 * @param {string} dataDir - Chrome user data folder.
 * @returns {object} Parsed JSON.
 */
function readLocalState(dataDir) {
  const file = join(dataDir, "Local State");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail("Cannot read Chrome's Local State file", { file, reason: err.message });
  }
}

/**
 * Build the profile list from Local State.
 * Profile folders are not always "Default" or "Profile N", so the catalog in
 * Local State is the only reliable source.
 * @param {string} dataDir - Chrome user data folder.
 * @returns {Array<{dir: string, name: string, email: string, accountName: string, open: boolean, lastUsed: boolean}>}
 */
function listProfiles(dataDir) {
  const state = readLocalState(dataDir);
  const cache = state?.profile?.info_cache ?? {};
  const active = new Set(state?.profile?.last_active_profiles ?? []);
  const lastUsed = state?.profile?.last_used;
  return Object.entries(cache).map(([dir, info]) => ({
    dir,
    name: info.name ?? "",
    email: info.user_name ?? "",
    accountName: info.gaia_name ?? "",
    open: active.has(dir),
    lastUsed: dir === lastUsed,
  }));
}

/**
 * Resolve a user's words to exactly one profile.
 * Order: folder name, then display name, then email. Each step ignores case.
 * @param {ReturnType<typeof listProfiles>} profiles - The catalog.
 * @param {string} query - Folder, display name or email.
 * @returns {ReturnType<typeof listProfiles>[number]}
 */
function resolveProfile(profiles, query) {
  const q = query.trim().toLowerCase();
  for (const field of ["dir", "name", "email"]) {
    const hits = profiles.filter((p) => p[field].toLowerCase() === q);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      fail(`More than one profile has this ${field}`, { query, matches: hits.map((p) => p.dir) });
    }
  }
  fail("No profile matches", { query, profiles: profiles.map(({ dir, name, email }) => ({ dir, name, email })) });
}

/**
 * Test whether something accepts TCP connections on 127.0.0.1:port.
 * This opens and closes a plain socket. It sends no DevTools request.
 * @param {number} port - Port number.
 * @returns {Promise<boolean>}
 */
function portListens(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Report the facts that decide whether an --autoConnect DevTools client can
 * attach: Chrome version, and the DevToolsActivePort file that Chrome writes
 * when remote debugging is on in chrome://inspect/#remote-debugging.
 * @param {string} dataDir - Chrome user data folder.
 * @returns {Promise<object>}
 */
async function status(dataDir) {
  const versionFile = join(dataDir, "Last Version");
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null;
  const major = version ? Number.parseInt(version, 10) : null;

  const portFile = join(dataDir, "DevToolsActivePort");
  let port = null;
  if (existsSync(portFile)) {
    port = Number.parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10) || null;
  }
  const listening = port ? await portListens(port) : false;

  const problems = [];
  if (!existsSync(dataDir)) problems.push("Chrome user data folder not found");
  if (major !== null && major < 144) problems.push("Chrome 144 or later is necessary for --autoConnect");
  if (!port) problems.push("Remote debugging is off. The user must turn it on at chrome://inspect/#remote-debugging");
  else if (!listening) problems.push("DevToolsActivePort exists, but nothing listens on the port. Chrome is closed, or remote debugging is off");

  return {
    platform: platform(),
    userDataDir: dataDir,
    chromeBinary: chromeBinary(),
    chromeVersion: version,
    remoteDebugging: { portFile: existsSync(portFile), port, listening },
    ready: problems.length === 0,
    problems,
  };
}

/**
 * Open a new window for one profile. When Chrome is already running, Chrome
 * hands the request to the running browser, so the window joins the browser
 * that the DevTools client is attached to.
 * @param {string} dataDir - Chrome user data folder.
 * @param {string} query - Profile folder, display name or email.
 * @param {string} url - First page of the new window.
 * @returns {object} The profile that was opened.
 */
function openProfile(dataDir, query, url) {
  const profile = resolveProfile(listProfiles(dataDir), query);
  const flag = `--profile-directory=${profile.dir}`;
  let command;
  let args;
  if (platform() === "darwin") {
    command = "open";
    args = ["-na", "Google Chrome", "--args", flag, url];
  } else {
    command = chromeBinary();
    if (!command) fail("Google Chrome not found. Set CHROME_BIN to its path.");
    args = [flag, url];
  }
  if (process.env.CHROME_USER_DATA_DIR) args.splice(args.indexOf(flag), 0, `--user-data-dir=${dataDir}`);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => fail("Cannot start Chrome", { command, reason: err.message }));
  child.unref();
  return { opened: profile, url, command: [command, ...args].join(" ") };
}

const USAGE = `Usage:
  chrome-profiles.mjs status
  chrome-profiles.mjs list
  chrome-profiles.mjs open <profile> [url]   (default url: about:blank)`;

const [cmd, ...rest] = process.argv.slice(2);
const dataDir = userDataDir();

switch (cmd) {
  case "status":
    emit(await status(dataDir));
    break;
  case "list":
    emit({ userDataDir: dataDir, profiles: listProfiles(dataDir) });
    break;
  case "open": {
    const [query, url = "about:blank"] = rest;
    if (!query) fail("open needs a profile", { usage: USAGE }, EXIT_USAGE);
    emit(openProfile(dataDir, query, url));
    break;
  }
  default:
    fail(cmd ? `Unknown command: ${cmd}` : "No command", { usage: USAGE }, EXIT_USAGE);
}
process.exitCode = EXIT_OK;
