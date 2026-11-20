// "Connect your AI apps": one row per app the module knows, a tick box for each that can be connected (none ticked at the start),
// Connect, a Disconnect or Forget button where the app has a record, and every result with its steps under "Details".
const first = new URLSearchParams(location.search).get('first') === '1';
const list = document.getElementById('apps');
const checking = document.getElementById('checking');
const problem = document.getElementById('problem');
const results = document.getElementById('results');
const connect = document.getElementById('connect');
const close = document.getElementById('close');
const recheck = document.getElementById('recheck');
const selected = new Set();
let busy = false;
let rows = [];

close.textContent = first ? 'Skip' : 'Close';

function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const stateText = { connected: 'Connected', outside: 'Already set up elsewhere', broken: 'Needs attention', gone: 'Not found, still recorded', available: 'Found', absent: 'Not found' };
const resultText = { connected: 'Connected', 'already-present': 'Already there, left alone', disconnected: 'Disconnected', 'not-connected': 'Nothing to remove', forgotten: 'Record dropped', modified: 'Disconnected, one changed file kept', blocked: 'Blocked', conflict: 'Not changed', absent: 'Not found', timeout: 'Timed out' };

function setBusy(value, text) {
  busy = value;
  checking.hidden = !value;
  if (text) checking.querySelector('span:last-child').textContent = text;
  recheck.disabled = value;
  syncButtons();
}

function syncButtons() {
  connect.disabled = busy || selected.size === 0;
  for (const node of list.querySelectorAll('button, input')) node.disabled = busy;
}

function say(text) { problem.hidden = !text; problem.textContent = text ?? ''; }

function row(app) {
  const item = make('li', { className: 'app' });
  item.dataset.app = app.id;
  item.dataset.state = app.state;
  const line = make('div', { className: 'line' });
  if (app.state === 'available') {
    const box = make('input', { type: 'checkbox', id: `tick-${app.id}`, checked: selected.has(app.id) });
    box.setAttribute('aria-describedby', `note-${app.id}`);
    box.addEventListener('change', () => { if (box.checked) selected.add(app.id); else selected.delete(app.id); syncButtons(); });
    line.append(box, make('label', { htmlFor: box.id, className: 'name', textContent: app.name }));
  } else line.append(make('span', { className: 'name', textContent: app.name }));
  line.append(make('span', { className: `badge ${app.state}`, textContent: stateText[app.state] }));
  if (app.stale) line.append(make('span', { className: 'badge stale', textContent: 'Update available' }));
  const actions = make('span', { className: 'row-actions' });
  if (app.state === 'connected' && app.stale) actions.append(button(`Update ${app.name}`, 'Update', () => connectApps([app.id], 'Updating')));
  if (app.managed && app.state !== 'gone') actions.append(button(`Disconnect ${app.name}`, 'Disconnect', () => disconnectApps([app.id], false)));
  if (app.state === 'gone') actions.append(button(`Forget ${app.name}: drop this app's record of it`, 'Forget', () => disconnectApps([app.id], true)));
  line.append(actions);
  const notes = [app.reason, app.state === 'available' ? '' : app.summary, app.problem].filter(Boolean);
  item.append(line, make('p', { className: 'note', id: `note-${app.id}`, textContent: [...new Set(notes)].join(' ') }));
  return item;
}

function button(label, text, run) {
  const node = make('button', { type: 'button', textContent: text });
  node.setAttribute('aria-label', label);
  node.addEventListener('click', run);
  return node;
}

function render(info) {
  rows = info.apps;
  for (const id of [...selected]) if (!rows.some(app => app.id === id && app.state === 'available')) selected.delete(id);
  list.replaceChildren(...rows.map(row));
  list.hidden = false;
  say(info.problem);
  syncButtons();
}

async function load(text = 'Looking for AI apps on this computer…') {
  setBusy(true, text);
  try { render(await window.opendocShell.aiAppsInfo()); }
  catch (error) { say(`The AI apps could not be checked: ${error.message}`); }
  finally { setBusy(false); }
}

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
  view.dataset.code = item.code;
  view.append(make('h3', { textContent: `${item.name}: ${resultText[item.code] ?? (item.ok ? 'Done' : 'Did not work')}` }), make('p', { textContent: item.summary }));
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

function showResults(title, outcome) {
  results.replaceChildren(make('h2', { textContent: title }));
  if (outcome.copy && outcome.copy.ok === false) results.append(make('p', { className: 'error', textContent: outcome.copy.summary }));
  results.append(...outcome.results.map(resultView));
  results.scrollIntoView({ block: 'nearest' });
}

async function act(title, working, call) {
  setBusy(true, working);
  results.replaceChildren();
  try { showResults(title, await call()); }
  catch (error) { results.replaceChildren(make('p', { className: 'error', textContent: `Something went wrong: ${error.message}` })); }
  finally { await load('Checking again…'); }
}

const connectApps = (ids, verb = 'Connecting') => act('Result', `${verb}. This can take a minute…`, () => window.opendocShell.aiAppsConnect(ids));
const disconnectApps = (ids, forget) => act('Result', forget ? 'Dropping the record…' : 'Disconnecting…', () => window.opendocShell.aiAppsDisconnect(ids, { forget }));

connect.addEventListener('click', () => { const ids = [...selected]; selected.clear(); void connectApps(ids); });
recheck.addEventListener('click', () => void load());
close.addEventListener('click', () => void window.opendocShell.aiAppsClose());
void load();
