#!/usr/bin/env node
// Mokido & Live Canvas Multi-Tool Installer & Updater
// Author: Roman Kolganov
// License: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================================================
// ONE physical copy of the server/plugin, ~/.mokido/mcp, and every MCP config
// points at it. Up to 4.3 the installer also kept private copies under
// ~/.gemini/antigravity{,-ide}/mcp/ and the shared one under the pre-rename
// ~/.figma-mcp-bridge/mcp/. Three copies meant three places to go stale and
// several "Mokido" servers of different versions fighting for :8765, with the
// plugin asking to update because the master was the old one. Antigravity
// does not need its own copy: it writes its <tool>.json files into
// ~/.gemini/<app>/mcp/<server name>/ wherever the server itself lives.
// ==========================================================================
const CANONICAL_KEY = "canonical";

/** Maps an install location key -> the directory its server+plugin copy
 * lives in. Only the canonical copy is installed now. */
function installLocations(home) {
  return {
    [CANONICAL_KEY]: path.join(home, ".mokido", "mcp"),
  };
}

/** Config files earlier versions wrote a `figma` entry into although no
 * client reads them: agy CLI reads ~/.gemini/config/mcp_config.json, its
 * antigravity-cli/ folder only gets tool schemas and conversations. */
function legacyConfigs(home) {
  return [path.join(home, ".gemini", "antigravity-cli", "mcp_config.json")];
}

/** Drops our `figma` entry from a config nothing reads; the file goes too
 * when nothing else is left in it. */
function removeLegacyConfigEntry(configFile) {
  let data;
  try { data = JSON.parse(fs.readFileSync(configFile, "utf-8")); } catch (e) { return false; }
  if (!data?.mcpServers?.figma) return false;
  delete data.mcpServers.figma;
  try {
    const onlyEmptyServers = Object.keys(data).length === 1 && Object.keys(data.mcpServers).length === 0;
    if (onlyEmptyServers) fs.rmSync(configFile);
    else atomicWriteJson(configFile, data);
    return true;
  } catch (e) {
    console.log(`[!] Warning: could not clean ${configFile}: ${e.message}`);
    return false;
  }
}

/** Copies earlier versions installed and nothing references any more. An
 * --update removes the files install.mjs put there (see removeLegacyCopy). */
function legacyLocations(home) {
  return {
    antigravity: path.join(home, ".gemini", "antigravity", "mcp"),
    "antigravity-ide": path.join(home, ".gemini", "antigravity-ide", "mcp"),
    "figma-mcp-bridge": path.join(home, ".figma-mcp-bridge", "mcp"),
  };
}

/** Warn if the Node running this script is too old for the server's global
 * `fetch` (Node < 18 doesn't have it). No subprocess needed — this script
 * already runs inside the exact runtime that will run the server. */
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    console.log(`[!] Warning: Node.js v${process.versions.node} detected, but this server needs Node 18+ (uses global fetch).`);
    console.log("    Upgrade from https://nodejs.org before running the MCP server.");
    return false;
  }
  console.log(`[✓] Node.js runtime detected: v${process.versions.node}`);
  return true;
}

/** Finds every supported AI assistant MCP config file that already looks
 * installed, and which server copy each one should reference.
 *
 * Returns a list of {path, location} objects. A config is only included
 * when the *application's own* directory already exists — we don't want to
 * scatter mcp_config.json files for tools the user has never run. The one
 * exception is the Gemini fallback, added later if nothing else was
 * detected at all.
 *
 * `home` and `appdata` are explicit parameters rather than read from
 * os.homedir()/process.env internally, specifically so tests can point this
 * at a throwaway directory without any risk of touching the real machine's
 * actual MCP configs — a real install once got clobbered during manual
 * testing precisely because reaching for the real home dir/env inside a
 * helper defeats whatever a caller thinks it patched. */
