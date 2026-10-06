import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, statSync } from "fs";
import { homedir, tmpdir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICEVOX_HOST = "http://localhost:50021";
const DEFAULT_SPEED = 1.3;
const SPEAKERS_DIR = join(__dirname, "..", "speakers");

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function resolveCurrentSpeaker(cwd) {
  const paths = [];
  if (cwd) paths.push(join(cwd, ".claude", "settings.voicevox.json"));
  paths.push(join(homedir(), ".claude", "settings.voicevox.json"));
  for (const p of paths) {
    const speaker = readJson(p)?.voicevox?.current_speaker;
    if (speaker) return speaker;
  }
  return "zundamon";
}

function loadSpeakerConfig(name) {
  return readJson(join(SPEAKERS_DIR, `${name}.json`)) ?? {
    styles: [{ id: 1, name: "ノーマル", default: true }],
    notifications: {
      default: "通知", task_complete: "タスク完了",
      permission_needed: "許可が必要", question: "質問がある",
      tool_permission: "{tool}の許可が必要"
    }
  };
}

function getDefaultSpeakerId(config) {
  const styles = config.styles ?? [];
  return (styles.find(s => s.default) ?? styles[0])?.id ?? 1;
}

function extractSessionTitle(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "Claude Code";
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === "summary" && data.summary) return data.summary;
      } catch {}
    }
    const parts = transcriptPath.split("/").slice(-2)[0].split("-");
    if (parts.length > 0) return parts[parts.length - 1];
  } catch {}
  return "Claude Code";
}

function extractSpeakerIdFromText(text) {
  const lines = text.trimEnd().split("\n");
  const m = lines[lines.length - 1]?.trim().match(/^\(?speaker_id:\s*(\d+)\)?$/);
  return m ? parseInt(m[1]) : null;
}

function removeSpeakerIdLine(text) {
  const lines = text.trimEnd().split("\n");
  if (/^\(?speaker_id:\s*\d+\)?$/.test(lines[lines.length - 1]?.trim())) {
    return lines.slice(0, -1).join("\n").trimEnd();
  }
  return text;
}

function extractLastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [null, null];
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type !== "assistant") continue;
        for (const block of data.message?.content ?? []) {
          if (block.type !== "text") continue;
          const fullText = block.text?.trim();
          if (!fullText) continue;
          const speakerId = extractSpeakerIdFromText(fullText);
          const firstLine = removeSpeakerIdLine(fullText).split("\n")[0];
          if (firstLine) return [firstLine, speakerId];
        }
      } catch {}
    }
  } catch {}
  return [null, null];
}

