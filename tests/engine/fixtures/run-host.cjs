// Runs dist/engine-host.cjs outside Electron for tests: Electron's process.parentPort, bridged to Node's IPC.
const { EventEmitter } = require("node:events");
const pp = new EventEmitter();
pp.postMessage = (m) => process.send(m);
process.on("message", (m) => pp.emit("message", { data: m }));
process.parentPort = pp;
require(process.argv[2]);