function getConfigTargets(home, appdata) {
  const targets = [];

  const geminiRoot = path.join(home, ".gemini");
  if (fs.existsSync(path.join(geminiRoot, "antigravity"))) {
    targets.push({ path: path.join(geminiRoot, "antigravity", "mcp_config.json"), location: CANONICAL_KEY });
  }
  if (fs.existsSync(path.join(geminiRoot, "antigravity-ide"))) {
    targets.push({ path: path.join(geminiRoot, "antigravity-ide", "mcp_config.json"), location: CANONICAL_KEY });
  }
  if (fs.existsSync(path.join(geminiRoot, "config"))) {
    targets.push({ path: path.join(geminiRoot, "config", "mcp_config.json"), location: CANONICAL_KEY });
  }

  // Claude Desktop
  if (process.platform === "win32") {
    if (appdata) {
      const claudeDir = path.join(appdata, "Claude");
      if (fs.existsSync(claudeDir)) {
        targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
      }
    }
  } else if (process.platform === "darwin") {
    const claudeDir = path.join(home, "Library", "Application Support", "Claude");
    if (fs.existsSync(claudeDir)) {
      targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
    }
  } else {
    const claudeDir = path.join(home, ".config", "Claude");
    if (fs.existsSync(claudeDir)) {
      targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
    }
  }

  // Claude Code CLI. Its settings file lives directly at ~/.claude.json with
  // no dedicated directory, so existence of the FILE (not just $HOME) is
  // what tells us the tool has actually been run before.
  const claudeCodeConfig = path.join(home, ".claude.json");
  if (fs.existsSync(claudeCodeConfig)) {
    targets.push({ path: claudeCodeConfig, location: CANONICAL_KEY });
  }

  // Cursor
  if (fs.existsSync(path.join(home, ".cursor"))) {
    targets.push({ path: path.join(home, ".cursor", "mcp.json"), location: CANONICAL_KEY });
  }

  // Windsurf
  if (fs.existsSync(path.join(home, ".codeium", "windsurf"))) {
    targets.push({ path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), location: CANONICAL_KEY });
  }

  return targets;
}

/** The WebSocket/HTTP bridge on :8765 is shared by every agent's copy of
 * this server, but only one process ever binds the port; the rest proxy to
 * it. All of them — and the plugin copies install.mjs bakes a token into —
 * must agree on the SAME token, or the owning process rejects everyone
 * else's requests. Reuse whatever token is already configured anywhere (so
 * an --update doesn't invalidate a plugin the user already has open) before
 * generating a new one. */
function getOrCreateBridgeToken(home, existingTargets) {
  const tokenFile = path.join(home, ".mokido", "bridge_token.txt");
  for (const target of existingTargets) {
    const cfgPath = target.path;
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const token = data?.mcpServers?.figma?.env?.FIGMA_BRIDGE_TOKEN || "";
      if (token) {
        if (!fs.existsSync(tokenFile)) persistBridgeToken(tokenFile, token);
        return token;
      }
    } catch {
      continue;
    }
  }

  // The pre-rename ~/.figma-mcp-bridge file still counts, so moving to
  // ~/.mokido keeps the token an already-open plugin was built with.
  const legacyTokenFile = path.join(home, ".figma-mcp-bridge", "bridge_token.txt");
  for (const file of [tokenFile, legacyTokenFile]) {
    if (!fs.existsSync(file)) continue;
    try {
      const saved = fs.readFileSync(file, "utf-8").trim();
      if (saved) {
        if (file !== tokenFile) persistBridgeToken(tokenFile, saved);
        return saved;
      }
    } catch {
      // try the next file, then generate a new one
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  persistBridgeToken(tokenFile, token);
  return token;
}

function persistBridgeToken(tokenFile, token) {
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token, "utf-8");
  } catch (e) {
    console.log(`[!] Warning: could not persist bridge token to ${tokenFile}: ${e.message}`);
  }
}

function listFilesRelative(root) {
  const result = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.add(path.relative(root, full));
    }
  }
  if (fs.existsSync(root)) walk(root);
  return result;
}

/** Copies src over dst AND removes anything left behind by a previous
 * version (an old optimizer module, a retired schema) that could otherwise
 * still be `require()`-d by whatever else is in the directory.
 *
 * This deliberately never wipes the destination wholesale before copying.
 * An earlier version (in the Python predecessor of this script) did
 * rmtree(dst) then copytree(src, dst), and on Windows that routinely raised
 * a transient permission error mid-delete — a search indexer or antivirus
 * holds a handle open for a moment right after a file's content is gone but
 * before its directory entry can be removed. This is not hypothetical: it
 * reproduced on the very first real test, deleting index.js and every schema
 * out of a live install before failing partway through. Copying new/changed
 * files first (fs.cpSync never needs to remove anything) and only then
 * best-effort-deleting files that genuinely don't exist upstream anymore
 * means the common case — nothing removed upstream — never deletes the
 * destination wholesale, and the rare case degrades to "a stale file
 * survives one more update" instead of "the live install is missing files". */
