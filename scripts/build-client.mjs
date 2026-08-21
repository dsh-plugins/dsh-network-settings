/**
 * Build the browser-half client module for @dsh-plugin/dsh-network-settings.
 *
 * `tsc` emits the module into `lib/client.js`. Because the source is a pure
 * global-script wrapper (`window.__ModuleLoader__.load(...)`) with no ES
 * exports, TypeScript appends a trailing `export {};` to make the emitted file
 * a valid ES module. The web profile's `__ModuleLoader__` and the existing
 * test harness load `lib/client.js` as a plain script, so that artifact is
 * stripped here (it carries no runtime behavior and must not leak into the
 * browser).
 */
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../lib/client.js", import.meta.url);

const source = await readFile(OUT, "utf8");
const tail = /(?:\r?\n)?export \{\};\s*$/;
if (tail.test(source)) {
  await writeFile(OUT, source.replace(tail, "") + "\n");
  console.log("built lib/client.js (stripped module-ification export artifact)");
} else {
  console.log("built lib/client.js");
}
