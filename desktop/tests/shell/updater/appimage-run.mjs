#!/usr/bin/env node
// The real AppImage update, build 1 to build 2, on a virtual display with a scratch HOME (plan E7). Not part of `pnpm verify`: it needs
// two AppImages built by electron-builder, so it is run by hand:
//
//   node desktop/tests/shell/updater/appimage-run.mjs --first <build 1 output folder> --second <build 2 output folder> --work <empty scratch folder>
//
// Each output folder holds `opendoc-desktop-x86_64.AppImage`, electron-builder's `latest-linux.yml` and `linux-unpacked/` (whose
// resources/runtime/build-info.json gives the build number; the script adds `build:` and `commit:` to the metadata, as the release build does).
//
// Case 1: build 1 runs with `updateFeed` pointing at a loopback feed that offers build 2. It downloads the update, the app is quit
//   (SIGTERM), the AppImage file is now build 2, ~/.local/bin/opendoc (in the scratch HOME) still works, and the next launch is build 2.
// Case 2: the feed serves a build 2 file whose bytes are corrupted while the metadata keeps the real SHA-512. The update is refused,
//   the AppImage stays build 1, nothing is installed, and the next launch is build 1.
// Case 3: the AppImage's folder is made read-only after the download, so staging the new file beside the AppImage fails at quit. The
//   old AppImage is untouched and still runs (nothing is unlinked first, no temporary file is left), and once the folder is writable
//   again the next launch tells the user once why the swap failed, and swaps in the download it kept.
// Every launch is `xvfb-run` inside `timeout -s KILL`, with the Claude app's display and Electron variables removed. It never touches the real HOME.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { strippedVariables } from '../support/environment.mjs';
import { startFeed } from './support/feed.mjs';

const { values } = parseArgs({ options: { first: { type: 'string' }, second: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean', default: false } } });
if (!values.first || !values.second || !values.work) {
  console.error('Usage: appimage-run.mjs --first <build 1 output> --second <build 2 output> --work <empty scratch folder> [--keep]');
  process.exit(2);
}
const appName = 'opendoc-desktop-x86_64.AppImage';
const work = resolve(values.work);
const problems = [];
const check = (condition, what, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!condition) problems.push(what);
};
const pause = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));
const hashFile = file => new Promise((accept, reject) => {
  const hash = createHash('sha512');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => accept(hash.digest('base64'))).on('error', reject);
});

async function describeBuild(folder) {
  const dir = resolve(folder);
  const info = JSON.parse(await readFile(join(dir, 'linux-unpacked', 'resources', 'runtime', 'build-info.json'), 'utf8'));
  return { dir, file: join(dir, appName), build: info.build, commit: info.commit, sha512: await hashFile(join(dir, appName)), size: (await stat(join(dir, appName))).size };
}

/** latest-linux.yml with the top-level build and commit lines the release build adds. */
async function stampedMetadata(release) {
  const text = await readFile(join(release.dir, 'latest-linux.yml'), 'utf8');
  return text.replace(/^(version: .*)$/m, `$1\nbuild: ${release.build}\ncommit: ${release.commit}`);
}

async function publish(feed, release, { corrupt = false } = {}) {
  const generic = join(feed.root, 'generic');
  await rm(generic, { recursive: true, force: true });
  await mkdir(generic, { recursive: true });
  if (corrupt) {
    // One byte in every 4096 is changed, so every range the app asks for is wrong somewhere; the metadata keeps the real checksum.
    const bytes = await readFile(release.file);
    for (let at = 100; at < bytes.length; at += 4096) bytes[at] ^= 0xff;
    await writeFile(join(generic, appName), bytes);
  } else {
    await copyFile(release.file, join(generic, appName), constants.COPYFILE_FICLONE);
  }
  await writeFile(join(generic, 'latest-linux.yml'), await stampedMetadata(release));
}

