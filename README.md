# lazerfuse

A read-only FUSE view of osu!lazer's content store in osu!stable-style folders: `Songs/`, `Skins/`, and `Replays/`. The view updates while lazer runs.
Linux only (`@cocalc/fuse-native` requires Linux).

## Usage

```sh
npm install
node lazerfuse.js <mountpoint>
```

Files are served through FUSE in read-only passthrough mode by default. Options:

- `--osu-dir <dir>`: osu!lazer data directory (default: `~/.local/share/osu`).
- `--passthrough`: explicitly select the default mode.
- `--symlink`: link directly to the original blobs for native I/O. **Writing through these links can modify the originals.**
- `--debug`: log FUSE and index activity.

`--passthrough` and `--symlink` cannot be used together. Press Ctrl-C to unmount.

Names are case-insensitive, invalid Windows characters are removed, and collisions receive numeric suffixes. Nested paths are preserved. Deleted beatmap sets and empty skins are excluded.

Realm JS is pinned to 20.2.0; a future osu!lazer Realm format change may require an update. Use passthrough mode when an application cannot follow links to the content store.
