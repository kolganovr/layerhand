// Contract test for the plugin UI state machine. Run: node tests/ui-state.test.js
// Extracts the pure <script id="mk-state"> block out of figma-plugin/ui.html and
// checks "signals -> state" (SPEC section 1), texts, compact auto-expand and the
// markup invariants (token placeholder, hex only in the token block).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "figma-plugin", "ui.html"), "utf8").replace(/\r\n/g, "\n");
const block = /<script id="mk-state">([\s\S]*?)<\/script>/.exec(html);
if (!block) throw new Error("mk-state block not found in ui.html");
const MK = new Function(block[1] + "\nreturn MK;")();

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const NOW = 1_000_000_000;
function model(over) {
  return Object.assign({
    ws: "open", attempts: 0, httpStatus: null, status: { serverVersion: "4.3.0", targets: [] }, myClientId: null,
    active: new Map(), lastResult: null, failDismissed: true, lastDone: null, paused: false,
    doc: { fileName: "Mokido", pageName: "Screens" }
  }, over || {});
}
function cmd(ageMs, extra) {
  return Object.assign({ desc: "Create pricing card", kind: "EXECUTE", isCapture: false, startedAt: NOW - ageMs, lastProgressAt: 0 }, extra || {});
}
const active = (...entries) => new Map(entries.map((e, i) => ["c" + i, e]));

console.log("\n== deriveState: SPEC 1, first matching row wins ==");
const table = [
  ["start of the plugin = connecting (U-01)", model({ ws: "connecting", attempts: 0 }), "connecting"],
  ["two failed attempts still connecting", model({ ws: "closed", attempts: 2, httpStatus: "fail" }), "connecting"],
  ["3 failures + /status 403 = token_mismatch", model({ ws: "closed", attempts: 3, httpStatus: "403" }), "token_mismatch"],
  ["3 failures + /status silent = offline", model({ ws: "closed", attempts: 3, httpStatus: "fail" }), "offline"],
  ["3 failures, /status not probed yet = offline", model({ ws: "closed", attempts: 4, httpStatus: null }), "offline"],
  ["3 failures but /status answers = connecting", model({ ws: "closed", attempts: 3, httpStatus: "ok" }), "connecting"],
  ["paused beats work", model({ paused: true, active: active(cmd(1000)) }), "paused"],
  ["no progress for > 120 s = stalled", model({ active: active(cmd(130000)) }), "stalled"],
  ["recent progress keeps a 130 s job out of stalled", model({ active: active(cmd(130000, { lastProgressAt: NOW - 5000 })) }), "long_job"],
  ["older than 45 s = long_job", model({ active: active(cmd(50000)) }), "long_job"],
  ["long_job beats queued", model({ active: active(cmd(50000), cmd(1000)) }), "long_job"],
  ["two commands = queued", model({ active: active(cmd(2000), cmd(1000)) }), "queued"],
  ["one screenshot = capturing", model({ active: active(cmd(1000, { isCapture: true })) }), "capturing"],
  ["one command = working", model({ active: active(cmd(1000)) }), "working"],
  ["server limits override the defaults", model({ status: { targets: [], limits: { escalateMs: 500, stalledAfterMs: 900 } }, active: active(cmd(1000)) }), "stalled"],
  ["other file focused = other_target", model({ myClientId: "ws_a", status: { targets: [{ id: "ws_a", fileName: "Mokido", focused: false }, { id: "ws_b", fileName: "Checkout", focused: true }] } }), "other_target"],
  ["this file focused = ready", model({ myClientId: "ws_a", status: { targets: [{ id: "ws_a", focused: true }, { id: "ws_b", focused: false }] } }), "ready"],
  ["old server without CLIENT_ACK: match by unique fileName", model({ status: { targets: [{ id: "x", fileName: "Mokido", focused: false }, { id: "y", fileName: "B", focused: true }] } }), "other_target"],
  ["failed result not dismissed = last_failed", model({ lastResult: { success: false, error: "boom" }, failDismissed: false }), "last_failed"],
  ["dismissed failure = ready", model({ lastResult: { success: false, error: "boom" }, failDismissed: true }), "ready"],
  ["work beats last_failed", model({ lastResult: { success: false }, failDismissed: false, active: active(cmd(1000)) }), "working"],
  ["connected and idle = ready", model(), "ready"]
];
for (const [name, m, want] of table) {
  const got = MK.deriveState(m, NOW);
  check(name, got === want, { got, want });
}

