// The release address rules (contracts, "Update rules"), the release page link and the files a release must list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtInRepository, feedProviderOptions, parseFeedAddress, releasePageUrl, releaseRepository, repositoryFromUpdateConfig, releaseTag } from '../../../src/main/updater/feed.mjs';
import { isAbsoluteUrl, metadataFiles, releaseFileFor } from '../../../src/main/updater/release-files.mjs';

test('https addresses are accepted', () => {
  for (const address of ['https://github.com/Raed-Alghamdi/OpenDoc-Desktop', 'https://updates.example.org/opendoc/', 'https://example.org:8443/feed']) assert.equal(parseFeedAddress(address).ok, true, address);
});

test('plain http is accepted for loopback addresses only', () => {
  for (const address of ['http://127.0.0.1:8099/generic/', 'http://localhost:8099/', 'http://[::1]:8099/feed']) assert.equal(parseFeedAddress(address).ok, true, address);
  for (const address of ['http://example.org/feed', 'http://192.168.1.5/feed', 'http://127.0.0.2/feed', 'http://127.0.0.1.example.org/feed', 'http://0.0.0.0/feed', 'http://localhost.example.org/']) {
    const result = parseFeedAddress(address);
    assert.equal(result.ok, false, address);
    assert.match(result.message, /https/);
  }
});

test('anything else is refused: other schemes, user names, text that is not an address, empty values', () => {
  for (const value of ['file:///tmp/feed', 'ftp://example.org/feed', 'javascript:alert(1)', 'data:text/plain,x', 'https://user:pass@example.org/feed', 'https://user@example.org/', 'example.org/feed', 'not an address', '', '   ', 42, null, undefined, {}, ['https://example.org/']]) {
    assert.equal(parseFeedAddress(value).ok, false, JSON.stringify(value));
  }
});

test('an address that hides another host behind a user name is refused', () => {
  assert.equal(parseFeedAddress('https://github.com@evil.example/feed').ok, false);
  assert.equal(parseFeedAddress('http://127.0.0.1@evil.example/feed').ok, false);
});

test('which provider an address means', () => {
  const options = address => feedProviderOptions(parseFeedAddress(address).url);
  assert.deepEqual(options('https://github.com/Raed-Alghamdi/OpenDoc-Desktop'), { provider: 'github', owner: 'Raed-Alghamdi', repo: 'OpenDoc-Desktop' });
  assert.deepEqual(options('https://github.com/RyanYahya/OpenDoc/releases'), { provider: 'github', owner: 'RyanYahya', repo: 'OpenDoc' });
  assert.deepEqual(options('http://127.0.0.1:8099/github-like'), { provider: 'github', owner: builtInRepository.owner, repo: builtInRepository.repo, host: '127.0.0.1:8099', protocol: 'http' });
  // The generic provider needs a folder: a trailing slash, and no query or fragment.
  assert.deepEqual(options('http://127.0.0.1:8099/generic'), { provider: 'generic', url: 'http://127.0.0.1:8099/generic/' });
  assert.deepEqual(options('https://example.org/feed/?token=1#x'), { provider: 'generic', url: 'https://example.org/feed/' });
  // Only a loopback address may use the GitHub-shaped test layout.
  assert.equal(options('https://example.org/github-like').provider, 'generic');
  assert.equal(options('https://github.com/just-an-owner').provider, 'generic');
});

test('the repository comes from app-update.yml when it names a GitHub one', () => {
  const text = 'owner: Raed-Alghamdi\nrepo: OpenDoc-Desktop\nprovider: github\nupdaterCacheDirName: opendoc-desktop-updater\n';
  assert.deepEqual(repositoryFromUpdateConfig(text), { owner: 'Raed-Alghamdi', repo: 'OpenDoc-Desktop' });
  assert.equal(repositoryFromUpdateConfig('provider: generic\nurl: https://example.org/\n'), null);
  assert.equal(repositoryFromUpdateConfig(null), null);
  assert.equal(repositoryFromUpdateConfig('provider: github\nowner: x\n'), null);
});

test('release pages: a github address in config.json wins, then app-update.yml, then the fork', () => {
  const feed = new URL('https://github.com/RyanYahya/OpenDoc');
  assert.deepEqual(releaseRepository({ feed, packaged: { owner: 'a', repo: 'b' } }), { owner: 'RyanYahya', repo: 'OpenDoc' });
  assert.deepEqual(releaseRepository({ feed: new URL('https://example.org/feed'), packaged: { owner: 'a', repo: 'b' } }), { owner: 'a', repo: 'b' });
  assert.deepEqual(releaseRepository({ feed: new URL('http://127.0.0.1:8099/github-like'), packaged: null }), builtInRepository);
  assert.deepEqual(releaseRepository(), builtInRepository);
});

