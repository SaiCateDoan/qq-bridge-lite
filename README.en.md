# QQ ↔ DeepSeek Harness Bridge (lightweight build)

Turn QQ friends/groups into DeepSeek Harness conversations: agents read, reply, remember, send memes and speak.
A **personal, long-lived lightweight branch**: only the `reserved2` (gen-2 simulation) pipeline is kept; it does not claim to match any upstream release.

## Two upstreams

This repository references and merges what fits this branch from:

- [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq)
- [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)

It is **not tied to a specific upstream version**. Attribution, MIT licensing and third-party boundaries are in [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).

## Features

- Single `reserved2` pipeline: autonomous tool use, replies/quotes, merged forwards, poke, wait/dive, wake rules.
- People and group memory by QQ number, layered group/private/global memory, member-join awareness, group rules, owner relay.
- One `qq-chat-v2` behavioural prompt; persona comes from the DSH global prompt.
- One of three meme backends: AstrBot local/remote packs (default), QQ favorites, DSH dsh-meme. Only the active backend's tools are registered.
- Voice: library `qq_send_voice` / `qq_list_voices`; local GPT-SoVITS `qq_speak(text)`.
- Media: large-image compression, animated frames, image/sticker understanding, merged-forward reading.
- DSH model picker, reasoning effort, tool switches, sessions/logs/tokens/security pages.

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
