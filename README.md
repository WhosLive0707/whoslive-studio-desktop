# whoslive-studio-desktop
WhosLive Studio for Windows installer downloads
Windows installer for WhosLive Studio. Download WhosLive-Studio-Setup.exe below, run it, and Studio installs and opens.

New: the app updates itself. It checks for new versions, downloads them in the background and asks to restart (Help > Check for updates… does it now).

Until the app is code-signed, Windows may show "Windows protected your PC". Click More info, then Run anyway.

## Two apps, one per branch

| Branch | App | Opens | Download |
|---|---|---|---|
| `main` | WhosLive Studio | studio.whoslive.io | [WhosLive-Studio-Setup.exe](https://github.com/WhosLive0707/whoslive-studio-desktop/releases/latest/download/WhosLive-Studio-Setup.exe) |
| `develop` | WhosLive Studio Dev | dev-studio.whoslive.io | [WhosLive-Studio-Dev-Setup.exe](https://github.com/WhosLive0707/whoslive-studio-desktop/releases/download/dev/WhosLive-Studio-Dev-Setup.exe) |

The two install side by side. The app is a shell around the web Studio, so a Studio deploy reaches it without a new installer; only changes under `src/` need one.

## Remembered screen shares

A browser asks which screen to share every time Studio opens. The app remembers each Studio screen share's pick (the
screen or window, its name, and whether system sound came along) in its settings and shares the same one again by
itself the next time Studio opens: no chooser. A window that was closed, or a name that now matches several windows,
isn't guessed: Studio shows that share's "Share again" instead. `src/captureMemory.js`; the bridge is `capture.next`
and `capture.restore` in `src/preload.js`.

## Talk key

Studio registers the agent's talk key with the app (`shortcuts.register` in `src/preload.js`) so it works while a game
has focus. A key another app already holds isn't taken from it, and a page's keys are let go when it reloads or closes.

## Building

```
npm ci
npm start                          # dev app against dev-studio, on this computer
WL_CHANNEL=prod npm start          # prod app
WL_CHANNEL=prod npm run dist       # Windows installer into release/
```

## Releasing

`.github/workflows/release.yml` builds on Windows on every push to `main` or `develop`.

- `main`: every push publishes a new release as GitHub's latest, which is the download link and the update feed of every installed copy. It is `v<version>` from `package.json`, or one patch past the newest release when that version is taken, so no bump is needed to ship; bump `version` to start a new minor or major.
- `develop`: builds `<version>-dev.<run>` and replaces the files on the `dev` pre-release, which is the dev app's download link and update feed.

Prod keeps the appId `io.whoslive.studio` that 0.1.1 shipped with: change it and updates install a second copy instead of replacing the first.