test('the release page link is .../releases/tag/desktop-v<version>-<build>', () => {
  assert.equal(releaseTag('0.6.1', 2), 'desktop-v0.6.1-2');
  assert.equal(releasePageUrl({ owner: 'Raed-Alghamdi', repo: 'OpenDoc-Desktop' }, '0.6.1', 2), 'https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/tag/desktop-v0.6.1-2');
  assert.equal(releasePageUrl({ owner: 'a b', repo: 'c' }, '1.0.0/../x', 3), 'https://github.com/a%20b/c/releases/tag/desktop-v1.0.0%2F..%2Fx-3');
});

const sha = 'a'.repeat(86) + '==';
const files = (...urls) => ({ version: '0.6.1', build: 2, files: urls.map(url => ({ url, sha512: sha, size: 1 })) });

test('a release must list a file for the install type, and the file must have a checksum', () => {
  const info = files('opendoc-desktop-x86_64.AppImage', 'opendoc-desktop_0.6.1-2_amd64.deb', 'opendoc-desktop-0.6.1-2-x86_64.pacman');
  assert.equal(releaseFileFor('appimage', info).ok, true);
  assert.equal(releaseFileFor('deb', info).file.url, 'opendoc-desktop_0.6.1-2_amd64.deb');
  assert.equal(releaseFileFor('pacman', info).ok, true);
  for (const type of ['rpm', 'mac']) assert.deepEqual([releaseFileFor(type, info).ok, releaseFileFor(type, info).reason], [false, 'no-file']);
  assert.equal(releaseFileFor('managed', info).ok, false);
});

test('a file without a checksum is not offered', () => {
  const info = { version: '0.6.1', build: 2, files: [{ url: 'opendoc-desktop-x86_64.AppImage' }] };
  assert.equal(releaseFileFor('appimage', info).reason, 'no-checksum');
  assert.equal(releaseFileFor('appimage', { ...info, files: [{ url: 'x.AppImage', sha512: '' }] }).reason, 'no-checksum');
});

test('file names are matched on the path: case, query strings and encoded characters do not matter', () => {
  assert.equal(releaseFileFor('deb', files('dl/OpenDoc%20Desktop.DEB?x=1')).ok, true);
  assert.equal(releaseFileFor('deb', files('notes.deb.txt')).ok, false);
});

test('the older single-file form of metadata (path and sha512) counts', () => {
  assert.equal(releaseFileFor('appimage', { version: '0.6.1', path: 'x.AppImage', sha512: sha }).ok, true);
  assert.deepEqual(metadataFiles({ version: '1' }), []);
});

test('an Intel Mac is never given an arm64 zip, and an arm64 Mac may take either', () => {
  const both = files('opendoc-desktop-0.6.1-2-arm64.zip', 'opendoc-desktop-0.6.1-2-x64.zip');
  assert.equal(releaseFileFor('mac', both, { arch: 'x64' }).file.url, 'opendoc-desktop-0.6.1-2-x64.zip');
  assert.equal(releaseFileFor('mac', files('opendoc-desktop-0.6.1-2-arm64.zip'), { arch: 'x64' }).reason, 'no-file');
  assert.equal(releaseFileFor('mac', files('opendoc-desktop-0.6.1-2-x64.zip'), { arch: 'arm64' }).ok, true);
});

test('a release that names a file by an absolute address is not offered, whatever else it lists', () => {
  for (const url of ['https://example.org/dl/x.deb', 'http://127.0.0.1:9/x.deb', '//example.org/x.deb', 'file:///tmp/x.deb', 'ftp://example.org/x.deb', 'dl\\x.deb']) {
    const found = releaseFileFor('deb', files(url));
    assert.deepEqual([found.ok, found.reason], [false, 'foreign-url'], url);
  }
  // One foreign entry spoils the release, even for another type: electron-updater could pick it.
  const mixed = files('opendoc-desktop_0.6.1-2_amd64.deb', 'https://example.org/evil.AppImage');
  assert.equal(releaseFileFor('deb', mixed).reason, 'foreign-url');
  assert.equal(releaseFileFor('deb', { version: '0.6.1', path: 'https://example.org/x.deb', sha512: sha }).reason, 'foreign-url');
  assert.equal(isAbsoluteUrl('opendoc-desktop-x86_64.AppImage'), false);
  assert.equal(isAbsoluteUrl('sub/folder/x.deb'), false);
});
