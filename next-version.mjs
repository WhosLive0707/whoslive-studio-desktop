// The version a main build publishes as: package.json's, unless that (or a newer one) is already released, then one
// patch past the newest release. Every main build ships without a package.json bump; a bump still sets the floor.
// Usage: node next-version.mjs <package version> [released tags...]
const parse = (s) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s)?.slice(1).map(Number) ?? null;
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const [base, ...tags] = process.argv.slice(2);
const want = parse(base ?? "");
if (!want) throw new Error(`package.json version isn't x.y.z: ${base}`);
const newest = tags.map(parse).filter(Boolean).sort(cmp).at(-1);
const v = newest && cmp(newest, want) >= 0 ? [newest[0], newest[1], newest[2] + 1] : want;
console.log(v.join("."));