function copyTreeClean(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });

  const srcFiles = listFilesRelative(src);
  const dstFiles = listFilesRelative(dst);

  for (const rel of dstFiles) {
    if (srcFiles.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(dst, rel));
    } catch (e) {
      console.log(`[!] Warning: could not remove stale file ${path.join(dst, rel)}: ${e.message}`);
    }
  }

  // Clean up any directories that are now empty because their only contents
  // were stale files, deepest first so parents empty out in turn.
  const dirs = [];
  (function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        collect(full);
        dirs.push(full);
      }
    }
  })(dst);
  dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    } catch {
      // not empty (race with something else) or already gone — fine either way
    }
  }
}

/** Bakes the shared bridge token into the installed copy of ui.html. The
 * plugin runs inside Figma's sandboxed iframe with no access to environment
 * variables, so this is the only way it learns the token the server
 * expects. */
function injectBridgeToken(pluginDir, token) {
  const uiPath = path.join(pluginDir, "ui.html");
  if (!fs.existsSync(uiPath)) return;
  let text = fs.readFileSync(uiPath, "utf-8");
  const marker = 'const BRIDGE_TOKEN = "";';
  if (!text.includes(marker)) {
    // Already patched by a previous install, or the source changed shape —
    // don't silently fail to secure the bridge.
    if (/const BRIDGE_TOKEN = "[0-9a-f]{10,}";/.test(text)) return;
    console.log(`[!] Warning: could not find the BRIDGE_TOKEN placeholder in ${uiPath}; plugin will run without a token.`);
    return;
  }
  text = text.replace(marker, `const BRIDGE_TOKEN = "${token}";`);
  fs.writeFileSync(uiPath, text, "utf-8");
}

/** Writes JSON via a temp file + rename so a crash mid-write can never leave
 * the file half-written or truncated. */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file never got created — nothing to clean up
    }
    throw e;
  }
}

/** Best-effort commit hash of the cloned repo this installer is running
 * from. Returns null if it isn't a git checkout (e.g. downloaded as a zip)
 * or git isn't installed — callers must treat null as "unknown", not as a
 * commit that differs from everything. */
function getRepoCommit(pkgRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pkgRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Records which commit an installed copy came from, so the server can
 * later notice when main has moved on. Lives beside figma/ and
 * figma-plugin/, not inside either — it's install metadata, not source. */
function writeVersionMarker(mcpDir, commit) {
  try {
    atomicWriteJson(path.join(mcpDir, "version.json"), { commit, installedAt: new Date().toISOString() });
  } catch (e) {
    console.log(`[!] Warning: could not write version marker in ${mcpDir}: ${e.message}`);
  }
}

function samePath(a, b) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Deletes what install.mjs put into an old install location, and nothing
 * else: ~/.gemini/<app>/mcp/ also holds other MCP servers, and Antigravity
 * keeps its own <tool>.json files inside mcp/figma/ (top-level non-.js files
 * there are left alone). A folder without our version.json or plugin
 * manifest is not ours and is skipped. A plugin copy Figma still loads is
 * refreshed instead of deleted, so the open plugin keeps connecting until it
 * is re-imported from ~/.mokido. Returns true when something was removed. */
function removeLegacyCopy(mcpDir, { keepPlugin = false, pkgRoot = __dirname, bridgeToken = "" } = {}) {
  const figmaDir = path.join(mcpDir, "figma");
  const pluginDir = path.join(mcpDir, "figma-plugin");
  const marker = path.join(mcpDir, "version.json");
  let pluginId = null;
  try { pluginId = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf-8")).id; } catch (e) {}
  if (!fs.existsSync(marker) && pluginId !== PLUGIN_ID) return false;

  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      console.log(`[!] Warning: could not remove ${p}: ${e.message}`);
    }
  };
  if (fs.existsSync(figmaDir)) {
    for (const entry of fs.readdirSync(figmaDir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.name.endsWith(".js")) rm(path.join(figmaDir, entry.name));
    }
    try { if (fs.readdirSync(figmaDir).length === 0) fs.rmdirSync(figmaDir); } catch (e) {}
  }
  if (keepPlugin) {
    copyTreeClean(path.join(pkgRoot, "figma-plugin"), pluginDir);
    injectBridgeToken(pluginDir, bridgeToken);
  } else {
    rm(pluginDir);
  }
  rm(marker);
  try { if (fs.readdirSync(mcpDir).length === 0) fs.rmdirSync(mcpDir); } catch (e) {}
  return true;
}

