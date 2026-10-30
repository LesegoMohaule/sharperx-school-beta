import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(appDirectory, "index.html");
const workerPath = path.join(appDirectory, "service-worker.js");
const buildMetaPattern = /(<meta\s+name="sharpertime-build"\s+content=")[^"]*("\s*>)/;
const workerBuildPattern = /(const BUILD_ID = ")[^"]*(";)/;
const releaseAssetPattern = /(styles\.css|app\.bundle\.js|legacy-app\.js)\?(?:v=\d+|release=[^"'&\s]+)/g;

function normalizeIndex(html) {
  return html
    .replace(buildMetaPattern, "$1__BUILD_ID__$2")
    .replace(releaseAssetPattern, "$1?release=__BUILD_ID__");
}

let indexHtml = await readFile(indexPath, "utf8");
let serviceWorker = await readFile(workerPath, "utf8");
if (!buildMetaPattern.test(indexHtml)) throw new Error("Missing SharperTime build meta tag in index.html.");
if (!workerBuildPattern.test(serviceWorker)) throw new Error("Missing BUILD_ID marker in service-worker.js.");

const shellMatch = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) throw new Error("Could not read APP_SHELL from service-worker.js.");
const shellPaths = [...shellMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
const files = new Set(["index.html", "service-worker.js"]);
for (const shellPath of shellPaths) {
  const filePath = shellPath.split(/[?#]/, 1)[0].replace(/^\.\//, "") || "index.html";
  files.add(filePath);
}

const hash = createHash("sha256");
for (const filePath of [...files].sort()) {
  let contents = await readFile(path.join(appDirectory, filePath));
  if (filePath === "index.html") {
    contents = Buffer.from(normalizeIndex(contents.toString("utf8")));
  } else if (filePath === "service-worker.js") {
    contents = Buffer.from(contents.toString("utf8").replace(workerBuildPattern, "$1__BUILD_ID__$2"));
  }
  hash.update(filePath);
  hash.update("\0");
  hash.update(contents);
  hash.update("\0");
}

const buildId = hash.digest("hex").slice(0, 16);
indexHtml = normalizeIndex(indexHtml)
  .replace(buildMetaPattern, `$1${buildId}$2`)
  .replace(/((?:styles\.css|app\.bundle\.js|legacy-app\.js)\?release=)__BUILD_ID__/g, `$1${buildId}`);
serviceWorker = serviceWorker.replace(workerBuildPattern, `$1${buildId}$2`);
await Promise.all([
  writeFile(indexPath, indexHtml),
  writeFile(workerPath, serviceWorker),
]);
process.stdout.write(`SharperTime release build: ${buildId}\n`);
