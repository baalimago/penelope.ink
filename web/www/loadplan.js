// What the machine boots without, and the order it comes in after the boot, so that the app
// shows first and a recording can start soonest. The worker follows the plan (worker.js) and
// the page shows how far it is (loadbar.js).

// A stage is ready once everything of it and of the stages before it is on the machine.
// A package names its commands: /bin lists them from the boot, and what runs one waits for it.
export const STAGES = [
  { id: "agent", programs: ["clai"] },
  // What the agent starts as a recording begins: ffmpeg and ffprobe, its MCP servers and the notebook.
  { id: "record", programs: ["ffmpeg", "ffprobe", "mcp-server-filesystem", "slivingdoc-git2", "slivingdoc"] },
  // Penelope's search, and the terminal's own.
  { id: "extras", programs: ["duckduckgo-mcp-server"], packages: { "wasmer/ripgrep": ["rg"], "wasmer/fd": ["fd"] } },
];
// The boot's own files are the stage before them all.
export const ORDER = ["machine", ...STAGES.map(({ id }) => id)];

// Splits the site's programs (bin/index.json and clai) and packages (packages/index.json) into
// what the machine boots with and what comes late: {stage, url, name}, a program with
// `program`, a package with its `commands`.
export function plan(programs, packages) {
  const late = [];
  for (const { id, programs: names, packages: named = {} } of STAGES) {
    for (const name of names) {
      const found = programs.find((p) => p.name === name && !p.dir);
      if (found) late.push({ stage: id, name, url: `./${found.file}`, program: name });
    }
    for (const [name, commands] of Object.entries(named)) {
      const found = packages.find((p) => p.name === name);
      if (found) late.push({ stage: id, name: commands.join(", "), url: `./packages/${found.file}`, commands });
    }
  }
  const urls = new Set(late.map(({ url }) => url));
  return {
    programs: programs.filter(({ file }) => !urls.has(`./${file}`)),
    packages: packages.filter(({ file }) => !urls.has(`./packages/${file}`)),
    late,
  };
}

// The stages not ready yet, in order, from the worker's report of its files: {stage, state}.
// Before the first report nothing is ready.
export function pending(files) {
  if (!files) return [...ORDER];
  const first = ORDER.findIndex((id) => files.some((f) => f.stage === id && f.state !== "installed"));
  return first < 0 ? [] : ORDER.slice(first);
}

export const isReady = (files, stage) => !pending(files).includes(stage);

// Runs `task` on each of `items` in order, at most `width` at a time.
export async function inOrder(items, width, task) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}
