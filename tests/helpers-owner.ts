import type { TestContext } from 'node:test';
import { ownerProbe } from '../src/cli/owner';

/** Processes that tests accept as opendoc-desktop; every other live pid goes through the real name check. */
const accepted = new Set<number>();
const realCheck = ownerProbe.isDesktopApp;
ownerProbe.isDesktopApp = async pid => accepted.has(pid) || realCheck(pid);

/** Stand in for the app with an ordinary process; given a test, the pid stops counting when it ends. */
export function acceptAsApp(pid: number, t?: TestContext) {
  accepted.add(pid);
  t?.after(() => { accepted.delete(pid); });
  return pid;
}
