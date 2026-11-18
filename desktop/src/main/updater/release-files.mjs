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

/** A file address that is not a plain name or path next to the metadata: a scheme (http:, https:, file:) or a host (//host/...). */
export const isAbsoluteUrl = url => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.includes('\\');

const pathOf = url => { try { return decodeURIComponent(new URL(url, 'https://example.invalid/').pathname); } catch { return url; } };

/**
 * `{ ok: true, file }` when the metadata lists a file for `type` that carries a sha512, else `{ ok: false, reason, message }`.
 * `arch` matters only on macOS, where an Intel Mac must not be given an arm64 zip (electron-updater drops it and then fails).
 */
export function releaseFileFor(type, info, { arch = process.arch } = {}) {
  const extension = releaseExtension(type);
  if (!extension) return { ok: false, reason: 'unsupported-type', message: `Install type ${type} has no release file.` };
  // electron-updater resolves each entry with new URL(url, feedBase), so an absolute address would be fetched from anywhere, over any
  // scheme, and the checksum only proves the file is the one the metadata names. A release with any such entry is not offered.
  const foreign = metadataFiles(info).find(file => isAbsoluteUrl(file.url));
  if (foreign) return { ok: false, reason: 'foreign-url', message: `The release names a file by an address outside the feed (${String(foreign.url).slice(0, 80)}), so it is not offered.` };
  let candidates = metadataFiles(info).filter(file => pathOf(file.url).toLowerCase().endsWith(`.${extension.toLowerCase()}`));
  if (type === 'mac' && arch !== 'arm64') candidates = candidates.filter(file => !pathOf(file.url).includes('arm64'));
  if (!candidates.length) return { ok: false, reason: 'no-file', message: `The release lists no .${extension} file for this install.` };
  const file = candidates.find(entry => typeof entry.sha512 === 'string' && entry.sha512.length > 0);
  if (!file) return { ok: false, reason: 'no-checksum', message: `The release's .${extension} file has no sha512 checksum, so it is not offered.` };
  return { ok: true, file };
}