console.log("\n== viewModel: texts and parts per state ==");
const vm = (m, opts) => MK.viewModel(m, NOW, Object.assign({ pluginVersion: "4.3.0", serverUrl: "http://127.0.0.1:9000" }, opts || {}));
check("connecting shows the configured host:port (U-02)", vm(model({ ws: "connecting" })).body.includes("127.0.0.1:9000"));
check("no install.py anywhere in the UI (U-13)", !html.includes("install.py"));
const off = vm(model({ ws: "closed", attempts: 3, httpStatus: "fail", retryAt: NOW + 6000 }));
check("offline: Retry now + Copy command", off.buttons.map(b => b.action).join() === "retry,copyDoctor", off.buttons);
check("offline: footer is the retry line", off.footer === "Retrying in 6 s · attempt 4", off.footer);
check("offline: Moki asleep, dimmed, Zzz", off.mood === "asleep" && off.dim && off.zzz);
check("offline: header says Not connected", off.context === "Not connected");
check("token_mismatch without a token says it is the source copy", vm(model({ ws: "closed", attempts: 3, httpStatus: "403" })).body.startsWith("This is the source copy"));
check("token_mismatch with a token says reopen", vm(model({ ws: "closed", attempts: 3, httpStatus: "403" }), { hasToken: true }).body.startsWith("Close and reopen"));
const work = vm(model({ active: active(cmd(2000, { step: 2, of: 4, note: "building variants" })) }), { undoLeft: 2 });
check("working: step line, determinate progress", work.extra === "Step 2 of 4 · building variants" && Math.abs(work.progress.value - 0.5) < 1e-9, work);
check("working: Pause + Undo · 2 left", work.buttons.map(b => b.label).join() === "Pause,Undo · 2 left", work.buttons);
check("working without PROGRESS: indeterminate bar (U-07)", vm(model({ active: active(cmd(1000)) })).progress.indeterminate === true);
check("working: task description max 2 lines", work.bodyLines === 2);
check("working: no Undo when nothing to undo", vm(model({ active: active(cmd(1000)) })).buttons.length === 1);
check("queued title counts the others", vm(model({ active: active(cmd(3000), cmd(2000), cmd(1000)) })).title === "Working · 2 more queued");
check("long_job body carries seconds", vm(model({ active: active(cmd(65000)) })).body === "Create pricing card · 65 s. Your agent checks back on it - no need to wait here.");
check("stalled badge carries seconds", vm(model({ active: active(cmd(125000)) })).badge === "Stuck · 125 s");
const fail = vm(model({ lastResult: { success: false, description: "Create pricing card", error: "Cannot read properties of null", code: "EXECUTION_ERROR" }, failDismissed: false }));
check("last_failed: description: error + code", fail.body === "Create pricing card: Cannot read properties of null" && fail.code === "EXECUTION_ERROR");
check("last_failed: Copy error + Dismiss, sad Moki with error dot", fail.buttons.map(b => b.action).join() === "copyError,dismiss" && fail.errorDot && fail.mood === "sad");
check("ready: context page · file, ready text", vm(model()).context === "Screens · Mokido" && vm(model()).body === "Ask your agent to do something in this file.");
check("trace: Done: desc · N min ago", vm(model({ lastDone: { desc: "Rename layers", ok: true, at: NOW - 5 * 60000 } })).footer === "Done: Rename layers · 5 min ago");
check("no previous action: no footer (E12)", vm(model()).footer === "");
check("paused: Resume, compact shows Resume", vm(model({ paused: true })).buttons[0].action === "resume" && vm(model({ paused: true })).resume);

console.log("\n== version_mismatch pill (SPEC 8 E6) ==");
const mm = model({ status: { serverVersion: "4.4.0", targets: [] } });
check("major.minor differ: pill closed", vm(mm).pill && vm(mm).pill.open === false && vm(mm).title === "Connected to your agent");
check("patch differs only: no pill", !vm(model({ status: { serverVersion: "4.3.7", targets: [] } })).pill);
const open = vm(mm, { pillOpen: true });
check("open pill takes over the bubble", open.title === "Plugin v4.3.0 and server v4.4.0 don't match" && open.buttons.map(b => b.action).join() === "copyUpdate,dismissVersion", open);
check("dismissed until restart", !vm(mm, { versionDismissed: true }).pill);

