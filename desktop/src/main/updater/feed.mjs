// The release address (contracts, "Update rules"). The built-in one is electron-builder's `resources/app-update.yml` (the fork's GitHub
// releases until the handover). `config.json` `updateFeed` overrides it: https only, and plain http only for loopback addresses so
// tests can use a local feed. Anything else is refused. No Electron import.

/** The fork's releases: where release pages are when nothing else says (and the fallback when app-update.yml is missing). */
export const builtInRepository = { owner: 'Raed-Alghamdi', repo: 'OpenDoc-Desktop' };

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const isLoopbackHost = hostname => loopbackHosts.has(hostname);

/** `{ ok: true, url }` for an address the updater may use, else `{ ok: false, message }` (shown to the user and logged). */
export function parseFeedAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: 'The update address in config.json is empty.' };
  let url;
  try { url = new URL(value.trim()); } catch { return { ok: false, message: `The update address in config.json is not a web address: ${value}` }; }
  if (url.username || url.password) return { ok: false, message: 'The update address in config.json must not contain a user name or password.' };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return { ok: true, url };
  return { ok: false, message: `The update address in config.json must start with https:// (plain http is accepted only for this computer's loopback address): ${url.protocol}//${url.host}` };
}

/**
 * What to hand electron-updater's setFeedURL for an accepted address:
 *   https://github.com/<owner>/<repo>   the GitHub provider (latest release, tag verbatim)
 *   a loopback address ending /github-like   the GitHub provider against a local server that speaks GitHub's URLs (tests)
 *   anything else   the generic provider: a folder that holds latest-linux.yml, latest-mac.yml and the files
 */
export function feedProviderOptions(url, repository = builtInRepository) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && parts.length >= 2 && (parts.length === 2 || parts[2] === 'releases')) {
    return { provider: 'github', owner: parts[0], repo: parts[1] };
  }
  if (isLoopbackHost(url.hostname) && parts.at(-1) === 'github-like') {
    return { provider: 'github', owner: repository.owner, repo: repository.repo, host: url.host, protocol: url.protocol.replace(':', '') };
  }
  const folder = new URL(url.href);
  folder.search = '';
  folder.hash = '';
  if (!folder.pathname.endsWith('/')) folder.pathname += '/';
  return { provider: 'generic', url: folder.href };
}

/** owner and repo from the text of resources/app-update.yml (`provider: github`), or null. A few lines, so no YAML parser. */
export function repositoryFromUpdateConfig(text) {
  if (typeof text !== 'string' || !/^provider:\s*github\s*$/m.test(text)) return null;
  const owner = text.match(/^owner:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1];
  const repo = text.match(/^repo:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1];
  return owner && repo ? { owner, repo } : null;
}

/** Where release pages live: the GitHub repository of an `updateFeed` that names one, else the packaged repository, else the fork's. */
export function releaseRepository({ feed = null, packaged = null } = {}) {
  if (feed) {
    const options = feedProviderOptions(feed);
    if (options.provider === 'github' && !options.host) return { owner: options.owner, repo: options.repo };
  }
  return packaged ?? builtInRepository;
}

export const releaseTag = (version, build) => `desktop-v${version}-${build}`;

/** The release page for a build: .../releases/tag/desktop-v<version>-<build>. */
export function releasePageUrl(repository, version, build) {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases/tag/${encodeURIComponent(releaseTag(version, build))}`;
}

/** The repository's releases list, for a notice when the build number is not known. */
export const releasesListUrl = repository => `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases`;
