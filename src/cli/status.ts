import { parseArgs } from 'node:util';
import { codedError } from './errors';
import { workspaceOwner } from './owner';

const usage = 'Usage: npx opendoc status [--json]\nShows whether the OpenDoc service or opendoc-desktop has this workspace open.';

export async function runStatus(args: string[], root: string) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }) : usage); return; }
  if (positionals.length) throw codedError(usage, 'usage');
  const owner = await workspaceOwner(root);
  // The session token stays out of the output: only the fields of the owner are printed.
  const result = { running: owner.mode !== null, mode: owner.mode, ...(owner.pid === undefined ? {} : { pid: owner.pid }), ...(owner.origin === undefined ? {} : { origin: owner.origin }) };
  if (values.json) console.log(JSON.stringify(result));
  else if (owner.mode === 'service') console.log(`OpenDoc is running at ${owner.origin} (process ${owner.pid}).`);
  else if (owner.mode === 'desktop') console.log(`opendoc-desktop has this workspace open (process ${owner.pid}).`);
  else console.log('OpenDoc is not running for this workspace.');
}
