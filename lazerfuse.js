#!/usr/bin/env node
// lazerfuse — read-only FUSE view of osu!lazer storage in old osu!stable layout.
//
//   <mount>/Songs/<setid> <artist> - <title>/<original filenames...>
//   <mount>/Skins/<skin name>/...
//
// Works while lazer is running: realm is opened in normal (multi-process) mode
// and collection listeners keep the view current. File entries are exposed as
// regular read-only files through FUSE by default; --symlink opts into native
// I/O through links to the content-addressed files/ store.

const Fuse = require("@cocalc/fuse-native");
const Realm = require("realm");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- CLI ----------

function usage(code) {
  console.error(
    "usage: lazerfuse [--osu-dir <dir>] [--passthrough | --symlink] [--debug] <mountpoint>"
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
let osuDir = path.join(os.homedir(), ".local/share/osu");
let passthrough = true;
let sawPassthrough = false;
let sawSymlink = false;
let debug = false;
let mountpoint = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--osu-dir") osuDir = argv[++i] ?? usage(1);
  else if (a === "--passthrough") {
    sawPassthrough = true;
    passthrough = true;
  } else if (a === "--symlink") {
    sawSymlink = true;
    passthrough = false;
  }
  else if (a === "--debug") debug = true;
  else if (a === "-h" || a === "--help") usage(0);
  else if (!mountpoint) mountpoint = a;
  else usage(1);
}
if (sawPassthrough && sawSymlink)
  throw new Error("--passthrough and --symlink cannot be used together");
if (!mountpoint) usage(1);
mountpoint = path.resolve(mountpoint);

const realmPath = path.join(osuDir, "client.realm");
const filesDir = path.join(osuDir, "files");
if (!fs.existsSync(realmPath)) {
  console.error(`no client.realm under ${osuDir}`);
  process.exit(1);
}

// ---------- index ----------

const UID = process.getuid();
const GID = process.getgid();

function blobPath(hash) {
  return path.join(filesDir, hash[0], hash.slice(0, 2), hash);
}

// One node is {name, mtime, children: Map<lowercased, node>} for dirs
// or {name, mtime, hash} for files.
function makeDir(name, mtime) {
  return { name, mtime, children: new Map() };
}

function getOrMakeDir(parent, sourceName, mtime) {
  parent.sourceDirs ??= new Map();
  let node = parent.sourceDirs.get(sourceName);
  if (!node) {
    const name = uniqueName(parent, sanitize(sourceName));
    node = makeDir(name, mtime);
    parent.children.set(name.toLowerCase(), node);
    parent.sourceDirs.set(sourceName, node);
  }
  return node;
}

// Strip characters stable/Windows tools choke on, plus path separators.
function sanitize(name) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/[. ]+$/, "")
    .trim();
  return clean.length ? clean : "_";
}

function uniqueName(parent, base) {
  let name = base;
  for (let n = 2; parent.children.has(name.toLowerCase()); n++)
    name = `${base} (${n})`;
  return name;
}

function uniqueFileName(parent, base) {
  if (!parent.children.has(base.toLowerCase())) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let name;
  for (let n = 2; ; n++) {
    name = `${stem} (${n})${ext}`;
    if (!parent.children.has(name.toLowerCase())) return name;
  }
}

function addEntry(setDir, filename, hash, mtime) {
  const segments = filename.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) return;
  let dir = setDir;
  for (const seg of segments.slice(0, -1)) dir = getOrMakeDir(dir, seg, mtime);
  const leaf = uniqueFileName(dir, sanitize(segments[segments.length - 1]));
  dir.children.set(leaf.toLowerCase(), { name: leaf, mtime, hash });
}

