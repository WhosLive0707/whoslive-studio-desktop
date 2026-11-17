// CI experiment (not shipped): starts osn-experiment-child.js in a utility process, the way the app starts the engine.
import { app, utilityProcess } from "electron";
import path from "node:path";

app.whenReady().then(() => {
  const p = utilityProcess.fork(path.join(__dirname, "osn-experiment-child.cjs"), [], { stdio: "pipe", serviceName: "wl-exp" });
  p.stdout?.on("data", (d) => process.stdout.write(d));
  p.stderr?.on("data", (d) => process.stderr.write(d));
  p.on("exit", (code) => {
    console.log(`exp: child exited ${code}`);
    app.exit(0);
  });
  setTimeout(() => {
    console.log("exp: gave up after 120 s");
    p.kill();
    app.exit(0);
  }, 120_000);
});
