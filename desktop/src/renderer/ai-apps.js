// "Connect your AI apps": a list of AI apps that opens at once (nothing on it runs a vendor command), a page for each app, and a page
// for any other app. An app's page runs the read-only vendor check for that app only, lists its settings folders with a tick box for
// each that can be connected, and shows every result with its steps under "Details". Claude Code can have several folders.
const first = new URLSearchParams(location.search).get('first') === '1';
const get = id => document.getElementById(id);
const [title, lede, back, list, page, other, checking, problem, results, connect, close, recheck, targets, where, tryBox] =
  ['title', 'lede', 'back', 'apps', 'page', 'other', 'checking', 'problem', 'results', 'connect', 'close', 'recheck', 'targets', 'where', 'try'].map(get);
const listTitle = title.textContent;
const listLede = lede.textContent;
const selected = new Set();
let view = 'list'; // 'list', an app id, or 'other'
let overview = null; // the list's data
let row = null; // the open app's data
let busy = false; // an action (connect, disconnect...) is running: the page's buttons wait
let token = 0; // the newest request; an answer to an older one is dropped

close.textContent = first ? 'Skip' : 'Close';

function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const stateText = { connected: 'Connected', outside: 'Already set up elsewhere', broken: 'Needs attention', gone: 'Not found, still recorded', available: 'Not connected', absent: 'Not available' };
const resultText = { connected: 'Connected', 'already-present': 'Already there, left alone', disconnected: 'Disconnected', 'not-connected': 'Nothing to remove', forgotten: 'Record dropped', modified: 'Disconnected, one changed file kept', blocked: 'Blocked', conflict: 'Not changed', absent: 'Not found', timeout: 'Timed out', 'unknown-target': 'Not found' };

function say(text) { problem.hidden = !text; problem.textContent = text ?? ''; }

/** The "Checking..." line: shown while something is looked up or run. */
function working(text) {
  checking.hidden = !text;
  if (text) checking.querySelector('span:last-child').textContent = text;
}

function syncButtons() {
  connect.disabled = busy || selected.size === 0;
  for (const node of targets.querySelectorAll('button, input')) node.disabled = busy;
  back.disabled = busy;
  recheck.disabled = busy;
}

function setBusy(value, text) {
  busy = value;
  working(value ? text : '');
  syncButtons();
}

function button(label, text, run) {
  const node = make('button', { type: 'button', textContent: text });
  node.setAttribute('aria-label', label);
  node.addEventListener('click', run);
  return node;
}

function badge(kind, text) { return make('span', { className: `badge ${kind}`, textContent: text }); }

// ---- the list ----

function listRow(app) {
  const item = make('li', { className: 'app' });
  item.dataset.app = app.id;
  const open = make('button', { type: 'button', className: 'open-app' });
  open.append(make('span', { className: 'name', textContent: app.name }), ...app.badges.map(entry => badge(entry.kind, entry.text)), make('span', { className: 'chevron', textContent: '›' }));
  open.setAttribute('aria-label', `${app.name}: ${app.badges.map(entry => entry.text).join(', ')}. Open its page.`);
  open.addEventListener('click', () => void openApp(app.id));
  item.append(open);
  return item;
}

function otherRow() {
  const item = make('li', { className: 'app' });
  item.dataset.app = 'other';
  const open = make('button', { type: 'button', className: 'open-app' });
  open.append(make('span', { className: 'name', textContent: 'Other app' }), make('span', { className: 'hint', textContent: 'Any agent that can run programs on this computer' }), make('span', { className: 'chevron', textContent: '›' }));
  open.setAttribute('aria-label', 'Other app: any agent that can run programs on this computer. Open its page.');
  open.addEventListener('click', () => void openOther());
  item.append(open);
  return item;
}

function renderList() {
  list.replaceChildren(...overview.apps.map(listRow), otherRow());
  say(overview.problem);
}

async function loadOverview({ fresh = false } = {}) {
  const mine = ++token;
  try {
    const next = await window.opendocShell.aiAppsOverview({ fresh });
    if (mine !== token) return;
    overview = next;
    if (view === 'list') renderList();
    if (view === 'other') renderOther();
  } catch (error) { if (mine === token) say(`The AI apps could not be listed: ${error.message}`); }
}

// ---- moving between the list and the pages ----

function show(next, heading, text) {
  view = next;
  list.hidden = next !== 'list';
  page.hidden = next === 'list' || next === 'other';
  other.hidden = next !== 'other';
  back.hidden = next === 'list';
  title.textContent = heading;
  document.title = next === 'list' ? listTitle : `${heading}: ${listTitle}`;
  lede.textContent = text;
  lede.hidden = !text;
  results.replaceChildren();
  say('');
  working('');
  tryBox.hidden = true;
  title.focus();
}