/** Removes `dir` when it holds nothing but the named leftover files. */
function removeIfOnlyLeftovers(dir, leftovers) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  if (!entries.every((name) => leftovers.includes(name))) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

function installOrUpdate({ token = "", isUpdate = false, home, appdata } = {}) {
  home = home ?? os.homedir();
  appdata = appdata !== undefined ? appdata : process.env.APPDATA;
  const pkgRoot = __dirname;
  const actionStr = isUpdate ? "updated" : "installed";

  // 1. Figure out which config targets exist BEFORE writing anything, so we
  // can look up any already-configured bridge token from them.
  const targets = getConfigTargets(home, appdata);
  if (targets.length === 0) {
    targets.push({ path: path.join(home, ".gemini", "config", "mcp_config.json"), location: CANONICAL_KEY });
  }

  const bridgeToken = getOrCreateBridgeToken(home, targets);

  // 2. Copy the server + plugin into every location referenced by at least
  // one detected config, always including the canonical shared copy.
  const locations = installLocations(home);
  const neededLocations = new Set([...targets.map((t) => t.location), CANONICAL_KEY]);
  const repoCommit = getRepoCommit(pkgRoot);

  const indexJsPaths = {};
  for (const locKey of neededLocations) {
    const mcpDir = locations[locKey];
    const targetFigma = path.join(mcpDir, "figma");
    const targetPlugin = path.join(mcpDir, "figma-plugin");

    copyTreeClean(path.join(pkgRoot, "figma"), targetFigma);
    copyTreeClean(path.join(pkgRoot, "figma-plugin"), targetPlugin);
    injectBridgeToken(targetPlugin, bridgeToken);
    writeVersionMarker(mcpDir, repoCommit);

    indexJsPaths[locKey] = path.join(targetFigma, "index.js").split(path.sep).join("/");
    console.log(`[✓] MCP Server + Plugin ${actionStr} (${locKey}): ${mcpDir}`);
  }

  // 3. Update MCP config files, each pointing at its own server copy.
  const cliToken = token.trim();

  for (const target of targets) {
    const configFile = target.path;
    const indexJsPath = indexJsPaths[target.location];

    let configData = { mcpServers: {} };
    if (fs.existsSync(configFile)) {
      try {
        configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      } catch (e) {
        // A config we cannot parse must NOT be blindly overwritten — writing
        // a fresh {"mcpServers": {"figma": ...}} over it would silently
        // destroy every other MCP server (and any other settings) the user
        // had configured there.
        console.log(
          `[!] Skipping ${configFile}: could not read it (${e.message}). ` +
            `Fix or remove the file, then re-run install.mjs to add the figma server.`
        );
        continue;
      }
    }

    if (typeof configData !== "object" || configData === null || Array.isArray(configData)) {
      console.log(`[!] Skipping ${configFile}: root of the file is not a JSON object.`);
      continue;
    }

    if (typeof configData.mcpServers !== "object" || configData.mcpServers === null || Array.isArray(configData.mcpServers)) {
      configData.mcpServers = {};
    }

    // Preserve existing Figma personal-access-token if a new one wasn't given.
    let finalToken = cliToken;
    const existingFigma = configData.mcpServers.figma;
    if (!finalToken && existingFigma && typeof existingFigma === "object") {
      finalToken = existingFigma.env?.FIGMA_PERSONAL_ACCESS_TOKEN || "";
    }

    configData.mcpServers.figma = {
      command: "node",
      args: [indexJsPath],
      env: {
        FIGMA_PERSONAL_ACCESS_TOKEN: finalToken,
        FIGMA_BRIDGE_TOKEN: bridgeToken,
      },
    };

    try {
      // Back up whatever was there before touching it — this file may hold
      // unrelated settings and other MCP servers.
      if (fs.existsSync(configFile)) {
        fs.copyFileSync(configFile, `${configFile}.bak`);
      }
      atomicWriteJson(configFile, configData);
      console.log(`[✓] MCP Config updated: ${configFile}`);
    } catch (e) {
      console.log(`[!] Failed to write ${configFile}: ${e.message}`);
    }
  }

  // 4. Remove the copies older versions installed, now that no config we
  // wrote points at them.
  const registered = findBridgePluginRegistrations(figmaSettingsPath(home, appdata)) || [];
  for (const [locKey, mcpDir] of Object.entries(legacyLocations(home))) {
    const pluginDir = path.join(mcpDir, "figma-plugin");
    const pluginInUse = registered.some((p) => samePath(path.dirname(p), pluginDir));
    if (removeLegacyCopy(mcpDir, { keepPlugin: pluginInUse, pkgRoot, bridgeToken })) {
      console.log(`[✓] Old copy removed (${locKey}): ${mcpDir}` + (pluginInUse ? " (plugin kept until Figma re-imports it)" : ""));
    }
  }
  for (const cfg of legacyConfigs(home)) {
    if (removeLegacyConfigEntry(cfg)) console.log(`[✓] Unused config cleaned: ${cfg}`);
  }
  removeIfOnlyLeftovers(path.join(home, ".figma-mcp-bridge"), ["bridge_token.txt", "update-check.json"]);

  const canonicalPlugin = path.join(locations[CANONICAL_KEY], "figma-plugin");
  const manifestPath = path.join(canonicalPlugin, "manifest.json");

  console.log("\n==================================================");
  if (isUpdate) {
    console.log("\u{1F389} Mokido successfully updated!");
    console.log("==================================================");
    console.log("1. In Figma: Close and re-open the plugin (or press Ctrl + Alt + P / Cmd + Option + P).");
    console.log("2. In your AI IDE: Restart the session to apply any server changes.");
  } else {
    console.log("\u{1F389} Mokido successfully installed!");
    console.log("==================================================");
    console.log("Next steps:");
    console.log("1. In Figma Desktop:");
    console.log("   - Menu > Plugins > Development > Import plugin from manifest...");
    console.log(`   - Select: ${manifestPath}`);
    console.log("   - Press Ctrl + Alt + P to launch the 'Mokido' plugin.");
    console.log("2. Restart your AI IDE / editor to load the new MCP tools.");
    if (targets.length) {
      console.log("   Detected: " + [...new Set(targets.map((t) => t.location))].sort().join(", "));
    }
  }
  console.log("==================================================");
  reportFigmaPluginRegistration(home, appdata);
}

