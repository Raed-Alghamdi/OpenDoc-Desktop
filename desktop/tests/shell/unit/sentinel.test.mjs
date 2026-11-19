// The sentinel script (transport.mjs) run straight under every POSIX shell this machine has. dash, the /bin/sh of
// Debian and Ubuntu, rejects `kill -0 -- -PID` and `kill -s 0 -PID`, and busybox sh rejects any `--`, so the script uses
// the one form all of them accept: `kill -0 -PID` and `kill -KILL -PID`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { sentinelScript } from '../../../src/main/transport.mjs';

const pause = ms => new Promise(accept => setTimeout(accept, ms));
const until = async (check, limit = 6000) => { const end = Date.now() + limit; while (Date.now() < end) { if (await check()) return true; await pause(50); } return false; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = group => { try { process.kill(-group, 0); return true; } catch { return false; } };

// Each candidate is the command that runs a script: `<command> -c <script> name args...`.
const candidates = [['/bin/sh'], ['/usr/bin/dash'], ['dash'], ['bash', '--posix'], ['busybox', 'sh']];
const found = candidates.filter(command => {
  const probe = spawnSync(command[0], [...command.slice(1), '-c', 'exit 0'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
});
console.log(`sentinel shells run: ${found.map(command => command.join(' ')).join(', ') || 'none'}; skipped: ${candidates.filter(command => !found.includes(command)).map(command => command.join(' ')).join(', ') || 'none'}`);

/** An "app" (a plain process) and a "host" group (a leader and one member in their own group), plus the sentinel under `command`. */
function scene(command) {
  const app = spawn('sleep', ['300'], { stdio: 'ignore' });
  const host = spawn('/bin/sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore', detached: true });
  const sentinel = spawn(command[0], [...command.slice(1), '-c', sentinelScript, 'opendoc-sentinel', String(app.pid), String(host.pid)], { stdio: 'ignore', detached: true });
  let exited = false;
  sentinel.on('exit', () => { exited = true; });
  const clean = () => {
    for (const pid of [app.pid, sentinel.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(-host.pid, 'SIGKILL'); } catch { /* gone */ }
  };
  return { app, host: host.pid, sentinel, exited: () => exited, clean };
}

const shellName = command => command.join(' ');
const skipped = process.platform === 'win32' && 'the sentinel is a POSIX shell script';

for (const command of found) {
  test(`sentinel under ${shellName(command)}: it keeps watching while both live, and kills the host's group when the app dies`, { skip: skipped }, async () => {
    const { app, host, exited, clean } = scene(command);
    try {
      await pause(1800); // longer than one poll: a script the shell rejects ends here, without killing anything
      assert.equal(exited(), false, 'the sentinel still watches (it did not end at once)');
      assert.equal(groupAlive(host), true);
      process.kill(app.pid, 'SIGKILL');
      assert.equal(await until(() => !groupAlive(host)), true, 'the whole group is killed once the app is gone');
      assert.equal(await until(exited), true, 'and the sentinel ends');
    } finally { clean(); }
  });

  test(`sentinel under ${shellName(command)}: it ends when the group is gone while the app lives, and kills nothing else`, { skip: skipped }, async () => {
    const { app, host, exited, clean } = scene(command);
    try {
      await pause(1800);
      assert.equal(exited(), false, 'the sentinel still watches (it did not end at once)');
      process.kill(-host, 'SIGKILL');
      assert.equal(await until(exited), true, 'the sentinel ends once the group is gone');
      assert.equal(alive(app.pid), true, 'the app is untouched');
    } finally { clean(); }
  });
}

test('the script uses the form every shell accepts (no `--`, no `-s` before a group)', () => {
  assert.doesNotMatch(sentinelScript, /--|kill -s/);
  assert.match(sentinelScript, /kill -0 "-\$2"/);
  assert.match(sentinelScript, /kill -KILL "-\$2"/);
});
