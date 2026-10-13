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

## Building

```
npm ci
npm start                          # dev app against dev-studio, on this computer
WL_CHANNEL=prod npm start          # prod app
WL_CHANNEL=prod npm run dist       # Windows installer into release/
```

## Releasing

`.github/workflows/release.yml` builds on Windows on every push to `main` or `develop`.

- `main`: publishes release `v<version>` from `package.json` as GitHub's latest, which is the download link and the update feed of every installed copy. A version already released is built but not published, so bump `version` to ship.
- `develop`: builds `<version>-dev.<run>` and replaces the files on the `dev` pre-release, which is the dev app's download link and update feed.

Prod keeps the appId `io.whoslive.studio` that 0.1.1 shipped with: change it and updates install a second copy instead of replacing the first.
