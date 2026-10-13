const FIRST_CHECK_MS = 2e4;
const CHECK_EVERY_MS = 6 * 36e5;
const CLOSE_WAIT_MS = 15e3;
const verOf = (info) => String(info?.version ?? "").replace(/^v/, "");
export class AppUpdates {
  constructor(env) {
    this.env = env;
    const u = env.updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on("update-available", (info) => this.set({ kind: "downloading", version: verOf(info), percent: 0 }));
    u.on("download-progress", (p) => {
      if (this.state.kind === "downloading") this.set({ ...this.state, percent: Math.round(Number(p?.percent ?? 0)) });
    });
    u.on("update-not-available", () => {
      const manual = this.state.kind === "checking" && this.state.manual;
      this.set({ kind: "none" });
      if (manual) void this.say("You're up to date", `WhosLive Studio ${env.version} is the newest version.`);
    });
    u.on("update-downloaded", (info) => {
      const version = verOf(info);
      this.set({ kind: "ready", version });
      if (!this.asked.has(version)) {
        this.asked.add(version);
        void this.offerRestart();
      }
    });
    u.on("error", (e) => {
      const manual = this.state.kind === "checking" && this.state.manual;
      this.set({ kind: "error", message: String(e?.message ?? e) });
      if (manual) void this.say("Couldn't check for updates", "Check your internet connection and try again.");
    });
  }
  env;
  state = { kind: "idle" };
  /** A restart for the update is underway: the last window closing installs it instead of just quitting. */
  restarting = false;
  asked = new Set();
  /** The first check a little after start, then every few hours. */
  start() {
    (this.env.setTimer ?? setTimeout)(() => void this.check(false), FIRST_CHECK_MS);
    (this.env.every ?? setInterval)(() => void this.check(false), CHECK_EVERY_MS);
  }
  async check(manual) {
    if (this.state.kind === "ready") {
      if (manual) await this.offerRestart();
      return;
    }
    if (this.state.kind === "checking" || this.state.kind === "downloading") {
      if (manual) await this.say("Already on it", this.state.kind === "downloading" ? `Downloading WhosLive Studio ${this.state.version}.` : "Checking for updates.");
      return;
    }
    this.set({ kind: "checking", manual });
    try {
      await this.env.updater.checkForUpdates();
    } catch (e) {
      if (this.state.kind === "checking") {
        this.set({ kind: "error", message: String(e?.message ?? e) });
        if (manual) await this.say("Couldn't check for updates", "Check your internet connection and try again.");
      }
    }
  }
  /** What the Help menu says. */
  menuLabel() {
    const s = this.state;
    if (s.kind === "ready") return `Restart to update to ${s.version}`;
    if (s.kind === "downloading") return `Downloading ${s.version}${s.percent ? ` (${s.percent}%)` : ""}\u2026`;
    if (s.kind === "checking") return "Checking for updates\u2026";
    return "Check for updates\u2026";
  }
  menuClick() {
    if (this.state.kind === "ready") void this.restartNow();
    else void this.check(true);
  }
  async offerRestart() {
    if (this.state.kind !== "ready") return;
    const version = this.state.version;
    const r = await this.env.ask(this.env.main(), {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "WhosLive Studio",
      message: `WhosLive Studio ${version} is ready`,
      detail: "Restart to finish updating. Live or recording? Pick Later: it updates the next time you close the app."
    });
    if (r.response === 0) await this.restartNow();
  }
  /**
   * Closes every window first. If Studio is busy it asks, and "Stay" keeps it open: then nothing is installed until
   * the app is closed. Otherwise the last window closing installs the update and starts the new version.
   */
  async restartNow() {
    if (this.state.kind !== "ready") return;
    const wins = this.env.windows().filter((w) => !w.isDestroyed());
    if (!wins.length) return this.install();
    this.restarting = true;
    const main = this.env.main() ?? wins[0];
    const closed = await new Promise((res) => {
      if (main.isDestroyed()) return res(true);
      const t = (this.env.setTimer ?? setTimeout)(() => res(false), CLOSE_WAIT_MS);
      main.once("closed", () => {
        clearTimeout(t);
        res(true);
      });
      for (const w of wins) w.close();
    });
    if (!closed) this.restarting = false;
  }
  /** From the app's window-all-closed while restarting: install and run the new version. */
  install() {
    this.restarting = false;
    this.env.updater.quitAndInstall(true, true);
  }
  set(s) {
    this.state = s;
    this.env.changed();
  }
  async say(message, detail) {
    await this.env.ask(this.env.main(), { type: "info", buttons: ["OK"], title: "WhosLive Studio", message, detail });
  }
}
