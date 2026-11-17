import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { play, withPlayLock, playFile } from "./play.js";

const VOICEVOX_HOST = "http://localhost:50021";

const server = new Server(
  { name: "voicevox", version: "1.1.6" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "get_voices",
    description: "Get available voices from VOICEVOX.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "speak",
    description: "Convert text to speech using VOICEVOX and optionally play it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        speaker_id: { type: "number", description: "Speaker ID (voice). Default is 1.", default: 1 },
        speed: { type: "number", description: "Playback speed. Default is 1.3.", default: 1.3 },
        auto_play: { type: "boolean", description: "Whether to automatically play the generated audio. Default is true.", default: true }
      },
      required: ["text"]
    }
  },
  {
    name: "speak_a_lot",
    description: "Convert multiple texts to speech and play them seamlessly. Synthesizes the next audio while the current one is playing (pipeline), so there is almost no gap between sentences.",
    inputSchema: {
      type: "object",
      properties: {
        texts: { type: "array", items: { type: "string" }, description: "List of texts to convert to speech" },
        speaker_id: { type: "number", description: "Speaker ID (voice). Default is 1.", default: 1 },
        speed: { type: "number", description: "Playback speed. Default is 1.3.", default: 1.3 },
        auto_play: { type: "boolean", description: "Whether to automatically play the generated audio. Default is true.", default: true }
      },
      required: ["texts"]
    }
  },
  {
    name: "sing",
    description: 'Synthesize singing voice from a musical score using VOICEVOX. score.notes: [{key: MIDI_NUMBER|null, frame_length: int, lyric: str}]. key=null for silence. First and last notes should be silence.',
    inputSchema: {
      type: "object",
      properties: {
        score: {
          type: "object",
          properties: {
            notes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: ["number", "null"] },
                  frame_length: { type: "number" },
                  lyric: { type: "string" }
                },
                required: ["key", "frame_length", "lyric"]
              }
            }
          },
          required: ["notes"]
        },
        speaker_id: { type: "number", description: "Singer ID. Default is 6000.", default: 6000 },
        auto_play: { type: "boolean", description: "Whether to automatically play the generated audio. Default is true.", default: true }
      },
      required: ["score"]
    }
  }
];

async function synthesize(text, speakerId, speed) {
  const queryResp = await fetch(
    `${VOICEVOX_HOST}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: "POST", signal: AbortSignal.timeout(10000) }
  );
  if (!queryResp.ok) return `audio_query failed: ${queryResp.status}`;
  const query = await queryResp.json();
  query.speedScale = speed;

  const synthResp = await fetch(`${VOICEVOX_HOST}/synthesis?speaker=${speakerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30000)
  });
  if (!synthResp.ok) return `synthesis failed: ${synthResp.status}`;
  return Buffer.from(await synthResp.arrayBuffer());
}

function isConnRefused(e) {
  return e?.cause?.code === "ECONNREFUSED" || e?.message?.includes("ECONNREFUSED");
}

function text(str) {
  return { content: [{ type: "text", text: str }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "get_voices") {
    try {
      const resp = await fetch(`${VOICEVOX_HOST}/speakers`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return text(`Error: ${resp.status}`);
      return text(JSON.stringify(await resp.json(), null, 2));
    } catch (e) {
      return text(isConnRefused(e) ? "Error: Cannot connect to VOICEVOX Engine" : `Error: ${e.message}`);
    }
  }

  if (name === "speak") {
    const { text: t, speaker_id = 1, speed = 1.3, auto_play = true } = args;
    const tmpFile = join(tmpdir(), `voicevox.${process.pid}.${randomUUID()}.wav`);
    try {
      const wav = await synthesize(t, speaker_id, speed);
      if (typeof wav === "string") return text(`Error: ${wav}`);
      writeFileSync(tmpFile, wav);
      if (auto_play) await play(tmpFile);
      return text("ok");
    } catch (e) {
      return text(isConnRefused(e) ? "Error: Cannot connect to VOICEVOX Engine" : `Error: ${e.message}`);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }

  if (name === "speak_a_lot") {
    const { texts, speaker_id = 1, speed = 1.3, auto_play = true } = args;
    if (!texts?.length) return text("ok");

    const errors = [];
    const tmpFiles = [];
    const run = async () => {
      let wav = await synthesize(texts[0], speaker_id, speed);
      for (let i = 0; i < texts.length; i++) {
        let tmpFile = null;
        if (typeof wav === "string") {
          errors.push(`[${i}] Error: ${wav}`);
        } else {
          tmpFile = join(tmpdir(), `voicevox.${process.pid}.${randomUUID()}.wav`);
          tmpFiles.push(tmpFile);
          writeFileSync(tmpFile, wav);
        }

        const nextPromise = i + 1 < texts.length ? synthesize(texts[i + 1], speaker_id, speed) : null;
        if (auto_play && tmpFile) playFile(tmpFile);
        if (nextPromise) wav = await nextPromise;
      }
    };
    try {
      // Hold the lock for the whole batch so other audio cannot cut in between sentences
      await (auto_play ? withPlayLock(run) : run());
      return text(errors.length > 0 ? `partial errors: ${errors.join("; ")}` : "ok");
    } finally {
      for (const f of tmpFiles) if (existsSync(f)) unlinkSync(f);
    }
  }

  if (name === "sing") {
    const { score, speaker_id = 6000, auto_play = true } = args;
    const tmpFile = join(tmpdir(), `voicevox_sing.${process.pid}.${randomUUID()}.wav`);
    try {
      let queryResp = await fetch(`${VOICEVOX_HOST}/sing_frame_audio_query?speaker=${speaker_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(score),
        signal: AbortSignal.timeout(30000)
      });
      if (!queryResp.ok) {
        queryResp = await fetch(`${VOICEVOX_HOST}/sing_frame_audio_query?speaker=6000`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(score),
          signal: AbortSignal.timeout(30000)
        });
        if (!queryResp.ok) {
          const t = await queryResp.text();
          return text(`Error: sing_frame_audio_query failed: ${queryResp.status} ${t.slice(0, 200)}`);
        }
      }

      const synthResp = await fetch(`${VOICEVOX_HOST}/frame_synthesis?speaker=${speaker_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await queryResp.json()),
        signal: AbortSignal.timeout(60000)
      });
      if (!synthResp.ok) {
        const t = await synthResp.text();
        return text(`Error: frame_synthesis failed: ${synthResp.status} ${t.slice(0, 200)}`);
      }

      writeFileSync(tmpFile, Buffer.from(await synthResp.arrayBuffer()));
      if (auto_play) await play(tmpFile);
      return text("ok");
    } catch (e) {
      return text(isConnRefused(e) ? "Error: Cannot connect to VOICEVOX Engine" : `Error: ${e.message}`);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }

  return text(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