function buildIndex(realm) {
  const started = Date.now();
  const root = makeDir("", new Date());
  const songs = makeDir("Songs", new Date());
  const skins = makeDir("Skins", new Date());
  const replays = makeDir("Replays", new Date());
  root.children.set("songs", songs);
  root.children.set("skins", skins);
  root.children.set("replays", replays);

  const sets = realm.objects("BeatmapSet").filtered("DeletePending == false");
  for (const set of sets) {
    const meta = set.Beatmaps[0]?.Metadata;
    const artistTitle = meta
      ? `${meta.Artist} - ${meta.Title}`
      : set.ID.toString();
    const base = sanitize(
      set.OnlineID > 0 ? `${set.OnlineID} ${artistTitle}` : artistTitle
    );
    const mtime = set.DateAdded ? new Date(set.DateAdded) : new Date();
    const setDir = makeDir(uniqueName(songs, base), mtime);
    songs.children.set(setDir.name.toLowerCase(), setDir);
    for (const f of set.Files) addEntry(setDir, f.Filename, f.File.Hash, mtime);
  }

  const scores = realm.objects("Score").filtered("DeletePending == false");
  for (const s of scores) {
    // lazer-set scores store "replay.osr"; imported ones keep their original
    // filename (e.g. "tmphLClEs.osr" from a browser download)
    const f =
      s.Files.find((x) => x.Filename === "replay.osr") ??
      s.Files.find((x) => x.Filename.toLowerCase().endsWith(".osr"));
    if (!f) continue;
    const date = s.Date ? new Date(s.Date) : new Date();
    const m = s.BeatmapInfo?.Metadata;
    const map = m
      ? `${m.Artist} - ${m.Title} (${m.Author?.Username || "unknown"}) [${s.BeatmapInfo.DifficultyName}]`
      : `unknown map ${s.BeatmapHash?.slice(0, 8) ?? ""}`;
    // lazer replay-export naming: "{user} playing {map} ({yyyy-MM-dd_HH-mm})", UTC
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}_${p(date.getUTCHours())}-${p(date.getUTCMinutes())}`;
    const base = sanitize(
      `${s.User?.Username || "Unknown"} playing ${map} (${stamp})`
    );
    let name = `${base}.osr`;
    for (let n = 2; replays.children.has(name.toLowerCase()); n++)
      name = `${base} (${n}).osr`;
    replays.children.set(name.toLowerCase(), {
      name,
      mtime: date,
      hash: f.File.Hash,
    });
  }

  const skinRows = realm.objects("Skin").filtered("DeletePending == false");
  for (const skin of skinRows) {
    if (!skin.Files.length) continue;
    const mtime = new Date();
    const skinDir = makeDir(uniqueName(skins, sanitize(skin.Name)), mtime);
    skins.children.set(skinDir.name.toLowerCase(), skinDir);
    for (const f of skin.Files) addEntry(skinDir, f.Filename, f.File.Hash, mtime);
  }

  if (debug)
    console.error(
      `[lazerfuse] index: ${songs.children.size} sets, ${replays.children.size} replays, ${skins.children.size} skins in ${Date.now() - started}ms`
    );
  return root;
}

// ---------- realm (live) ----------

const realm = new Realm({ path: realmPath });
let root = buildIndex(realm);

let rebuildTimer = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    try {
      root = buildIndex(realm); // atomic swap; FUSE callbacks never see a partial tree
    } catch (e) {
      console.error("[lazerfuse] rebuild failed:", e.message);
    }
  }, 500);
}

const liveSets = realm.objects("BeatmapSet");
const liveSkins = realm.objects("Skin");
const liveScores = realm.objects("Score");
const onChange = (_coll, changes) => {
  if (
    changes.insertions.length ||
    changes.deletions.length ||
    changes.newModifications.length
  )
    scheduleRebuild();
};
liveSets.addListener(onChange);
liveSkins.addListener(onChange);
liveScores.addListener(onChange);

// ---------- FUSE ----------

function resolve(p) {
  if (p === "/") return root;
  let node = root;
  for (const seg of p.split("/").filter(Boolean)) {
    if (!node.children) return null;
    node = node.children.get(seg.toLowerCase());
    if (!node) return null;
  }
  return node;
}

function statFor(node) {
  const t = node.mtime;
  const common = { mtime: t, atime: t, ctime: t, uid: UID, gid: GID, nlink: 1 };
  if (node.children)
    return { ...common, mode: 0o40555, size: 4096 };
  if (!passthrough)
    return { ...common, mode: 0o120777, size: blobPath(node.hash).length };
  return { ...common, mode: 0o100444, size: sizeOf(node.hash) };
}

const sizeCache = new Map();
function sizeOf(hash) {
  let s = sizeCache.get(hash);
  if (s === undefined) {
    try {
      s = fs.statSync(blobPath(hash)).size;
    } catch {
      s = 0;
    }
    sizeCache.set(hash, s);
  }
  return s;
}

const ops = {
  readdir(p, cb) {
    const node = resolve(p);
    if (!node) return cb(Fuse.ENOENT);
    if (!node.children) return cb(Fuse.ENOTDIR);
    cb(0, [...node.children.values()].map((c) => c.name));
  },
  getattr(p, cb) {
    const node = resolve(p);
    if (!node) return cb(Fuse.ENOENT);
    cb(0, statFor(node));
  },
  readlink(p, cb) {
    const node = resolve(p);
    if (!node) return cb(Fuse.ENOENT);
    if (node.children || passthrough) return cb(Fuse.EINVAL);
    cb(0, blobPath(node.hash));
  },
  open(p, flags, cb) {
    const node = resolve(p);
    if (!node) return cb(Fuse.ENOENT);
    if (node.children) return cb(Fuse.EISDIR);
    if ((flags & 3) !== 0) return cb(Fuse.EROFS); // O_WRONLY / O_RDWR
    fs.open(blobPath(node.hash), "r", (err, fd) =>
      err ? cb(Fuse.ENOENT) : cb(0, fd)
    );
  },
  read(p, fd, buf, len, pos, cb) {
    fs.read(fd, buf, 0, len, pos, (err, bytesRead) =>
      err ? cb(0) : cb(bytesRead)
    );
  },
  release(p, fd, cb) {
    fs.close(fd, () => cb(0));
  },
};

const fuse = new Fuse(mountpoint, ops, {
  force: true,
  mkdir: true,
  autoUnmount: true,
  debug,
});

fuse.mount((err) => {
  if (err) {
    console.error("[lazerfuse] mount failed:", err.message);
    process.exit(1);
  }
  console.error(
    `[lazerfuse] mounted ${mountpoint} (${passthrough ? "passthrough" : "symlink"} mode, live realm)`
  );
});

function shutdown() {
  fuse.unmount((err) => {
    try {
      liveSets.removeListener(onChange);
      liveSkins.removeListener(onChange);
      liveScores.removeListener(onChange);
      realm.close();
    } catch {}
    process.exit(err ? 1 : 0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