// Find the latest tool_use that has no tool_result yet (the one awaiting permission)
function extractPendingToolName(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).reverse();
    const resolved = new Set();
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const blocks = data.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const block of [...blocks].reverse()) {
          if (block.type === "tool_result") resolved.add(block.tool_use_id);
          if (block.type === "tool_use" && !resolved.has(block.id)) {
            // mcp__server__tool -> tool
            return block.name?.split("__").pop() || null;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForPendingToolName(transcriptPath) {
  // The tool_use may take a moment to be flushed to the transcript
  for (let i = 0; i < 10; i++) {
    const tool = extractPendingToolName(transcriptPath);
    if (tool) return tool;
    await sleep(200);
  }
  return null;
}

// Parallel tool calls fire several permission notifications at once; speak only the first
const PERMISSION_DEBOUNCE_MS = 2000;

function acquirePermissionNotifyLock(sessionId) {
  const lockFile = join(tmpdir(), `voicevox-permission.${sessionId || "default"}.lock`);
  try {
    writeFileSync(lockFile, "", { flag: "wx" });
    return true;
  } catch {}
  try {
    if (Date.now() - statSync(lockFile).mtimeMs < PERMISSION_DEBOUNCE_MS) return false;
    unlinkSync(lockFile);
    writeFileSync(lockFile, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function processHookMessage(hookEvent, message, lastAssistantMessage, transcriptPath, notifications) {
  if (hookEvent === "Stop") {
    // last_assistant_message is always the latest; the transcript may not be flushed yet
    const latest = lastAssistantMessage?.trim();
    if (latest) return removeSpeakerIdLine(latest).split("\n")[0];
    const [transcriptMsg] = extractLastAssistantMessage(transcriptPath);
    return transcriptMsg ?? notifications.task_complete ?? "タスク完了";
  }

  if (hookEvent === "Notification") {
    if (!message) return notifications.permission_needed ?? "許可が必要";
    if (message.startsWith("Claude needs your permission")) {
      // Newer versions omit the tool name, so fall back to the pending tool_use in the transcript
      const tool = message.match(/^Claude needs your permission to use\s+(.+?)\.?$/)?.[1]
        ?? await waitForPendingToolName(transcriptPath);
      if (!tool) return notifications.permission_needed ?? "許可が必要";
      return (notifications.tool_permission ?? "{tool}の許可が必要").replace("{tool}", tool);
    }
    if (message.startsWith("Claude is waiting")) process.exit(0);
    if (message.startsWith("Claude has a question")) return notifications.question ?? "質問がある";
    if (message.startsWith("Claude wants to")) return notifications.permission_needed ?? "許可が必要";
    if (message.startsWith("Claude Code needs your attention")) {
      const [q] = extractLastAssistantMessage(transcriptPath);
      return q || (notifications.question ?? "質問がある");
    }
    if (message.startsWith("Claude Code needs your approval")) return notifications.permission_needed ?? "許可が必要";
    return message;
  }

  return message || (notifications.default ?? "通知");
}

async function synthesizeAndPlay(text, speakerId, speed) {
  const tmpFile = join(tmpdir(), `voicevox.${process.pid}.${randomUUID()}.wav`);
  try {
    const queryResp = await fetch(
      `${VOICEVOX_HOST}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: "POST", signal: AbortSignal.timeout(10000) }
    );
    if (!queryResp.ok) { process.stderr.write(`VOICEVOX audio_query failed: ${queryResp.status}\n`); return; }

    const query = await queryResp.json();
    query.speedScale = speed;

    const synthResp = await fetch(`${VOICEVOX_HOST}/synthesis?speaker=${speakerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30000)
    });
    if (!synthResp.ok) { process.stderr.write(`VOICEVOX synthesis failed: ${synthResp.status}\n`); return; }

    writeFileSync(tmpFile, Buffer.from(await synthResp.arrayBuffer()));

    if (platform() === "darwin") {
      spawnSync("afplay", [tmpFile], { stdio: "ignore" });
    } else {
      for (const args of [["paplay", tmpFile], ["aplay", tmpFile], ["mpv", "--no-video", tmpFile]]) {
        if (spawnSync("which", [args[0]], { stdio: "ignore" }).status === 0) {
          spawnSync(args[0], args.slice(1), { stdio: "ignore" });
          break;
        }
      }
    }
  } catch (e) {
    const msg = e?.cause?.code === "ECONNREFUSED" ? "Cannot connect to VOICEVOX" : e.message;
    process.stderr.write(`${msg}\n`);
  } finally {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
}

function showNotification(title, message) {
  if (platform() === "darwin") {
    spawnSync("terminal-notifier", ["-title", title, "-message", message, "-ignoreDnD"], { stdio: "ignore" });
  } else if (spawnSync("which", ["notify-send"], { stdio: "ignore" }).status === 0) {
    spawnSync("notify-send", [title, message], { stdio: "ignore" });
  }
}

// Main
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", async () => {
  let input = {};
  try { input = JSON.parse(data); } catch {}

  try { appendFileSync("/tmp/voicevox-debug.log", JSON.stringify(input) + "\n"); } catch {}

  const { hook_event_name: hookEvent = "", message, last_assistant_message: lastAssistantMessage, transcript_path: transcriptPath, cwd, session_id: sessionId } = input;

  if (hookEvent === "Notification" && message?.startsWith("Claude needs your permission")
      && !acquirePermissionNotifyLock(sessionId)) process.exit(0);

  const speakerName = resolveCurrentSpeaker(cwd);
  const config = loadSpeakerConfig(speakerName);
  const notifications = config.notifications ?? {};

  let speakerId = getDefaultSpeakerId(config);

  const text = await processHookMessage(hookEvent, message, lastAssistantMessage, transcriptPath, notifications);

  // Stop events carry the latest message; other events fall back to the transcript
  const [, transcriptSpeakerId] = hookEvent === "Stop" && lastAssistantMessage
    ? [null, extractSpeakerIdFromText(lastAssistantMessage)]
    : extractLastAssistantMessage(transcriptPath);
  if (transcriptSpeakerId !== null) speakerId = transcriptSpeakerId;

  const title = extractSessionTitle(transcriptPath);

  showNotification(title, text);
  await synthesizeAndPlay(text, speakerId, DEFAULT_SPEED);
});