/** A scratch HOME with XDG folders and the AppImage of `release` installed in its own folder. */
async function scratchHome(name, release, feed) {
  const home = join(work, name, 'home');
  const apps = join(work, name, 'apps');
  const runtimeDir = join(work, name, 'run');
  for (const folder of [home, apps, join(home, '.config', 'opendoc-desktop'), join(home, '.local', 'share'), join(home, '.cache')]) await mkdir(folder, { recursive: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(home, '.config', 'opendoc-desktop', 'config.json'), JSON.stringify({ updateFeed: feed.url }, null, 2));
  const appImage = join(apps, appName);
  await copyFile(release.file, appImage, constants.COPYFILE_FICLONE);
  await chmod(appImage, 0o755);
  const env = { ...process.env };
  for (const variable of [...strippedVariables, 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY']) delete env[variable];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: runtimeDir, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, GDK_SCALE: '1' });
  return {
    home, appImage, env,
    updaterLog: join(home, '.config', 'opendoc-desktop', 'logs', 'updater.log'),
    pending: join(home, '.cache', 'opendoc-desktop-updater', 'pending'),
    config: join(home, '.config', 'opendoc-desktop', 'config.json'),
    command: join(home, '.local', 'bin', 'opendoc'),
  };
}

const logText = async (scratch, offset = 0) => (await readFile(scratch.updaterLog, 'utf8').catch(() => '')).slice(offset);
const logSize = async scratch => (await readFile(scratch.updaterLog, 'utf8').catch(() => '')).length;

/** The processes under `root` (pid, ppid, command line). */
function descendants(root) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').filter(Boolean).map(line => {
    const [, pid, ppid, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: Number(pid), ppid: Number(ppid), args };
  });
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (found.has(row.ppid) && !found.has(row.pid)) { found.add(row.pid); grew = true; }
  }
  return rows.filter(row => found.has(row.pid));
}

/** Start the AppImage on a virtual display. The app is signalled to quit by quit(). */
function launch(scratch, label) {
  const output = join(work, `${label}.out`);
  const command = ['nice', '-n', '19', 'ionice', '-c', '3', 'timeout', '-s', 'KILL', '300', 'xvfb-run', '-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp',
    'env', ...strippedVariables.flatMap(name => ['-u', name]), '-u', 'ELECTRON_RUN_AS_NODE', scratch.appImage, '--ozone-platform=x11'];
  const child = spawn(command[0], command.slice(1), { env: scratch.env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const exited = new Promise(accept => child.once('exit', (code, signal) => accept({ code, signal })));
  return {
    label,
    exited,
    pid: child.pid,
    /** SIGTERM to the app's main process (the one without --type=), the way a desktop session ends it. */
    quit() {
      const main = descendants(child.pid).find(row => /opendoc-desktop(\s|$)/.test(row.args.split(' ')[0] ?? '') && !/--type=/.test(row.args));
      if (!main) throw new Error(`${label}: the app's main process is not running`);
      process.kill(main.pid, 'SIGTERM');
    },
    kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } },
    output,
  };
}

async function until(what, condition, { seconds = 240, run } = {}) {
  const end = Date.now() + seconds * 1000;
  let finished = null;
  run?.exited.then(result => { finished = result; });
  while (Date.now() < end) {
    if (await condition()) return true;
    if (finished) { console.log(`   (${run.label} exited early: ${JSON.stringify(finished)})`); return false; }
    await pause(500);
  }
  console.log(`   (timed out waiting for ${what})`);
  return false;
}

async function quit(run, seconds = 90) {
  run.quit();
  const result = await Promise.race([run.exited, pause(seconds * 1000).then(() => null)]);
  if (!result) { run.kill(); return null; }
  return result;
}

/** `~/.local/bin/opendoc` of the scratch HOME runs: --help prints and exits 0. */
function runCommand(scratch) {
  const result = spawnSync('timeout', ['-s', 'KILL', '120', 'nice', '-n', '19', 'ionice', '-c', '3', scratch.command, '--help'], { env: scratch.env, encoding: 'utf8' });
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
}

const pathOf = request => request.path.split('?')[0];
const runtimeFolders = async scratch => (await readdir(join(scratch.home, '.local', 'share', 'opendoc-desktop', 'runtime')).catch(() => [])).filter(name => !name.startsWith('.'));

