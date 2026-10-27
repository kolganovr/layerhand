// T-067: the server must not outlive its MCP session. Run:
// node tests/exit-with-session.test.js
//
// 1. stdin end -> exit (the normal "client closed the session" case).
// 2. Parent dies while our stdin pipe is still open (held by the grandparent,
//    i.e. this test) -> the ppid watchdog exits the server.
// 3. Control: same as 2 with the watchdog off -> the server survives its parent,
//    so case 2 really exercises the watchdog, not stdin end. Then stdin end
//    still stops it.
// Each server gets its own FIGMA_BRIDGE_PORT so a live bridge on :8765 is untouched.
const path = require("path");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "figma", "index.js");
let failures = 0;
let nextPort = 18900 + Math.floor(Math.random() * 500);

function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function waitGone(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(pid)) return Date.now() - t0;
    await sleep(50);
  }
  return -1;
}

function serverEnv(extra) {
  return {
    ...process.env,
    FIGMA_MCP_NO_UPDATE_CHECK: "1",
    FIGMA_BRIDGE_PORT: String(nextPort++),
    ...extra
  };
}

async function stdinEnd() {
  const child = spawn(process.execPath, [SERVER_PATH], { env: serverEnv(), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  // Wait for a real response so the server is fully up before we hang up.
  const ready = new Promise((r) => child.stdout.once("data", r));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await Promise.race([ready, sleep(4000)]);
  const t0 = Date.now();
  child.stdin.end();
  const code = await Promise.race([exited, sleep(2000).then(() => "timeout")]);
  check("stdin end -> server exits within 2 s", code === 0, `exit=${code} after ${Date.now() - t0} ms`);
  if (code === "timeout") child.kill();
}

// The middle process spawns the server with stdin inherited from us (so the
// pipe stays open after the middle dies), prints the server pid and exits.
// detached: libuv on Windows otherwise puts the server in the middle's
// kill-on-close job object and the OS would kill it for us.
const MIDDLE = `
const { spawn } = require("child_process");
const s = spawn(process.execPath, [${JSON.stringify(SERVER_PATH)}], {
  stdio: ["inherit", "ignore", "ignore"], detached: true, windowsHide: true
});
s.unref();
process.stdout.write(String(s.pid) + "\\n");
setTimeout(() => process.exit(0), 1200);
`;

// The pipe can't be middle.stdin: Node destroys a child's stdin when the child
// exits, which would hang up on the server and test stdin end instead. A
// separate holder process owns the write end and writes nothing; killing it
// is the "client hung up" event.
async function orphan(parentCheckMs) {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: ["ignore", "pipe", "ignore"] });
  holder.stdout.pause();
  const middle = spawn(process.execPath, ["-e", MIDDLE], {
    env: serverEnv({ FIGMA_MCP_PARENT_CHECK_MS: String(parentCheckMs) }),
    stdio: [holder.stdout, "pipe", "inherit"]
  });
  const pid = await new Promise((resolve, reject) => {
    let out = "";
    middle.stdout.on("data", (c) => { out += c; if (out.includes("\n")) resolve(parseInt(out, 10)); });
    setTimeout(() => reject(new Error("middle did not report the server pid")), 4000);
  });
  await new Promise((r) => middle.on("exit", r));
  return { pid, hangUp: () => holder.kill() };
}

(async () => {
  console.log("exit-with-session (T-067)");
  await stdinEnd();

  {
    const { pid, hangUp } = await orphan(300);
    const aliveAfterParent = alive(pid);
    const gone = await waitGone(pid, 3000);
    check("parent dies, stdin still open -> watchdog exits the server", gone >= 0,
      `server ${pid} still alive 3 s after its parent died (alive right after: ${aliveAfterParent})`);
    if (gone < 0) try { process.kill(pid); } catch (e) {}
    hangUp();
  }

  {
    const { pid, hangUp } = await orphan(0);
    await sleep(1500);
    check("control: watchdog off -> server survives its parent", alive(pid), "server exited without the watchdog, case 2 proves nothing");
    hangUp();
    const gone = await waitGone(pid, 3000);
    check("control: then stdin end (inherited pipe) -> server exits", gone >= 0, `server ${pid} still alive`);
    if (gone < 0) try { process.kill(pid); } catch (e) {}
  }

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