// ==========================================================================
// Which plugin copy Figma actually runs. Figma Desktop remembers every
// imported dev plugin in its settings.json (localFileExtensions[].manifestPath)
// and loads it from exactly there. Only the copies this installer writes carry
// the bridge token, so a registration pointing anywhere else — typically the
// repository checkout, imported by hand — can never connect. Agents that only
// saw "not connected" have "fixed" that by writing the token into the repo's
// ui.html; saying where Figma looks, and what to import instead, prevents it.
// ==========================================================================
const PLUGIN_ID = "antigravity-figma-bridge";

function figmaSettingsPath(home, appdata) {
  if (process.platform === "win32") return appdata ? path.join(appdata, "Figma", "settings.json") : null;
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Figma", "settings.json");
  return path.join(home, ".config", "Figma", "settings.json"); // unofficial Linux builds
}

/** Manifest paths Figma has registered for this plugin, or null when Figma's
 * settings can't be found/read (Figma not installed, unknown layout). */
function findBridgePluginRegistrations(settingsPath) {
  if (!settingsPath || !fs.existsSync(settingsPath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (e) {
    return null;
  }
  const entries = Array.isArray(data?.localFileExtensions) ? data.localFileExtensions : [];
  const found = [];
  for (const entry of entries) {
    const manifestPath = entry?.manifestPath;
    if (typeof manifestPath !== "string") continue;
    let id = null;
    try { id = JSON.parse(fs.readFileSync(manifestPath, "utf-8")).id; } catch (e) {}
    // A manifest that no longer exists can still be ours if it sat in a figma-plugin/ folder.
    if (id === PLUGIN_ID || (id === null && /figma-plugin[\\/]manifest\.json$/i.test(manifestPath))) {
      found.push(manifestPath);
    }
  }
  return found;
}

/** -> { status: "ok" | "wrong" | "none" | "unknown", registered, wrong, manifest } */
function checkFigmaPluginRegistration(home, appdata) {
  const locations = installLocations(home);
  const manifest = path.join(locations[CANONICAL_KEY], "figma-plugin", "manifest.json");
  const registered = findBridgePluginRegistrations(figmaSettingsPath(home, appdata));
  if (registered === null) return { status: "unknown", registered: [], wrong: [], manifest };
  if (registered.length === 0) return { status: "none", registered, wrong: [], manifest };
  const installedDirs = Object.values(locations).map((dir) => path.join(dir, "figma-plugin"));
  const legacyDirs = Object.values(legacyLocations(home)).map((dir) => path.join(dir, "figma-plugin"));
  const isIn = (dirs) => (p) => dirs.some((d) => samePath(path.dirname(p), d));
  const wrong = registered.filter((p) => !isIn(installedDirs)(p));
  const legacy = wrong.filter(isIn(legacyDirs));
  return { status: wrong.length ? "wrong" : "ok", registered, wrong, legacy, manifest };
}

function reportFigmaPluginRegistration(home, appdata) {
  const reg = checkFigmaPluginRegistration(home, appdata);
  if (reg.status === "wrong") {
    for (const p of reg.wrong) {
      console.log(`[!] Figma loads the 'Mokido' plugin from ${p}`);
    }
    if (reg.legacy.length === reg.wrong.length) {
      console.log("    That is the old install folder: it still works, but the next updates go to ~/.mokido.");
    } else {
      console.log("    That copy was not written by install.mjs, so it has no bridge token and cannot connect.");
    }
    console.log("    In Figma: Plugins > Development > Import plugin from manifest... >");
    console.log(`      ${reg.manifest}`);
    console.log("    then remove the old entry. Never paste the token into that copy's ui.html.");
  } else if (reg.status === "ok") {
    console.log(`[✓] Figma runs the installed plugin copy: ${reg.registered.join(", ")}`);
  } else if (reg.status === "none") {
    console.log(`[*] Figma has no 'Mokido' plugin imported yet — import ${reg.manifest}`);
  }
  return reg;
}

function runDoctor(home, appdata) {
  console.log("==================================================");
  console.log("\u{1FA7A} Mokido Diagnostic Report");
  console.log("==================================================");
  checkNodeVersion();
  home = home ?? os.homedir();
  appdata = appdata !== undefined ? appdata : process.env.APPDATA;
  const locations = installLocations(home);

  for (const [locKey, mcpDir] of Object.entries(locations)) {
    const targetFigma = path.join(mcpDir, "figma");
    const targetPlugin = path.join(mcpDir, "figma-plugin");
    console.log(`[*] [${locKey}] Server Path: ${targetFigma} ${fs.existsSync(targetFigma) ? "[EXISTS]" : "[NOT INSTALLED]"}`);
    console.log(`[*] [${locKey}] Plugin Path: ${targetPlugin} ${fs.existsSync(targetPlugin) ? "[EXISTS]" : "[NOT INSTALLED]"}`);
  }
  for (const [locKey, mcpDir] of Object.entries(legacyLocations(home))) {
    if (fs.existsSync(path.join(mcpDir, "figma", "index.js")) || fs.existsSync(path.join(mcpDir, "figma-plugin"))) {
      console.log(`[!] [${locKey}] Old copy still on disk: ${mcpDir} (run install.mjs --update to remove it)`);
    }
  }

  const configs = getConfigTargets(home, appdata);
  console.log("\n[*] Detected MCP Config Targets:");
  if (configs.length === 0) {
    console.log("  (none detected — run install.mjs to create one)");
  }
  for (const target of configs) {
    const cfg = target.path;
    if (fs.existsSync(cfg)) {
      try {
        const d = JSON.parse(fs.readFileSync(cfg, "utf-8"));
        const figmaEntry = d?.mcpServers?.figma || {};
        const hasFigma = Object.keys(figmaEntry).length > 0;
        const pat = figmaEntry.env?.FIGMA_PERSONAL_ACCESS_TOKEN || "";
        const bridgeTok = figmaEntry.env?.FIGMA_BRIDGE_TOKEN || "";
        const tokStatus = pat ? "PAT configured" : "no PAT (Live canvas only)";
        const bridgeStatus = bridgeTok ? "bridge token set" : "NO bridge token (insecure)";
        console.log(`  - ${cfg} [${target.location}] (figma entry: ${hasFigma ? "YES" : "NO"}, ${tokStatus}, ${bridgeStatus})`);
      } catch (e) {
        console.log(`  - ${cfg} (Error reading: ${e.message})`);
      }
    } else {
      console.log(`  - ${cfg} [NOT CREATED YET]`);
    }
  }
  console.log("\n[*] Figma plugin registration:");
  if (reportFigmaPluginRegistration(home, appdata).status === "unknown") {
    console.log("  (Figma Desktop settings not found — import the plugin manually)");
  }
  console.log("==================================================");
}

/** Only one server process owns :8765 (the "master"); the others proxy to it.
 * A master started before this --update keeps running the old code from
 * memory, so the plugin keeps saying "Update needed" although the files on
 * disk are new. Ask the running master for its version and say which
 * process to restart. fetchStatus/findPid are injectable for tests. */
async function checkRunningServer({ port = 8765, token = "", expectedVersion = "", fetchStatus, findPid } = {}) {
  fetchStatus = fetchStatus || (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: token ? { "X-Bridge-Token": token } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { httpStatus: res.status };
    return res.json();
  });
  findPid = findPid || (() => findListeningPid(port));
  let status;
  try {
    status = await fetchStatus();
  } catch {
    return { status: "none" };
  }
  if (!status || !status.serverVersion) return { status: "unknown", httpStatus: status && status.httpStatus };
  const version = status.serverVersion;
  if (!expectedVersion || version === expectedVersion) return { status: "ok", version };
  let pid = status.pid || null;
  if (!pid) {
    try { pid = findPid() || null; } catch { pid = null; }
  }
  return { status: "stale", version, pid };
}

/** PID listening on the port, best effort (masters before 4.4.0 don't report it in /status). */
function findListeningPid(port) {
  if (process.platform === "win32") {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(":" + port) && cols[3] === "LISTENING") return Number(cols[4]) || null;
    }
    return null;
  }
  const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return Number(out.trim().split(/\s+/)[0]) || null;
}

