import { killElectronProcesses } from './processes.mjs';

export default async function globalTeardown() {
  const left = killElectronProcesses();
  if (left.length) console.error(`Teardown killed ${left.length} Electron process(es): ${left.map(item => item.pid).join(', ')}`);
}