console.log("\n== Russian texts (SPEC 5.1) ==");
const ru = (m, o) => vm(m, Object.assign({ lang: "ru" }, o));
check("RU ready", ru(model()).title === "Агент подключён" && ru(model()).body === "Попросите агента что-нибудь сделать в этом файле.");
check("RU offline buttons and retry", ru(off.state ? model({ ws: "closed", attempts: 3, retryAt: NOW + 6000 }) : null).buttons.map(b => b.label).join() === "Повторить,Копировать команду");
check("RU retry line", ru(model({ ws: "closed", attempts: 3, retryAt: NOW + 6000 })).footer === "Повтор через 6 с · попытка 4");
check("RU context offline", ru(model({ ws: "closed" })).context === "Нет подключения");
check("RU undo", ru(model({ active: active(cmd(1000)) }), { undoLeft: 3 }).buttons[1].label === "Отменить · осталось 3");
check("RU ago", MK.ago(0, "ru") === "только что" && MK.ago(3 * 3600000, "ru") === "3 ч назад");
for (const lang of ["en", "ru"]) {
  const t = MK.texts(lang);
  const states = ["connecting", "ready", "working", "capturing", "queued", "long_job", "stalled", "paused", "last_failed", "offline", "token_mismatch", "other_target"];
  check(`${lang}: every state has a title and a badge`, states.every(s => t.title[s] && t.badge[s]), states.filter(s => !t.title[s] || !t.badge[s]));
}
const keysEn = Object.keys(MK.texts("en").settings), keysRu = Object.keys(MK.texts("ru").settings);
check("settings texts: same keys in EN and RU", keysEn.join() === keysRu.join(), keysEn.filter(k => !keysRu.includes(k)));
const used = Array.from(html.matchAll(/data-t="([\w.]+)"/g)).map(m => m[1]);
check("every data-t key in the markup has a text", used.every(k => MK.texts("en").settings[k]), used.filter(k => !MK.texts("en").settings[k]));

console.log("\n== compact auto-expand (SPEC 3) and helpers ==");
check("entering stalled / last_failed / token_mismatch always expands", ["stalled", "last_failed", "token_mismatch"].every(s => MK.autoExpand("working", s) === "always"));
check("offline expands once", MK.autoExpand("ready", "offline") === "once");
check("working never expands", MK.autoExpand("ready", "working") === null);
check("staying in a state does not re-expand", MK.autoExpand("last_failed", "last_failed") === null);
check("backoff 1.5 -> 3 -> 6 -> 10 s ceiling (U-17)", [1, 2, 3, 4, 9].map(MK.backoff).join() === "1500,3000,6000,10000,10000");
check("server url validation", MK.validServerUrl("http://127.0.0.1:8765") && MK.validServerUrl("http://localhost:9000/") && !MK.validServerUrl("127.0.0.1:8765") && !MK.validServerUrl("http://a b:1"));

console.log("\n== markup invariants ==");
check("BRIDGE_TOKEN placeholder is empty", html.includes('const BRIDGE_TOKEN = "";'));
const tokens = /\/\* mk-tokens:begin[\s\S]*?\/\* mk-tokens:end \*\//.exec(html);
check("token block is generated", tokens && tokens[0].includes("--mk-bg:") && tokens[0].includes("html.figma-dark"));
const outside = html.replace(tokens ? tokens[0] : "", "");
check("no hex colour outside the token block", !/#[0-9a-fA-F]{6}\b/.test(outside), (outside.match(/#[0-9a-fA-F]{6}\b/g) || []).slice(0, 5));
check("port only in defaults", (outside.match(/8765/g) || []).length <= 3, (outside.match(/.{30}8765.{10}/g) || []));
check("no Google Fonts (U-18)", !/fonts\.googleapis/.test(html));
check("no log tab leftovers (SPEC 7)", !/log-list|logLimit|captureScale|compactPreset/.test(outside.replace(/old compactPreset \/ captureScale \/ logLimit/, "")));

console.log(failures ? `\nFAILURES: ${failures} (passed ${passed})` : `\nALL PASS (${passed} checks passed)`);
process.exit(failures ? 1 : 0);
