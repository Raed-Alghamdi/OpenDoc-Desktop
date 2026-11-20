// The release address rules, the release page link and the files a release must list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtInRepository, feedLabel, feedProviderOptions, isBuiltInFeed, parseFeedAddress, releasePageUrl, releaseRepository, repositoryFromUpdateConfig, releaseTag, updateConfigIsLoopback } from '../../../src/main/updater/feed.mjs';
import { isForeignUrl, malformedMetadata, metadataFiles, releaseFileFor } from '../../../src/main/updater/release-files.mjs';

test('https addresses are accepted', () => {
  for (const address of ['https://github.com/Raed-Alghamdi/OpenDoc-Desktop', 'https://updates.example.org/opendoc/', 'https://example.org:8443/feed']) assert.equal(parseFeedAddress(address).ok, true, address);
});

test('plain http is accepted for loopback addresses only', () => {
  for (const address of ['http://127.0.0.1:8099/generic/', 'http://localhost:8099/', 'http://[::1]:8099/feed']) assert.equal(parseFeedAddress(address, { allowLoopback: true }).ok, true, address);
  for (const address of ['http://example.org/feed', 'http://192.168.1.5/feed', 'http://127.0.0.2/feed', 'http://127.0.0.1.example.org/feed', 'http://0.0.0.0/feed', 'http://localhost.example.org/']) {
    const result = parseFeedAddress(address, { allowLoopback: true });
    assert.equal(result.ok, false, address);
    assert.match(result.message, /https/);
  }
});

test('a build that is not for tests refuses plain http even on loopback, and still accepts https', () => {
  for (const address of ['http://127.0.0.1:8099/generic/', 'http://localhost:8099/', 'http://[::1]:8099/feed']) {
    const result = parseFeedAddress(address);
    assert.equal(result.ok, false, address);
    assert.match(result.message, /not accepted by this build/);
    assert.equal(parseFeedAddress(address, { allowLoopback: false }).ok, false, address);
  }
  assert.equal(parseFeedAddress('https://updates.example.org/opendoc/').ok, true);
  assert.equal(parseFeedAddress('https://127.0.0.1:8443/feed').ok, true, 'https on loopback is https');
});

test('a feed is named by its origin (a GitHub repository by owner and name), and the built-in repository is not a different feed', () => {
  const options = address => feedProviderOptions(parseFeedAddress(address, { allowLoopback: true }).url);
  assert.equal(feedLabel(options('https://updates.example.org:8443/opendoc/feed?x=1')), 'https://updates.example.org:8443');
  assert.equal(feedLabel(options('https://github.com/Someone/Fork/releases')), 'https://github.com/Someone/Fork');
  assert.equal(feedLabel(options('http://127.0.0.1:8099/github-like')), 'http://127.0.0.1:8099');
  assert.equal(feedLabel(null), null);
  assert.equal(isBuiltInFeed(options('https://github.com/Raed-Alghamdi/OpenDoc-Desktop'), builtInRepository), true);
  assert.equal(isBuiltInFeed(options('https://github.com/Someone/Fork'), builtInRepository), false);
  assert.equal(isBuiltInFeed(options('https://updates.example.org/feed'), builtInRepository), false);
  assert.equal(isBuiltInFeed(null, builtInRepository), false);
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
  const options = address => feedProviderOptions(parseFeedAddress(address, { allowLoopback: true }).url);
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
  assert.equal(isForeignUrl('opendoc-desktop-x86_64.AppImage'), false);
  assert.equal(isForeignUrl('sub/folder/x.deb'), false);
});

test('the bypasses that new URL() forgives are foreign too: leading space, tab or newline inside, any whitespace or control character, a backslash', () => {
  for (const url of [' http://evil.example/x.deb', 'ht\ttps://evil.example/x.deb', '\nhttps://evil.example/x.deb', 'https://evil.example/x.deb\n', '\u00a0http://evil.example/x.deb', 'h\rttp://evil.example/x.deb', 'a\u0000b.deb', 'x\u007f.deb', 'dir/a b.deb', 'a\\..\\b.deb', '/\\evil.example/x.deb', '', '   ', null, undefined, 42]) {
    assert.equal(isForeignUrl(url), true, JSON.stringify(url));
    if (typeof url === 'string' && url) assert.equal(releaseFileFor('deb', files(url)).reason, 'foreign-url', JSON.stringify(url));
  }
  for (const url of ['//evil.example/x.deb', 'HTTPS://EVIL.EXAMPLE/x.deb', 'http:/evil.example/x.deb'.replace('http:/', 'ftp://'), 'file:///tmp/x.deb', 'data:text/plain,x', 'javascript:alert(1)', 'blob:https://evil.example/uuid']) assert.equal(isForeignUrl(url), true, url);
});

test('plain names are accepted: nested paths, percent escapes, a query, a dot-dot that stays on the feed origin, and a colon in the name (an rpm epoch)', () => {
  for (const url of ['x.deb', 'dir/x.deb', 'OpenDoc%20Desktop.deb', 'x.deb?v=1', '../x.deb', 'pkg-1:2.rpm', 'opendoc-desktop-1:0.6.1-2.x86_64.rpm']) assert.equal(isForeignUrl(url), false, url);
  assert.equal(releaseFileFor('rpm', files('opendoc-desktop-1:0.6.1-2.x86_64.rpm')).ok, true);
});

