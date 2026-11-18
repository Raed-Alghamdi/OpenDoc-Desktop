// Which file of a release belongs to an install type, and whether the release's metadata can be trusted to offer it.
// No Electron import. electron-updater fails with "Cannot read properties of undefined" when the metadata lists no file for a
// type, and downloads without any check when an entry has no sha512, so both are caught before anything is offered.

const extensions = { appimage: 'AppImage', deb: 'deb', rpm: 'rpm', pacman: 'pacman', mac: 'zip' };

export const releaseExtension = type => extensions[type] ?? null;

/** The file entries of update metadata (`files:`, or the older single `path:` form), as { url, sha512 } with the url as text. */
export function metadataFiles(info) {
  if (Array.isArray(info?.files) && info.files.length) return info.files.filter(file => file && typeof file.url === 'string');
  if (typeof info?.path === 'string') return [{ url: info.path, sha512: info.sha512 }];
  return [];
}

/**
 * Is the raw metadata shaped the way the checks assume? electron-updater takes `files` when it has a length, else `path`, and resolves
 * each url with new URL(url, base), which turns an array like ['http://evil.example/x.deb'] into that address. So a `files` list with
 * an entry that is not a plain object with a text url, a `path` that is not text, or a `packages` entry whose path is not text is refused
 * as a whole, before anything is filtered. Returns null when the shape is fine, else the text of the problem.
 */
export function malformedMetadata(info) {
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const files = info?.files;
  if (files != null && files.length > 0) {
    if (!Array.isArray(files)) return 'its file list is not a list';
    for (const entry of files) {
      if (!plain(entry)) return 'a file entry is not an object';
      if (typeof entry.url !== 'string') return 'a file entry has an address that is not text';
    }
  } else if (info?.path != null && typeof info.path !== 'string') return 'its path is not text';
  if (info?.packages != null) {
    if (!plain(info.packages)) return 'its packages entry is not an object';
    for (const entry of Object.values(info.packages)) if (!plain(entry) || typeof entry.path !== 'string') return 'a packages entry has a path that is not text';
  }
  return null;
}

const dummyBase = new URL('https://x.invalid/dir/');
// Schemes a download could actually use (or that do something worse). Any other "scheme" is a relative name with a colon in it
// (an rpm epoch, "pkg-1:2.rpm"), which new URL() reads as a made-up scheme; it cannot be fetched.
const fetchableSchemes = new Set(['http:', 'https:', 'ftp:', 'file:', 'ws:', 'wss:', 'data:', 'blob:', 'javascript:', 'about:', 'filesystem:', 'chrome:', 'app:']);

/**
 * A file address that is not a plain name or path next to the metadata. electron-updater resolves each entry with new URL(url, feedBase),
 * and that parser drops tabs and newlines and trims leading spaces, so " http://evil/x" and "ht\ttps://evil/x" would reach another host.
 * So: no whitespace or control characters and no backslash at all, and resolving the entry against a dummy base must stay on that base's
 * origin (a name with a colon in it that parses as an unknown scheme is allowed: nothing can fetch it). It must also stay on the real
 * feed's origin when that is known (`base`): against an http loopback feed, "https:evil.example/x" is another host, though the https
 * dummy base reads it as a relative path.
 */
export function isForeignUrl(url, { base = null } = {}) {
  if (typeof url !== 'string' || !url) return true;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url) || url.includes('\\')) return true;
  const bases = [dummyBase];
  if (base) { try { bases.push(new URL(base)); } catch { return true; } }
  for (const origin of bases) {
    let resolved;
    try { resolved = new URL(url, origin); } catch { return true; }
    if (resolved.origin === origin.origin) continue;
    if (fetchableSchemes.has(resolved.protocol) || resolved.origin !== 'null') return true;
  }
  return false;
}

const pathOf = url => { try { return decodeURIComponent(new URL(url, 'https://example.invalid/').pathname); } catch { return url; } };

/**
 * `{ ok: true, file }` when the metadata lists a file for `type` that carries a sha512, else `{ ok: false, reason, message }`.
 * `base` is the feed's address when it is known (see isForeignUrl). `arch` matters only on macOS, where an Intel Mac must not be given an arm64 zip (electron-updater drops it and then fails).
 */
export function releaseFileFor(type, info, { arch = process.arch, base = null } = {}) {
  const extension = releaseExtension(type);
  if (!extension) return { ok: false, reason: 'unsupported-type', message: `Install type ${type} has no release file.` };
  // electron-updater resolves each entry with new URL(url, feedBase), so an absolute address would be fetched from anywhere, over any
  // scheme, and the checksum only proves the file is the one the metadata names. A release with any such entry is not offered.
  const malformed = malformedMetadata(info);
  if (malformed) return { ok: false, reason: 'malformed', message: `The release's metadata is not in the expected form (${malformed}), so it is not offered.` };
  const foreign = metadataFiles(info).find(file => isForeignUrl(file.url, { base })) ?? (info?.packages ? Object.values(info.packages).find(entry => isForeignUrl(entry.path, { base })) : null);
  if (foreign) return { ok: false, reason: 'foreign-url', message: `The release names a file by an address outside the feed (${String(foreign.url ?? foreign.path).slice(0, 80)}), so it is not offered.` };
  let candidates = metadataFiles(info).filter(file => pathOf(file.url).toLowerCase().endsWith(`.${extension.toLowerCase()}`));
  if (type === 'mac' && arch !== 'arm64') candidates = candidates.filter(file => !pathOf(file.url).includes('arm64'));
  if (!candidates.length) return { ok: false, reason: 'no-file', message: `The release lists no .${extension} file for this install.` };
  const file = candidates.find(entry => typeof entry.sha512 === 'string' && entry.sha512.length > 0);
  if (!file) return { ok: false, reason: 'no-checksum', message: `The release's .${extension} file has no sha512 checksum, so it is not offered.` };
  return { ok: true, file };
}
