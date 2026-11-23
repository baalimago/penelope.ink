// Stamps a built site with its version, in place: `node stamp-dist.mjs <public dir>`. The version
// is a hash of every file the site serves, so whatever a deploy changes changes it. version.json
// says the site's version and index.html's <meta name="penelope-version"> the page's: a page left
// open asks version.json now and then, and offers a reload once the site moved on (www/update.js).
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node stamp-dist.mjs <public dir>");
  process.exit(2);
}

// What the page says before it is stamped, as `make dev` serves it.
const UNSTAMPED = '<meta name="penelope-version" content="dev">';

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield path.relative(root, full).split(path.sep).join("/");
  }
}

const names = [];
for await (const name of files(root)) if (name !== "version.json") names.push(name);
names.sort();
const hash = createHash("sha256");
for (const name of names) {
  const body = await readFile(path.join(root, name));
  hash.update(`${name}\0${body.length}\0`).update(body);
}
const version = hash.digest("hex").slice(0, 16);

const page = path.join(root, "index.html");
const html = await readFile(page, "utf8");
if (html.split(UNSTAMPED).length !== 2) {
  console.error(`stamp-dist: index.html must say ${UNSTAMPED} exactly once`);
  process.exit(1);
}
await writeFile(page, html.replace(UNSTAMPED, `<meta name="penelope-version" content="${version}">`));
await writeFile(path.join(root, "version.json"), `${JSON.stringify({ version })}\n`);
console.log(`version ${version} of ${names.length} files`);
