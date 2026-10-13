// One config for both channels (channels.json), picked by WL_CHANNEL like build.mjs.
// Prod keeps 0.1.1's appId and GitHub "latest" feed, so installed copies update in place. Dev is its own app whose
// feed is the fixed "dev" pre-release, so both can be installed side by side.
const channels = require("./channels.json");

const key = process.env.WL_CHANNEL === "prod" ? "prod" : "dev";
const ch = channels[key];
const owner = "WhosLive0707";
const repo = "whoslive-studio-desktop";

module.exports = {
  appId: ch.appId,
  productName: ch.productName,
  directories: { output: "release", buildResources: "assets" },
  files: ["dist/**/*", "package.json"],
  extraMetadata: { name: ch.name, productName: ch.productName },
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "assets/icon.png" },
  nsis: { artifactName: ch.artifact },
  detectUpdateChannel: false,
  publish:
    key === "prod"
      ? { provider: "github", owner, repo, releaseType: "release" }
      : { provider: "generic", url: `https://github.com/${owner}/${repo}/releases/download/dev` },
};
