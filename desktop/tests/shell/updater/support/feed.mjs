// A local update feed for the updater's tests: the Python feed server on loopback (desktop/scripts/update-feed-server.py), update
// metadata the way the release build writes it (electron-builder's file plus the top-level `build:` and `commit:`), and its request log.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopDir } from '../../support/paths.mjs';

const server = join(desktopDir, 'scripts', 'update-feed-server.py');

export const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');

/** Start the feed server on a free loopback port over `root`. Resolves { port, root, url, githubLikeUrl, requests(), stop() }. */
export async function startFeed(root) {
  await mkdir(join(root, 'generic'), { recursive: true });
  const child = spawn('python3', [server, root, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((accept, reject) => {
    let text = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`The feed server exited (${code}).`)));
    child.stdout.on('data', chunk => {
      text += chunk;
      const line = text.split('\n')[0];
      if (text.includes('\n')) accept(JSON.parse(line).port);
    });
  });
  return {
    port,
    root,
    url: `http://127.0.0.1:${port}/generic/`,
    githubLikeUrl: `http://127.0.0.1:${port}/github-like`,
    /** Every request the server saw, oldest first. */
    requests: async () => (await readFile(join(root, 'requests.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async stop() {
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
    },
  };
}

/** update metadata text: electron-builder's fields, then the build number and commit the release build adds. */
export function metadata({ version = '0.6.1', build, commit = '0123456789abcdef0123456789abcdef01234567', files }) {
  const list = files.map(file => `  - url: ${file.name}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`).join('');
  return `version: ${version}\n${build === undefined ? '' : `build: ${build}\n`}${build === undefined ? '' : `commit: ${commit}\n`}files:\n${list}path: ${files[0].name}\nsha512: ${files[0].sha512}\nreleaseDate: '2026-11-18T12:00:00.000Z'\n`;
}

/**
 * Publish a release into the feed's generic folder: write each file, then latest-linux.yml listing them.
 * `files` are { name, bytes }; `corrupt: name` serves that file with its last byte changed while the metadata keeps the real checksum.
 * Resolves the metadata's file entries.
 */
export async function publish(feed, { version, build, files, corrupt = null, channel = 'latest-linux.yml' }) {
  const entries = [];
  for (const file of files) {
    const bytes = Buffer.from(file.bytes);
    const served = file.name === corrupt ? Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1) ^ 0xff])]) : bytes;
    await writeFile(join(feed.root, 'generic', file.name), served);
    entries.push({ name: file.name, sha512: sha512(bytes), size: bytes.length });
  }
  await writeFile(join(feed.root, 'generic', channel), metadata({ version, build, files: entries }));
  return entries;
}

/** Some bytes that stand in for a package. */
export const fakePackage = (size = 200_000) => randomBytes(size);

/** The folder holds no file named `name` any more (a download that was refused leaves nothing behind). */
export async function absent(folder, name) {
  return stat(join(folder, name)).then(() => false, () => true);
}

export const removeFeed = root => rm(root, { recursive: true, force: true });