async function showList(focusId) {
  ++token;
  busy = false;
  show('list', listTitle, listLede);
  syncButtons();
  if (overview) renderList();
  await loadOverview();
  const target = focusId ? list.querySelector(`li[data-app="${focusId}"] button`) : null;
  if (target) target.focus();
}

async function openApp(id) {
  row = overview.apps.find(app => app.id === id);
  selected.clear();
  show(id, row.name, '');
  const open = row.targets.filter(target => target.state === 'available');
  if (row.canConnect && open.length === 1 && row.targets.length === 1) selected.add(open[0].id);
  renderPage();
  await checkApp({ fresh: false });
}

function openOther() {
  show('other', 'Other app', '');
  renderOther();
  void loadOverview();
}

async function checkApp({ fresh }) {
  const id = view;
  const mine = ++token;
  working(`Checking ${row.name}…`);
  try {
    const answer = await window.opendocShell.aiAppsApp(id, { fresh });
    if (mine !== token) return;
    if (!answer.ok) { say(answer.message); return; }
    row = answer.app;
    say(answer.problem);
    renderPage();
  } catch (error) { if (mine === token) say(`${row.name} could not be checked: ${error.message}`); }
  finally { if (mine === token) working(''); }
}

// ---- an app's page ----

function whereView() {
  const nodes = [];
  if (row.installed) {
    nodes.push(make('p', {}, row.executable ? 'Installed at ' : '', ...(row.executable ? [make('span', { className: 'mono', textContent: row.executable }), '.'] : [row.reason])));
    if (row.installer) nodes.push(make('p', { className: 'hint', textContent: `Installed with ${row.installer}.` }));
  } else {
    nodes.push(make('p', { textContent: `${row.name} is not installed on this computer.` }));
    if (row.website) nodes.push(make('p', {}, 'You can get it from ', make('span', { className: 'mono', textContent: row.website }), ', the vendor\'s site. Then press Check again.'));
    else nodes.push(make('p', { textContent: 'Install it, then press Check again.' }));
    if (row.reason) nodes.push(make('p', { className: 'hint', textContent: row.reason }));
  }
  return nodes;
}

function targetRow(target) {
  const multiple = row.targets.length > 1;
  const item = make('li', { className: 'target' });
  item.dataset.target = target.id;
  item.dataset.state = target.state;
  const line = make('div', { className: 'line' });
  const noteId = `note-${target.id.replace(/[^\w-]/g, '_')}`;
  if (target.state === 'available' && row.canConnect) {
    const box = make('input', { type: 'checkbox', id: `tick-${noteId}`, checked: selected.has(target.id) });
    box.setAttribute('aria-describedby', noteId);
    box.addEventListener('change', () => { if (box.checked) selected.add(target.id); else selected.delete(target.id); syncButtons(); });
    line.append(box, make('label', { htmlFor: box.id, className: 'name mono', textContent: target.label }));
  } else line.append(make('span', { className: 'name mono', textContent: target.label }));
  line.append(badge(target.state, stateText[target.state]));
  if (target.stale && target.state === 'connected') line.append(badge('stale', 'Update available'));
  const where = multiple ? ` in ${target.label}` : '';
  const actions = make('span', { className: 'row-actions' });
  if (target.state === 'connected' && target.stale) actions.append(button(`Update ${row.name}${where}`, 'Update', () => connectTargets([target.id], 'Updating')));
  if (target.managed && target.state !== 'gone') actions.append(button(`Disconnect ${row.name}${where}`, 'Disconnect', () => disconnectTargets([target.id], false)));
  if (target.state === 'gone') actions.append(button(`Forget ${row.name}${where}: drop this app's record of it`, 'Forget', () => disconnectTargets([target.id], true)));
  line.append(actions);
  const notes = [target.note, target.state === 'available' ? '' : target.summary, target.problem].filter(Boolean);
  item.append(line, make('p', { className: 'note', id: noteId, textContent: [...new Set(notes)].join(' ') }));
  return item;
}

function renderPage() {
  // Where nothing is recorded and the app is not here, there is no folder to offer.
  const shown = row.targets.filter(target => row.canConnect || target.managed);
  for (const id of [...selected]) if (!shown.some(target => target.id === id && target.state === 'available')) selected.delete(id);
  where.replaceChildren(...whereView());
  get('targets-heading').textContent = row.targets.length > 1 ? 'Settings folders' : 'Settings folder';
  get('targets-heading').hidden = shown.length === 0;
  targets.replaceChildren(...shown.map(targetRow));
  targets.hidden = shown.length === 0;
  connect.hidden = !row.canConnect;
  tryBox.hidden = !row.targets.some(target => target.state === 'connected');
  get('try-text').textContent = `Start a new session of ${row.name} in any folder and paste this prompt.`;
  get('prompt').textContent = overview.tryPrompt;
  syncButtons();
}

