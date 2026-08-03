
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "public");
const MANIFEST = path.join(ROOT, "assets", "site-manifest.json");

const EXTENSIONS = ["html", "htm", "css", "js", "mjs", "json", "md", "txt", "svg"];



const SKIP_DIRS = ["default", "educational_sl", "educational_vr", "educational_controller",
  "node_modules", ".git"];





const SKIP_FILES = ["/scripts/axiom-sw.js", "/assets/site-manifest.json", "/recovery.html"];

const MAX_BYTES = 512 * 1024;

function extname(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function walk(dir, prefix, out) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }

  for (const item of items) {
    const route = prefix + "/" + item.name;
    if (item.isDirectory()) {
      if (SKIP_DIRS.indexOf(item.name) !== -1 || item.name.charAt(0) === ".") continue;
      walk(path.join(dir, item.name), route, out);
      continue;
    }
    if (!item.isFile()) continue;
    if (EXTENSIONS.indexOf(extname(item.name)) === -1) continue;
    if (SKIP_FILES.indexOf(route) !== -1) continue;

    let stat;
    try {
      stat = fs.statSync(path.join(dir, item.name));
    } catch (e) {
      continue;
    }
    if (stat.size > MAX_BYTES) continue;
    out.push({ path: route, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
  }
  return out;
}


function listSiteFiles() {
  const entries = walk(ROOT, "", []);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const version = entries.reduce((max, entry) => Math.max(max, entry.mtime), 0);
  return { version, entries };
}

module.exports = { listSiteFiles, MANIFEST };

if (require.main === module) {
  const manifest = listSiteFiles();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Wrote " + manifest.entries.length + " entries to " + MANIFEST);
}