const launches = [];
let feed;
try {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const first = await describeBuild(values.first);
  const second = await describeBuild(values.second);
  console.log(`build ${first.build}: ${first.size} bytes; build ${second.build}: ${second.size} bytes`);
  if (!(second.build > first.build)) throw new Error('The second folder must be a newer build than the first.');

  // ---------- case 1: build 1 updates itself to build 2 ----------
  console.log('\nCase 1: build 1 updates to build 2');
  feed = await startFeed(join(work, 'feed-good'));
  await publish(feed, second);
  const good = await scratchHome('good', first, feed);
  const before = await hashFile(good.appImage);
  check(before === first.sha512, 'the installed AppImage starts as build 1');

  let run = launch(good, 'good-1');
  launches.push(run);
  const downloaded = await until('the download', async () => /Z downloaded /.test(await logText(good)), { run });
  check(downloaded, 'build 1 found build 2 and downloaded it', `feed on port ${feed.port}`);
  check(/swap at quit/.test(await logText(good)) === false, 'nothing is swapped while the app runs');
  check(await hashFile(good.appImage) === first.sha512, 'the AppImage file is still build 1 while the app runs');
  const exit1 = await quit(run);
  check(exit1 !== null, 'the app quit on SIGTERM', exit1 ? JSON.stringify(exit1) : 'it had to be killed');
  const text1 = await logText(good);
  check(/swap at quit: done/.test(text1), 'the swap ran at quit');
  check(await hashFile(good.appImage) === second.sha512, 'the AppImage file is now build 2 (SHA-512 of the metadata)');
  check(((await stat(good.appImage)).mode & 0o111) !== 0, 'the AppImage is still executable');
  check((await readdir(join(good.appImage, '..'))).join(',') === appName, 'the AppImage folder holds the AppImage and nothing else (no staging file)', (await readdir(join(good.appImage, '..'))).join(', '));
  check(!/Executing:|APPIMAGE_EXIT_AFTER_INSTALL/.test(text1), 'the new AppImage was not run by the swap');
  check(await readFile(good.command, 'utf8').then(text => text.includes(`APPIMAGE=${good.appImage}`) || text.includes(good.appImage), () => false), '~/.local/bin/opendoc points at the same AppImage path');
  const cli = runCommand(good);
  check(cli.status === 0 && cli.text.length > 20, '~/.local/bin/opendoc works after the swap', `exit ${cli.status}`);
  check((await runtimeFolders(good)).some(name => name.endsWith(`-${second.build}`)), 'the command ran build 2 (its runtime copy is for build 2)', (await runtimeFolders(good)).join(', '));

  const mark = await logSize(good);
  run = launch(good, 'good-2');
  launches.push(run);
  const relaunched = await until('the relaunch check', async () => /no newer build/.test(await logText(good, mark)), { run });
  check(relaunched, 'the relaunched AppImage ran and checked again');
  const text2 = await logText(good, mark);
  check(new RegExp(`updated from 0\\.6\\.1, build ${first.build} to 0\\.6\\.1, build ${second.build}`).test(text2), `the relaunch is build ${second.build}: the app logs the update from build ${first.build}`);
  const config = JSON.parse(await readFile(good.config, 'utf8'));
  check(config.lastRun?.build === second.build, 'config.json records the last run as build 2', JSON.stringify(config.lastRun));
  const exit2 = await quit(run);
  check(exit2 !== null, 'the relaunched app quit on SIGTERM');
  check(await hashFile(good.appImage) === second.sha512, 'the AppImage stays build 2');

  const requests = await feed.requests();
  const paths = requests.map(pathOf);
  console.log(`   requests: ${requests.length}; ${requests.map(request => `${request.method} ${pathOf(request).replace('/generic/', '')}${request.range ? ` [${String(request.range).slice(0, 40)}]` : ''} ${request.status} ${request.sent}B`).slice(0, 12).join(' | ')}${requests.length > 12 ? ' | ...' : ''}`);
  check(requests.length > 0 && paths[0] === '/generic/latest-linux.yml', 'the first request is the update metadata');
  check(paths.every(path => path === '/generic/latest-linux.yml' || path === `/generic/${appName}` || path === `/generic/${appName}.blockMap`), 'only the metadata and the release file were requested', [...new Set(paths)].join(', '));
  check(requests.every(request => request.status === 200 || request.status === 206), 'every request was answered 200 or 206');
  check(paths.filter(path => path.endsWith('.yml')).length === 2, 'the metadata was asked for twice: once per launch');
  check(paths.at(-1) === '/generic/latest-linux.yml', 'the last request is the relaunch check: build 2 downloaded nothing more');
  const bytes = requests.filter(request => pathOf(request).endsWith('.AppImage')).reduce((sum, request) => sum + request.sent, 0);
  console.log(`   downloaded ${bytes} bytes of a ${second.size} byte file${bytes < second.size ? ' (a differential download)' : ''}`);
  await feed.stop();
  feed = null;

  // ---------- case 3: staging fails at quit ----------
  console.log('\nCase 3: the AppImage folder turns read-only after the download');
  feed = await startFeed(join(work, 'feed-locked'));
  await publish(feed, second);
  const locked = await scratchHome('locked', first, feed);
  const lockedFolder = join(locked.appImage, '..');
  try {
    run = launch(locked, 'locked-1');
    launches.push(run);
    check(await until('the download', async () => /Z downloaded /.test(await logText(locked)), { run }), 'build 1 downloaded build 2');
    await chmod(lockedFolder, 0o555);
    const exitLocked = await quit(run);
    check(exitLocked !== null, 'the app quit on SIGTERM', exitLocked ? JSON.stringify(exitLocked) : 'it had to be killed');
    const textLocked = await logText(locked);
    check(/The AppImage was not replaced, the current one is untouched/.test(textLocked), 'the failed swap is logged', (textLocked.split('\n').find(line => /not replaced/.test(line)) ?? '').slice(0, 160));
    check(await hashFile(locked.appImage) === first.sha512, 'the old AppImage is untouched (SHA-512 unchanged)');
    check((await readdir(lockedFolder)).join(',') === appName, 'no staging file is left in the folder');
    await chmod(lockedFolder, 0o755);
    const cliLocked = runCommand(locked);
    check(cliLocked.status === 0, '~/.local/bin/opendoc still works with the old AppImage', `exit ${cliLocked.status}`);
    check((await runtimeFolders(locked)).every(name => name.endsWith(`-${first.build}`)) && (await runtimeFolders(locked)).length > 0, 'the command ran build 1', (await runtimeFolders(locked)).join(', '));

    const markLocked = await logSize(locked);
    run = launch(locked, 'locked-2');
    launches.push(run);
    check(await until('the kept download', async () => /Z downloaded /.test(await logText(locked, markLocked)), { run }), 'the old AppImage starts and has the kept download ready again');
    check(/the last update could not be installed: .*EACCES/.test(await logText(locked, markLocked)), 'the next launch noticed the failed swap and says why (once)');
    check(JSON.parse(await readFile(locked.config, 'utf8')).updateNotices?.swapFailed === undefined, 'the record is cleared once it was shown');
    check(await quit(run) !== null, 'it quit on SIGTERM');
    check(await hashFile(locked.appImage) === second.sha512, 'with the folder writable again the swap succeeded (build 2)');
  } finally { await chmod(lockedFolder, 0o755).catch(() => {}); }
  await feed.stop();
  feed = null;

  // ---------- case 2: a corrupted build 2 is refused ----------
  console.log('\nCase 2: a corrupted build 2 is refused and build 1 stays');
  feed = await startFeed(join(work, 'feed-corrupt'));
  await publish(feed, second, { corrupt: true });
  const bad = await scratchHome('corrupt', first, feed);
  run = launch(bad, 'corrupt-1');
  launches.push(run);
  const refused = await until('the refusal', async () => /checksum mismatch|sha512/i.test(await logText(bad)), { run });
  check(refused, 'the corrupted download was refused', (await logText(bad)).split('\n').find(line => /checksum|sha512/i.test(line)) ?? '');
  await pause(3000);
  const textBad = await logText(bad);
  check(!/Z downloaded /.test(textBad), 'no update was reported as downloaded');
  check(await readdir(bad.pending).then(names => !names.some(name => name.endsWith('.AppImage')), () => true), 'the refused file is not left in the cache');
  const exitBad = await quit(run);
  check(exitBad !== null, 'the app quit on SIGTERM');
  check(!/swap at quit: done/.test(await logText(bad)), 'nothing was swapped at quit');
  check(await hashFile(bad.appImage) === first.sha512, 'the AppImage file is still build 1');
  const cliBad = runCommand(bad);
  check(cliBad.status === 0, '~/.local/bin/opendoc still works', `exit ${cliBad.status}`);
  check((await runtimeFolders(bad)).every(name => name.endsWith(`-${first.build}`)) && (await runtimeFolders(bad)).length > 0, 'the command ran build 1', (await runtimeFolders(bad)).join(', '));

  const markBad = await logSize(bad);
  run = launch(bad, 'corrupt-2');
  launches.push(run);
  const again = await until('the second launch to check', async () => /found |checksum|sha512|no newer/i.test(await logText(bad, markBad)), { run });
  check(again, 'build 1 starts again and checks again');
  const textAgain = await logText(bad, markBad);
  check(!/updated from/.test(textAgain), 'the second launch is still build 1 (no "updated from" in the log)');
  const configBad = JSON.parse(await readFile(bad.config, 'utf8'));
  check(configBad.lastRun?.build === first.build, 'config.json records the last run as build 1', JSON.stringify(configBad.lastRun));
  await quit(run);
  check(await hashFile(bad.appImage) === first.sha512, 'the AppImage is still build 1 after the second launch');
  const badPaths = (await feed.requests()).map(pathOf);
  check(badPaths.every(path => path === '/generic/latest-linux.yml' || path === `/generic/${appName}` || path === `/generic/${appName}.blockMap`), 'only the metadata and the release file were requested', [...new Set(badPaths)].join(', '));
} catch (error) {
  console.error(`ERROR ${error.stack ?? error}`);
  problems.push(String(error.message));
} finally {
  for (const run of launches) run.kill();
  await feed?.stop();
  await pause(500);
  const left = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(work) && !line.includes('appimage-run.mjs'));
  if (left.length) console.log(`Processes still running from ${work}:\n${left.join('\n')}`);
  if (!values.keep) await rm(work, { recursive: true, force: true });
}

console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join('; ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
