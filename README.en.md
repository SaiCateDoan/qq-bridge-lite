# QQ ↔ DeepSeek Harness Bridge (lightweight build)

Turn QQ friends/groups into DeepSeek Harness conversations: agents read, reply, remember, send memes and speak.
A **personal, long-lived lightweight branch**: only the `reserved2` (gen-2 simulation) pipeline is kept; it does not claim to match any upstream release.

## Two upstreams

This repository references and merges what fits this branch from:

- [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq)
- [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)

It is **not tied to a specific upstream version**. Attribution, MIT licensing and third-party boundaries are in [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).

## Implemented in this branch

These are the features written or rewritten in this branch (commit hashes in parentheses).

### Lightweight single-pipeline refactor (`9fbf264`)

- Removed `chat` / `closed-agent` / gen-1 simulation; only `reserved2` remains.
- Removed persona cards, the L1–L3 admin surface, approvals/TOTP and `qq-mode-console`.
- Collapsed prompts into one `qq-chat-v2`; persona stays in the DSH global prompt.
- Deleted the old social state machine and dead auto-forwarding code.

### Multimodal media (`52370ac`, `7914f99`)

- `src/media-compress.js`: sharp/WebP adaptive compression for oversized images.
- Animated images are sampled evenly and tiled into a 3×2 contact sheet by default; multi-frame optional.
- Unified `socialV2.media` budgets: download size, decode pixels, long edge, quality, frame count and per-frame bytes.
- Time-awareness and dependency-warning cleanup.

### Meme backends and cover proxy (`5856695`, `9470fd6`, `76dc608`)

- `src/meme-library.js`: content-addressed local gallery, dedupe, index recovery, description/emotion/tag search.
- `src/meme-packs.js`: AstrBot community index, manifest, GitHub tree and optional semantic metadata; async pack downloads.
- `src/dsh-meme-client.js`: loopback HTTP access to the DSH dsh-meme gallery.
- `socialV2.memeBackend`: `astrbot` / `qq` / `dshmeme`, one active at a time; MCP registration-time filtering and backend route guards.
- Console backend selector and meme gallery; AstrBot pack covers are fetched server-side as data URLs (CSP-safe), batched and cached.

### Local GPT-SoVITS voice (`c51b946`)

- `src/tts-client.js`: loopback-only, validates WAV header, size and timeout, readable errors.
- `socialV2.tts`: API URL, reference audio/text, languages, speed, max chars, timeout, volume/loudness normalisation.
- `qq_speak(text)` MCP tool and `POST /api/socialV2/tts`: WAV goes through the existing `record` path with allowlists, agent token, voice rate limits, auditing and read-back.
- Console "Gen-2 simulation → Local TTS" settings with preview; `POST /api/tts/preview` never sends to QQ.
- Loudnorm is applied by default because raw TTS output is often too quiet.

### Docs and operations

- Simplified README/configuration/SnowLuma troubleshooting.
- SnowLuma troubleshooting: if only WebUI 5099 is listening, set `hookAutoLoad: true` in `SnowLuma/config/runtime.json` so it injects the running QQ process and opens 3000/3001.

## Inherited / merged from upstreams

These come from the two upstreams or the existing enhanced lineage. This branch mainly adapts, maintains and fixes them; they are not claimed as original work here:

| Capability | Notes |
| --- | --- |
| Bridge core | OneBot v11 client, QQ↔DSH session mapping, send queue, allowlists/agent tokens/auditing, quote and merged-forward reading |
| `reserved2` simulation skeleton | Autonomous tools, wait/dive, wake rules, reply checks, poke, original group memory |
| People/group memory | QQ-number identity, group/private/global layers, member-join awareness, group rules, owner relay |
| Prompts and DSH integration | Original `qq-chat-v2` content, preset bundle, DSH protocol adaptation, model/reasoning picker, token/cost dashboard |
| Control center and interface platform | 3099 control center, `interface-platform/`, SnowLuma/NapCat lifecycle, update helper, NapCat QR |
| Voice library | `qq_send_voice` / `qq_list_voices`, audio probing/local volume processing, standalone `../voice-tool/` |
| Upstream fixes | Selected fixes merged as needed (DSH adaptation, interface-platform health checks, etc.); see [CHANGELOG.md](CHANGELOG.md) |

