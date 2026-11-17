import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, statSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// Hooks and the MCP server run as separate processes; this lock keeps their audio from overlapping
const LOCK_FILE = join(tmpdir(), "voicevox-play.lock");
const MAX_WAIT_MS = 120000;
const POLL_MS = 100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tryAcquire(token) {
  try {
    writeFileSync(LOCK_FILE, token, { flag: "wx" });
    return true;
  } catch {}
  // A lock older than the wait limit was left behind by a crashed process
  try {
    if (Date.now() - statSync(LOCK_FILE).mtimeMs > MAX_WAIT_MS) unlinkSync(LOCK_FILE);
  } catch {}
  return false;
}

function release(token) {
  try {
    if (readFileSync(LOCK_FILE, "utf8") === token) unlinkSync(LOCK_FILE);
  } catch {}
}

// Run fn while holding the playback lock; after MAX_WAIT_MS, run it anyway
export async function withPlayLock(fn) {
  const token = randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;
  let acquired = tryAcquire(token);
  while (!acquired && Date.now() < deadline) {
    await sleep(POLL_MS);
    acquired = tryAcquire(token);
  }
  try {
    return await fn();
  } finally {
    if (acquired) release(token);
  }
}

export function playFile(filepath) {
  if (platform() === "darwin") {
    spawnSync("afplay", [filepath], { stdio: "ignore" });
    return;
  }
  for (const args of [["paplay", filepath], ["aplay", filepath], ["mpv", "--no-video", filepath]]) {
    if (spawnSync("which", [args[0]], { stdio: "ignore" }).status === 0) {
      spawnSync(args[0], args.slice(1), { stdio: "ignore" });
      break;
    }
  }
}

export function play(filepath) {
  return withPlayLock(() => playFile(filepath));
}
