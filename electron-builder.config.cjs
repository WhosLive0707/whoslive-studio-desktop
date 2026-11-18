// One config for both channels (channels.json), picked by WL_CHANNEL like build.mjs.
// Prod keeps 0.1.1's appId and GitHub "latest" feed, so installed copies update in place. Dev is its own app whose
// feed is the fixed "dev" pre-release, so both can be installed side by side.
const channels = require("./channels.json");

const fs = require("fs");

const key = process.env.WL_CHANNEL === "prod" ? "prod" : "dev";
// OBS's engine (obs-studio-node, fetched by scripts/fetch-osn.mjs) goes next to the app, outside the asar: it is a
// native module with its own executables. Builds without it are the browser-engine app they always were.
const withEngine = fs.existsSync("vendor/obs-studio-node/obs64.exe");
const ch = channels[key];
const owner = "WhosLive0707";
const repo = "whoslive-studio-desktop";

module.exports = {
  appId: ch.appId,
  productName: ch.productName,
  directories: { output: "release", buildResources: "assets" },
  files: ["dist/**/*", "package.json"],
  ...(withEngine ? { extraResources: [{ from: "vendor/obs-studio-node", to: "obs-studio-node", filter: ["**/*", "!**/*.pdb"] }] } : {}),
  extraMetadata: { name: ch.name, productName: ch.productName },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "assets/icon.png",
    // Signed with Azure Artifact Signing; electron-builder reads AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET from the environment.
    azureSignOptions: {
      publisherName: "WhosLive Inc.",
      endpoint: "https://eus.codesigning.azure.net",
      codeSigningAccountName: "whoslivesigning",
      certificateProfileName: "WhosLiveStudio",
    },
  },
  nsis: { artifactName: ch.artifact },
  detectUpdateChannel: false,
  publish:
    key === "prod"
      ? { provider: "github", owner, repo, releaseType: "release" }
      : { provider: "generic", url: `https://github.com/${owner}/${repo}/releases/download/dev` },
};
