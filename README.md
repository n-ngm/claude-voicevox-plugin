# claude-voicevox-plugin

Claude Code plugin for VOICEVOX voice notifications with character personalities.

Enables desktop notifications and voice synthesis via a local [VOICEVOX](https://voicevox.hiroshiba.jp/) engine when Claude Code completes tasks or needs your attention.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Docker](https://www.docker.com/)
- macOS: [terminal-notifier](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`)
- Linux: `notify-send` and one of `paplay` / `aplay` / `mpv`

## Installation

### 1. Add the marketplace and install the plugin

```bash
claude plugin marketplace add n-ngm/claude-voicevox-plugin
claude plugin install voicevox@claude-voicevox-plugin
```

### 2. Restart Claude Code, then run setup

```
/voicevox:setup
```

This will:

1. Check prerequisites
2. Run `npm install` in the plugin directory
3. Start VOICEVOX Engine via Docker
4. Create a stable symlink for version-independent CLAUDE.md import
5. Let you pick a default character
6. Configure permissions and CLAUDE.md import

### 3. Restart Claude Code

Restart Claude Code to apply all changes.

## Updating

```bash
claude plugin marketplace update claude-voicevox-plugin
claude plugin update voicevox@claude-voicevox-plugin
```

Then restart Claude Code and run `/voicevox:setup` again to refresh the symlink.
npm dependencies are installed automatically when the MCP server starts for the first time after an update.

## Character Configuration

Set `voicevox.current_speaker` in `settings.voicevox.json`:

```json
{
  "voicevox": {
    "current_speaker": "zundamon"
  }
}
```

**Resolution priority:**

1. `{project-directory}/.claude/settings.voicevox.json`
2. `~/.claude/settings.voicevox.json`
3. Default: `zundamon`

## Available Characters

| File | Character |
|------|-----------|
| `zundamon.json` | ずんだもん |
| `shikoku_metan.json` | 四国めたん |
| `kasukabe_tsumugi.json` | 春日部つむぎ |
| `tohoku_zunko.json` | 東北ずん子 |
| `tohoku_kiritan.json` | 東北きりたん |
| `tohoku_itako.json` | 東北イタコ |
| `shirakami_kotarou.json` | 白上虎太郎 |
| `kurono_takehiro.json` | 玄野武宏 |
| `chibishikijii.json` | ちび式じい |
| `ankomon.json` | あんこもん |

## MCP Tools

The plugin exposes the following MCP tools for direct use:

| Tool | Description |
|------|-------------|
| `get_voices` | List available voices from VOICEVOX |
| `speak` | Synthesize and play a single text |
| `speak_a_lot` | Synthesize and play multiple texts with pipeline playback |
| `sing` | Synthesize singing voice from a musical score |

## Troubleshooting

**Cannot connect to VOICEVOX Engine**

```bash
curl http://localhost:50021/version
docker compose -f /path/to/plugin/docker-compose.yml restart
```

**MCP server not responding / multiple processes**

```bash
pkill -f mcp_server
```

Restart Claude Code to relaunch the MCP server.

**MCP server or notifications fail depending on the project directory**

The MCP server and hooks are launched via `bin/node.sh`, which picks a Node.js 18+ binary even if the project pins an older version (nvm / mise / volta etc.).
If no suitable binary is found automatically, set `VOICEVOX_NODE` to its path before starting Claude Code:

```bash
export VOICEVOX_NODE=/path/to/node
```

## License

MIT — see [LICENSE](LICENSE)

This plugin connects to [VOICEVOX](https://voicevox.hiroshiba.jp/), a free voice synthesis engine. Each character voice has its own terms of use — please review them on the [VOICEVOX website](https://voicevox.hiroshiba.jp/) before use.
