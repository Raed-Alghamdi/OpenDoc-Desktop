// Reading the app's own package.json from inside a built artifact, to find out whether it is a test build (runtime/test-build.mjs).
// An installer holds app.asar; app.asar is Electron's archive format (a header with the file table, then the files). Only what is
// needed is read: no extraction of the whole app, and nothing is run except the AppImage runtime's own extract flag.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testBuildField } from '../../runtime/test-build.mjs';

/** One file from an asar archive (a Buffer), or null when it is not in it. Throws when the buffer is not an asar archive. */
export function readAsarFile(archive, name) {
  // Layout: UInt32 4, UInt32 size of the header pickle, UInt32 payload size, UInt32 JSON length, the JSON, then the file data.
  if (archive.length < 16 || archive.readUInt32LE(0) !== 4) throw new Error('not an asar archive');
  const headerSize = archive.readUInt32LE(4);
  const jsonLength = archive.readUInt32LE(12);
  if (16 + jsonLength > archive.length) throw new Error('the asar header is cut short');
  const header = JSON.parse(archive.toString('utf8', 16, 16 + jsonLength));
  let entry = header;
  for (const part of name.split('/')) entry = entry?.files?.[part];
  if (!entry || entry.files || entry.link) return null;
  const start = 8 + headerSize + Number(entry.offset);
  if (entry.unpacked) throw new Error(`${name} is stored outside the archive`);
  return archive.subarray(start, start + entry.size);
}

/** The test build field in a package.json text: { present, value }. Present means the key exists, whatever its value. */
export function testBuildMark(packageJsonText) {
  const parsed = JSON.parse(packageJsonText);
  return { present: Object.hasOwn(parsed, testBuildField), value: parsed[testBuildField] };
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { maxBuffer: 1 << 30, ...options });
  if (result.error) throw new Error(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed${result.stderr?.length ? `: ${String(result.stderr).trim().split('\n').pop()}` : ''}`);
  return result.stdout;
};

const inDeb = (file, inner) => {
  const members = String(run('ar', ['t', file])).split('\n');
  const data = members.find((entry) => entry.startsWith('data.tar'));
  if (!data) throw new Error('the deb has no data.tar');
  return run('bsdtar', ['-xOf', '-', `./${inner}`], { input: run('ar', ['p', file, data]) });
};
const inRpm = (file, inner) => run('bsdtar', ['-xOf', '-', `./${inner}`], { input: run('rpm2cpio', [file]) });
const inTar = (file, inner) => run('bsdtar', ['-xOf', file, inner]);
const inZip = (file) => {
  const member = String(run('bsdtar', ['-tf', file])).split('\n').find((entry) => /\.app\/Contents\/Resources\/app\.asar$/.test(entry));
  if (!member) throw new Error('no app.asar in the zip');
  return run('bsdtar', ['-xOf', file, member]);
};
const inAppImage = (file) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-appasar-'));
  try {
    // The AppImage runtime's own extract flag: it unpacks files and starts nothing. It runs from an executable copy, because a file
    // from actions/download-artifact has lost its mode bits (the release job reads downloaded files).
    const copy = path.join(scratch, 'artifact.AppImage');
    copyFileSync(file, copy);
    chmodSync(copy, 0o755);
    run(copy, ['--appimage-extract', 'resources/app.asar'], { cwd: scratch, timeout: 120_000 });
    return readFileSync(path.join(scratch, 'squashfs-root', 'resources', 'app.asar'));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
};

const appAsar = 'opt/opendoc-desktop/resources/app.asar';

/** What kind of installer a file is, or null for anything else (metadata, block maps). */
export const installerKind = (file) => {
  if (file.endsWith('.deb')) return 'deb';
  if (file.endsWith('.rpm')) return 'rpm';
  if (file.endsWith('.pacman')) return 'pacman';
  if (file.endsWith('.AppImage')) return 'AppImage';
  if (file.endsWith('.zip')) return 'zip';
  if (file.endsWith('.dmg')) return 'dmg';
  return null;
};

/**
 * Read the test build mark of one installer: { present, value }. A dmg cannot be opened without macOS (its app is the one in the
 * zip and in the unpacked .app, which are checked), so it gives { skipped: true }.
 * Throws when the archive cannot be read: an artifact that cannot be read is not a verified release artifact.
 */
export function installerTestBuildMark(file) {
  const kind = installerKind(file);
  if (kind === 'dmg') return { skipped: true };
  const asar = { deb: () => inDeb(file, appAsar), rpm: () => inRpm(file, appAsar), pacman: () => inTar(file, appAsar), AppImage: () => inAppImage(file), zip: () => inZip(file) }[kind]?.();
  if (!asar) throw new Error('not an installer this check knows');
  const packageJson = readAsarFile(asar, 'package.json');
  if (!packageJson) throw new Error('app.asar has no package.json');
  return testBuildMark(packageJson.toString('utf8'));
}

/** Every file under the given files and folders, sorted, that is an installer (links and folders are walked, not followed). */
export function installersUnder(paths) {
  const found = [];
  const walk = (entry) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) { for (const name of readdirSync(entry).sort()) walk(path.join(entry, name)); return; }
    if (installerKind(entry)) found.push(entry);
  };
  for (const entry of paths) walk(entry);
  return found;
}