test('a test app-update.yml on the loopback address is recognised (the generic url, or the github host)', () => {
  assert.equal(updateConfigIsLoopback('provider: generic\nurl: http://127.0.0.1:8099/generic/\n'), true);
  assert.equal(updateConfigIsLoopback('provider: github\nowner: a\nrepo: b\nhost: localhost:8099\nprotocol: http\n'), true);
  assert.equal(updateConfigIsLoopback('provider: generic\nurl: https://updates.example.org/x/\n'), false);
  assert.equal(updateConfigIsLoopback('provider: github\nowner: a\nrepo: b\n'), false);
  assert.equal(updateConfigIsLoopback(undefined), false);
});

test('metadata that is not in the expected shape is refused as a whole, before anything is filtered (an array url reaches another host through new URL)', () => {
  const evil = 'http://evil.example/x.deb';
  assert.equal(new URL([evil], 'https://f/d/').href, evil, 'the premise: new URL coerces an array to its text');
  const cases = {
    'an array as an address': { version: '0.6.1', build: 2, files: [{ url: [evil], sha512: sha }, { url: 'opendoc-desktop_0.6.1-2_amd64.deb', sha512: sha }] },
    'a number as an address': { version: '0.6.1', build: 2, files: [{ url: 7, sha512: sha }, { url: 'x.deb', sha512: sha }] },
    'a missing address': { version: '0.6.1', build: 2, files: [{ sha512: sha }, { url: 'x.deb', sha512: sha }] },
    'a null entry': { version: '0.6.1', build: 2, files: [null, { url: 'x.deb', sha512: sha }] },
    'a text entry': { version: '0.6.1', build: 2, files: ['x.deb', { url: 'x.deb', sha512: sha }] },
    'an array entry': { version: '0.6.1', build: 2, files: [[evil], { url: 'x.deb', sha512: sha }] },
    'a list that is a text with a length': { version: '0.6.1', build: 2, files: 'x.deb' },
    'a list that is an object with a length': { version: '0.6.1', build: 2, files: { length: 1, 0: { url: 'x.deb', sha512: sha } } },
    'a path that is an array': { version: '0.6.1', build: 2, path: [evil], sha512: sha },
    'a path that is an object': { version: '0.6.1', build: 2, files: [], path: { toString: () => evil }, sha512: sha },
    'a packages entry that is an array': { version: '0.6.1', build: 2, files: [{ url: 'x.deb', sha512: sha }], packages: { x64: { path: [evil] } } },
  };
  for (const [label, info] of Object.entries(cases)) {
    assert.ok(malformedMetadata(info), label);
    const found = releaseFileFor('deb', info);
    assert.deepEqual([found.ok, found.reason], [false, 'malformed'], label);
  }
  assert.equal(malformedMetadata({ version: '0.6.1', files: [{ url: 'x.deb', sha512: sha, size: 1 }] }), null);
  assert.equal(malformedMetadata({ version: '0.6.1', path: 'x.deb', sha512: sha }), null);
  assert.equal(malformedMetadata({ version: '0.6.1', files: [], path: 'x.deb' }), null);
  assert.equal(releaseFileFor('deb', files('x.deb')).ok, true);
});

test('a packages entry with a foreign path is refused like a file entry', () => {
  const info = { version: '0.6.1', build: 2, files: [{ url: 'x.deb', sha512: sha }], packages: { x64: { path: 'https://evil.example/p.7z', sha512: sha } } };
  assert.equal(releaseFileFor('deb', info).reason, 'foreign-url');
});

test('against a real feed base, an entry must stay on its origin too: https:evil.example/x.deb leaves an http loopback feed', () => {
  const loopback = 'http://127.0.0.1:8099/generic/';
  assert.equal(new URL('https:evil.example/x.deb', 'https://x.invalid/dir/').hostname, 'x.invalid', 'the premise: the https dummy base reads it as a relative path');
  assert.equal(new URL('https:evil.example/x.deb', loopback).hostname, 'evil.example', 'the premise: the real base does not');
  assert.equal(isForeignUrl('https:evil.example/x.deb'), false, 'the dummy base alone cannot see it');
  assert.equal(isForeignUrl('https:evil.example/x.deb', { base: loopback }), true);
  assert.equal(releaseFileFor('deb', files('https:evil.example/x.deb'), { base: loopback }).reason, 'foreign-url');
  for (const url of ['x.deb', 'dir/x.deb', 'pkg-1:2.rpm', '../x.deb']) assert.equal(isForeignUrl(url, { base: loopback }), false, url);
  assert.equal(isForeignUrl('http:evil.example/x.deb', { base: 'https://updates.example.org/feed/' }), true, 'and the other way round');
  assert.equal(isForeignUrl('x.deb', { base: 'not a url' }), true, 'an unusable base refuses');
  assert.equal(isForeignUrl('x.deb', { base: new URL('https://github.com/') }), false);
});
