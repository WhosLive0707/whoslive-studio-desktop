# Native engine (downloadable app only)

The app streams with OBS's own engine instead of Chrome's, so its capture, encoding and quality match OBS. That
means game capture with OBS's hook, NVENC / AMF / QuickSync with OBS's tuned settings, and WASAPI audio including
per-app audio. The website's Studio is unchanged: it has no engine and keeps the browser path.

## How it fits

```
Studio (web page in the app)  --whosliveDesktop.engine-->  app main process (src/engine/client.js)
                                                               |
                                                    utility process (src/engine/host.js)
                                                               |
                                    obs-studio-node --> obs64.exe (libobs: capture, scene, encoders)
                                                               | RTMP to 127.0.0.1, random key
                                                     ffmpeg -c copy -> live Matroska
                                                               | WebSocket, the same token and messages
                                                     wss://relay.whoslive.io (unchanged) -> every platform
```

- **Studio stays the UI.** It sends its scene (sources and layers) and mixer settings, gets devices, levels and
  stats back, and shows OBS's preview in its preview tile. The preview is a native window the app places over the tile.
- **OBS does capture, composition and encoding.** OBS runs in its own process (obs64.exe), so a crashing driver
  can't take Studio down; the engine restarts.
- **The relay doesn't change.** OBS publishes RTMP to an ffmpeg on this PC. ffmpeg rewraps the stream as Matroska
  (nothing is re-encoded), and its bytes go up the same WebSocket, with the same token and messages, that the browser
  encoder uses. Platform keys never reach this PC, and billing, hold/resume and limits work as they do today.
- **Congestion is handled the way OBS handles it.** If the upload falls behind, reading from ffmpeg pauses. OBS then
  sees a congested connection and uses its dynamic bitrate, then drops frames properly.

## Studio's side (`window.whosliveDesktop.engine`, null when absent)

| Call | What |
|---|---|
| `start()` | Starts OBS's engine. Returns `{ ready, encoders }`. |
| `devices()` | `{ cameras, mics, speakers, monitors, windows, games, apps, encoders }`. Each device is `{ id, name }` with the names Windows uses. |
| `setScene(scene)` | Sends the whole active scene (debounce it). The engine only changes what changed. |
| `setAudio({ [sourceId]: { volume, muted, monitor: "off"/"only"/"output", syncMs } })` | Mixer settings. |
| `preview(rect, show)` | Shows OBS's preview over the tile. `rect` is in CSS pixels of the page. Hide it while menus or dialogs cover the tile. |
| `stream.start({ url, kbps, audioKbps?, prefer?, width?, height? })` | `url` is the relay URL with a fresh token, minted as today. `prefer` is an encoder id. |
| `stream.reconnect(url)` | After `closed`: a fresh token, the same as the browser path's reconnect. |
| `stream.stop()` | Ends cleanly: the relay ends every platform, then `closed` with code 1000 arrives. |
| `onEvent(fn)` | Events: `open`, `relay` (the relay's messages, unchanged), `closed` `{code, reason, wasOpen}`, `format`, `output`, `stats` (1/s), `levels` (20/s, dB per source), `encoder-failed`, `source-error`, `crashed`. |

### Scene

```ts
{
  canvas: { width, height, fps },                  // 720p/1080p/1440p/4K, vertical 1080x1920 / 720x1280, 1080x1080
  sources: (
    | { id, kind: "display", monitor, cursor? }    // monitor: devices().monitors[].id
    | { id, kind: "window", window, cursor? }      // window: devices().windows[].id
    | { id, kind: "game", window? }                // no window: any full-screen game (OBS's game hook)
    | { id, kind: "camera", device, resolution?, fps?, audio? }  // cameras and capture cards; audio: use its sound
    | { id, kind: "mic", device }                  // mics and line-ins (a console's audio), raw like OBS
    | { id, kind: "speakers", device? }            // desktop audio
    | { id, kind: "app-audio", window }            // one app's sound (OBS's Application Audio Capture)
    | { id, kind: "image" | "media", file, loop? } // files on this PC
    | { id, kind: "browser", url, width, height, css?, fps? }
    | { id, kind: "overlay", url }                 // a transparent full-canvas page with Studio's own layers
    | { id, kind: "color", color }
  )[],
  layers: {                                        // bottom to top; sound-only sources have no layer
    id, source, x, y, w, h,                        // the layer's box on the canvas
    fit?: "contain" | "cover" | "fill",
    crop?: { left, top, right, bottom },           // fractions 0-0.95 of the source
    flipX?, flipY?, visible?, opacity?,
    sound?: SoundCfg                               // Scale to sound (scale-to-sound.logic); sound.from: a source id
  }[]
}
```

Studio draws its own layers (chat box, alerts, text, widgets, themes, the VTuber avatar, stickers and 3D effects) on
an **overlay page**: a Studio route that renders only those layers on a transparent background, which the engine
loads as an OBS browser source. That is how StreamElements and Streamlabs overlays run in OBS.

## Phases

1. **Engine** (this branch). The engine process, devices, the scene, the mixer, levels, native Scale to sound,
   the preview, streaming to the relay with encoder fallback, stats, tests, and CI with a real-OBS smoke test.
2. **Studio in engine mode** (web, Lovable). When `whosliveDesktop.engine` exists:
   - sources come from `devices()`;
   - the scene goes to `setScene`;
   - the mixer goes to `setAudio` / `levels`;
   - the preview tile uses `preview`;
   - Go Live, Record and Clip use `stream`.

   Plus the overlay route. The browser path stays for the website.
3. **Parity extras**: recording and replay buffer (OBS's own), vertical output as a second canvas, rounded-corner
   and border masks, per-platform renditions, and NVIDIA background removal (nv-filters ships with the engine).

## License

obs-studio-node and libobs are GPL-2.0. An app that ships them must be GPL-2.0 too, with its source available (this
repo is public). Studio's web code isn't part of the app and isn't affected. **Before any release with the engine**,
legal review must sign off, and this repo needs a GPL-2.0 `LICENSE` and third-party notices. Until then the engine
only builds on `feature/native-engine*` branches as an unpublished test artifact. `release.yml` doesn't package it.

## Testing

- `npm test`: unit tests for the pure parts, plus the engine host's whole flow against a stand-in OBS and relay
  (any OS; the flow tests skip on Windows).
- CI (`native-engine.yml`, Windows): the real engine. It fetches the pinned obs-studio-node and starts OBS, then:
  - lists devices;
  - builds a scene (a color plus the runner's screen, flipped);
  - shows the preview;
  - streams 8 s with x264 to a local stand-in relay and ends cleanly;
  - checks with ffprobe that 1080p H.264 + AAC Matroska arrived.

  It also builds the dev installer as an artifact.
- Needs real PCs before release:
  - NVENC, AMF and QuickSync on real GPUs;
  - OBS's game hook in real games, including anti-cheat titles;
  - capture cards;
  - the preview's position at 125% and 150% Windows scaling;
  - an end-to-end stream to Twitch and YouTube through the real relay.
