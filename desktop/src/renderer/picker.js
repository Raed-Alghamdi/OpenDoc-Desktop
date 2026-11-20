const recent = document.getElementById('recent');
const message = document.getElementById('message');
const buttons = [document.getElementById('open'), document.getElementById('create')];
const params = new URLSearchParams(location.search);

function say(text, { error = false, actions = [] } = {}) {
  message.className = error ? 'error' : '';
  message.replaceChildren();
  if (text) message.append(Object.assign(document.createElement('p'), { textContent: text }));
  if (actions.length) {
    const row = Object.assign(document.createElement('div'), { className: 'actions' });
    for (const { label, run } of actions) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      button.addEventListener('click', run);
      row.append(button);
    }
    message.append(row);
  }
}

function busy(value) { for (const button of document.querySelectorAll('button')) button.disabled = value; }

async function show(result, path) {
  if (!result || result.canceled) return;
  if (result.ok) { if (!result.quiet) say('Opening the workspace…'); return; }
  const actions = [];
  if (result.code === 'stale-lock') actions.push({ label: 'Clear stale lock', run: () => act(() => window.opendocShell.clearLock(path ?? result.path)) });
  if (result.code === 'service-running') actions.push({ label: 'Stop it with opendoc stop', run: () => act(() => window.opendocShell.stopService(path ?? result.path)) });
  say(result.message, { error: true, actions });
}

async function act(run, path) {
  busy(true);
  try { await show(await run(), path); } catch (error) { say(`Something went wrong: ${error.message}`, { error: true }); }
  finally { busy(false); await load(); }
}

async function load() {
  const items = await window.opendocShell.recent();
  recent.replaceChildren();
  if (!items.length) { recent.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No workspaces yet.' })); return; }
  const list = Object.assign(document.createElement('ul'), { className: 'recent' });
  for (const item of items) {
    const row = document.createElement('li');
    const open = Object.assign(document.createElement('button'), { type: 'button', className: 'open' });
    open.append(Object.assign(document.createElement('span'), { className: 'name', textContent: item.name }), Object.assign(document.createElement('span'), { className: 'path', textContent: item.exists ? item.path : `${item.path} (not found)` }));
    open.addEventListener('click', () => act(() => window.opendocShell.open(item.path), item.path));
    const forget = Object.assign(document.createElement('button'), { type: 'button', className: 'forget', textContent: 'Remove' });
    forget.setAttribute('aria-label', `Remove ${item.name} from the list`);
    forget.addEventListener('click', () => act(() => window.opendocShell.forget(item.path)));
    row.append(open, forget);
    list.append(row);
  }
  recent.append(list);
}

buttons[0].addEventListener('click', () => act(async () => {
  const choice = await window.opendocShell.openDialog();
  return choice.path ? window.opendocShell.open(choice.path) : choice;
}));
buttons[1].addEventListener('click', () => act(async () => {
  const choice = await window.opendocShell.createDialog();
  if (!choice.path) return choice;
  say('Creating the workspace. This can take a minute…');
  return window.opendocShell.create(choice.path);
}));
// A design pack that was opened before any workspace was: it opens once the user chooses one.
void window.opendocShell.pendingPack().then(pack => { if (pack && !params.get('error')) say(`Choose a workspace to review ${pack.name}. It opens in the Import dialog.`); });
if (params.get('error')) void show({ ok: false, message: params.get('error'), code: params.get('code'), path: params.get('path') }, params.get('path') || undefined);
void load();