## Two ports

| Port | Purpose |
| --- | --- |
| **3099** | **Control center**: start/stop the bridge, bind and start SnowLuma/NapCat, interface platform, versions/logs |
| **3100** | **Bridge console**: QQ prompt, tool switches, meme gallery, voice/TTS, sessions/security |

**Port 3100 intentionally has no SnowLuma bind/start UI. That lives in the 3099 control center.**

Start the control center (Windows):

```text
control-center.bat           # windowed; closing it stops the control center and its children
control-center-hidden.vbs    # no window
npm run control-center
```

macOS: double-click `control-center.command`. Linux: `npm run control-center` or the systemd service.
Open `http://127.0.0.1:3099/`; the token is in `state/control-center-token` (auto-opened URLs include `#t=...`).
It binds to loopback only and does **not** start SnowLuma or the bridge by itself.

## Bind and start SnowLuma

In the control center:

1. **Interface platform → Overview**.
2. Under **Instances → Local SnowLuma program**, click "Browse…" and select your SnowLuma folder (the level containing `launcher.bat` / `index.mjs`), or paste the path and click "Use this folder".
3. Click **Start SnowLuma**; scan the QR code in SnowLuma's WebUI the first time and enable OneBot WebSocket/HTTP.
4. **Interface platform → Settings**, click **Link bridge**.
5. Open the **Bridge** tab and click **Start bridge**.
6. The status bar should be green: platform "1 account ready · bridge linked", QQ "online", DSH "ready".

Daily routine: open control center → start backend → start bridge. Do not run `start.bat` and the control center's bridge at the same time (single instance).

> If only SnowLuma WebUI (5099) is listening and 3000/3001 are missing, QQ has not been injected yet. Set `hookAutoLoad` to `true` in `SnowLuma/config/runtime.json` and restart SnowLuma, or load the QQ process manually in its WebUI. Wait for `[Hook] login detected` and `[OneBot.HTTP]/[OneBot.WS-Server] listening`.

## Quick start

Requires Node.js ≥ 22.13, a working DSH, and a QQ backend you install and log in to (SnowLuma or NapCat). This project does not download or install QQ backends.

```powershell
npm ci
Copy-Item config.example.json config.json
# edit config.json: ownerQQ, allow.groups / allow.private, dsh.provider, ...
node scripts/setup-dsh.mjs
# restart DSH
```

Then use the control center as described above.

- Configuration: [docs/guides/CONFIGURATION.md](docs/guides/CONFIGURATION.md)
- Control center: [docs/guides/CONTROL_CENTER.md](docs/guides/CONTROL_CENTER.md)
- DSH deployment: [docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md)
- Docs index: [docs/README.md](docs/README.md)
- Folder map: [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)

## Voice

**AI voice is disabled by default** (`socialV2.voice.enabled` and `tools.sendVoice` default to `false`): put audio into `audio/`, then enable it in the console.
The standalone tool lives in `../voice-tool/`: `node voice-cli.mjs` / `node voice-gui.mjs`.

Local GPT-SoVITS is configured under "Gen-2 simulation → Local TTS"; the AI uses `qq_speak` to synthesise and send a voice message. It is separate from the audio library. See [docs/guides/VOICE.md](docs/guides/VOICE.md).

## Tests

```powershell
npm run test:audit
```

Offline regression currently has **58 scripts**. `test-platform` can time out occasionally; rerun it alone.

## Safety and boundaries

- Only send QQ content to the model provider you configured; never commit `state/`, tokens or SnowLuma data.
- Group content is untrusted input; tools remain constrained by allowlists, session tokens, rate limits and auditing.
- SnowLuma is a third-party unofficial QQ protocol implementation; use it at your own risk. This project does not bundle, download or start it.
- See [RULES.md](RULES.md) for permission boundaries and [NOTICE.md](NOTICE.md) for attribution and third-party licences.
