import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { runtimeResolve, runtimeSource } from '../runtime/paths';
import { packageIdentity, packageMetadata } from './workspace';
import { withWorkspaceLock } from './lock';
import { validateInstallation } from './check';
import { externalEnv } from '../server/external-env';
import { desktopRecordAdvice, workspaceOwner } from './owner';

async function openBrowser(origin: string) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise<void>(accept => {
    const child = spawn(command, [origin], { stdio: 'ignore', env: externalEnv() });
    child.once('error', () => { console.error(`Open ${origin} in your browser.`); accept(); });
    child.once('exit', code => { if (code) console.error(`Open ${origin} in your browser.`); accept(); });
  });
}

export async function runStart(args: string[], root: string) {
  if (packageIdentity(await packageMetadata()).edition === 'headless') throw new Error('OpenDoc Headless has no browser service. Use npx opendoc create, review, and export to produce files, then deliver the PDF or PowerPoint directly.');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'no-open': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  const usage = 'Usage: npx opendoc start [folder] [--no-open] [--json]\nRuns the installed workspace version. Ctrl+C stops the server.';
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }) : usage); return; }
  if (positionals.length) throw new Error(usage);
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let stopped: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let startupFailure: Error | undefined;
  const forwardInterrupt = () => child?.kill('SIGINT');
  const forwardTerminate = () => child?.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  try {
    const ready = await withWorkspaceLock(root, async () => {
      const existing = await workspaceOwner(root);
      if (existing.mode === 'desktop') throw new Error(`This workspace is open in opendoc-desktop. Close the app before running opendoc start. ${desktopRecordAdvice}`);
      if (existing.mode === 'service') return { origin: existing.origin!, pid: existing.pid!, reused: true };
      await validateInstallation();
      child = spawn(process.execPath, ['--import', runtimeResolve('tsx'), runtimeSource('server/index.ts'), '--production'], { cwd: root, stdio: ['inherit', values.json ? 'pipe' : 'inherit', 'inherit'] });
      if (values.json) child.stdout?.on('data', data => process.stderr.write(data));
      exited = new Promise((accept, reject) => {
        child!.once('error', error => { startupFailure = error; reject(error); });
        child!.once('exit', (code, signal) => { stopped = { code, signal }; accept(stopped); });
      });
      // Attach a handler immediately so a spawn error cannot become an unhandled rejection.
      void exited.catch(() => {});
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (startupFailure) throw startupFailure;
        if (stopped) throw new Error(`OpenDoc stopped during startup (${stopped.signal ?? stopped.code}).`);
        const session = await workspaceOwner(root);
        if (session.mode === 'service' && child.pid && session.pid === child.pid) return { origin: session.origin!, pid: session.pid, reused: false };
        await setTimeout(100);
      }
      throw new Error('OpenDoc did not become ready within 30 seconds. See its terminal output.');
    });
    const { version } = await packageMetadata();
    if (values.json) console.log(JSON.stringify({ workspace: root, version, origin: ready.origin, reused: ready.reused }));
    else if (ready.reused) console.log(`OpenDoc is already running at ${ready.origin}`);
    if (!values['no-open']) await openBrowser(ready.origin);
    if (exited) {
      const result = await exited;
      if (result.code) process.exitCode = result.code;
      else if (result.signal && !['SIGINT', 'SIGTERM'].includes(result.signal)) process.exitCode = 1;
    }
  } catch (error) {
    child?.kill('SIGTERM');
    throw error;
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
}