function reportRunningServer(result, expectedVersion) {
  if (result.status === "stale") {
    console.log(`[!] A Mokido server v${result.version} is still running${result.pid ? ` (PID ${result.pid})` : ""} and holds port 8765;`);
    console.log(`    it was started before this update, so the plugin will report it instead of v${expectedVersion}.`);
    console.log("    Restart the MCP server in the agent session that started it (Claude Code: /mcp > figma > Reconnect),");
    console.log(`    or close that session${result.pid ? `, or stop the process: ${process.platform === "win32" ? `taskkill /PID ${result.pid}` : `kill ${result.pid}`}` : ""}.`);
  } else if (result.status === "ok") {
    console.log(`[✓] Running server on port 8765 is v${result.version}`);
  }
}

function parseArgs(argv) {
  const args = { token: "", update: false, doctor: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") {
      args.token = argv[++i] || "";
    } else if (a.startsWith("--token=")) {
      args.token = a.slice("--token=".length);
    } else if (a === "--update") {
      args.update = true;
    } else if (a === "--doctor") {
      args.doctor = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.doctor) {
    runDoctor();
    return;
  }

  console.log("==================================================");
  console.log(`⚡ ${args.update ? "Updating" : "Installing"} Mokido + Visual Feedback Loop`);
  console.log("==================================================");

  checkNodeVersion();
  installOrUpdate({ token: args.token, isUpdate: args.update });
  const tokenFile = path.join(os.homedir(), ".mokido", "bridge_token.txt");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf-8").trim() : "";
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8")).version;
  reportRunningServer(await checkRunningServer({ token, expectedVersion }), expectedVersion);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}

export {
  CANONICAL_KEY,
  installLocations,
  legacyLocations,
  removeLegacyCopy,
  checkNodeVersion,
  getConfigTargets,
  getOrCreateBridgeToken,
  copyTreeClean,
  injectBridgeToken,
  atomicWriteJson,
  getRepoCommit,
  writeVersionMarker,
  installOrUpdate,
  runDoctor,
  parseArgs,
  figmaSettingsPath,
  findBridgePluginRegistrations,
  checkFigmaPluginRegistration,
  checkRunningServer,
  findListeningPid,
};