// ---- the "Other app" page ----

function renderOther() {
  const { skillFolder, skillFolderExists, command } = overview.other;
  get('other-skill').textContent = skillFolder;
  get('copy-skill').disabled = !skillFolderExists;
  get('other-command-text').textContent = command ? 'The command your agent runs. It is on this computer at:' : 'The opendoc command was not found on this computer\'s search path. Your agent needs it: see the opendoc command in the OpenDoc desktop guide.';
  get('other-command').hidden = !command;
  get('other-command').textContent = command ?? '';
  get('copy-command').hidden = !command;
  if (!skillFolderExists) get('other-skill').textContent = `${skillFolder} (not found)`;
}

// ---- results ----

function stepView(step) {
  const status = step.skipped ? 'note' : step.ok ? 'ok' : 'failed';
  const view = make('div', { className: `step ${status}` });
  view.append(make('strong', { textContent: step.label }), make('span', { className: 'step-status', textContent: step.skipped ? ' (nothing to run)' : step.ok ? ' (worked)' : ' (failed)' }));
  if (step.command) view.append(make('div', { className: 'mono command', textContent: step.command }));
  if (step.output) view.append(make('pre', { textContent: step.output }));
  return view;
}

function resultView(item) {
  const view = make('section', { className: `result ${item.ok ? 'good' : 'bad'}` });
  view.dataset.app = item.app;
  view.dataset.target = item.target;
  view.dataset.code = item.code;
  const name = item.targetLabel && item.target !== item.app ? `${item.name} (${item.targetLabel})` : item.name;
  view.append(make('h3', { textContent: `${name}: ${resultText[item.code] ?? (item.ok ? 'Done' : 'Did not work')}` }), make('p', { textContent: item.summary }));
  const steps = item.steps ?? [];
  const broken = steps.find(step => step.ok === false && !step.skipped);
  if (!item.ok && broken) {
    view.append(make('p', { className: 'hint', textContent: `What went wrong, from “${broken.label}”:` }), make('pre', { className: 'failure', textContent: broken.output || '(the command printed nothing)' }));
  }
  if (steps.length) {
    const details = make('details', { className: 'steps' }, make('summary', { textContent: 'Details' }));
    details.append(...steps.map(stepView));
    view.append(details);
  }
  return view;
}

function showResults(outcome) {
  results.replaceChildren(make('h2', { textContent: 'Result' }));
  if (outcome.copy && outcome.copy.ok === false) results.append(make('p', { className: 'error', textContent: outcome.copy.summary }));
  results.append(...outcome.results.map(resultView));
  results.scrollIntoView({ block: 'nearest' });
}

/** Run a connect or disconnect, show its result, then look at this app again (only this app: nothing else changed). */
async function act(working_, call) {
  ++token;
  setBusy(true, working_);
  results.replaceChildren();
  try { showResults(await call()); }
  catch (error) { results.replaceChildren(make('p', { className: 'error', textContent: `Something went wrong: ${error.message}` })); }
  finally { setBusy(false); }
  await checkApp({ fresh: false });
}

const connectTargets = (ids, verb = 'Connecting') => act(`${verb}. This can take a minute…`, () => window.opendocShell.aiAppsConnect(ids));
const disconnectTargets = (ids, forget) => act(forget ? 'Dropping the record…' : 'Disconnecting…', () => window.opendocShell.aiAppsDisconnect(ids, { forget }));

async function copy(kind, note) {
  try {
    const answer = await window.opendocShell.aiAppsCopy(kind);
    note.textContent = answer.ok ? 'Copied' : answer.message;
  } catch (error) { note.textContent = `Could not copy: ${error.message}`; }
  setTimeout(() => { note.textContent = ''; }, 4000);
}

connect.addEventListener('click', () => { const ids = [...selected]; selected.clear(); void connectTargets(ids); });
back.addEventListener('click', () => void showList(view));
recheck.addEventListener('click', () => {
  if (view === 'list') void loadOverview({ fresh: true });
  else if (view === 'other') void loadOverview({ fresh: true });
  else void checkApp({ fresh: true });
});
close.addEventListener('click', () => void window.opendocShell.aiAppsClose());
get('copy-prompt').addEventListener('click', () => void copy('prompt', get('copied')));
get('copy-skill').addEventListener('click', () => void copy('skill-folder', get('copied-skill')));
get('copy-command').addEventListener('click', () => void copy('command', get('copied-command')));
void loadOverview();
