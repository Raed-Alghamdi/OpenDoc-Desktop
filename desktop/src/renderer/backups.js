const list = document.getElementById('list');
const message = document.getElementById('message');

function say(text, error = false) { message.className = error ? 'error' : ''; message.textContent = text; }
const cell = (text, className) => Object.assign(document.createElement('td'), { textContent: text, className: className ?? '' });

async function act(action) {
  try {
    const result = await action();
    if (result && result.ok === false) say(result.message, true);
    else say('');
  } catch (error) { say(`Something went wrong: ${error.message}`, true); }
  await load();
}

async function load() {
  const { rows: items, notices } = await window.opendocShell.backups();
  list.replaceChildren();
  for (const text of notices) list.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: text }));
  if (!items.length) { list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No backups yet.' })); return; }
  const table = Object.assign(document.createElement('table'), { className: 'backups' });
  const head = document.createElement('tr');
  for (const name of ['Name', 'Workspace', 'Date', 'Size', '']) head.append(Object.assign(document.createElement('th'), { textContent: name }));
  table.append(head);
  for (const item of items) {
    const row = document.createElement('tr');
    row.dataset.backup = item.name;
    const actions = document.createElement('td');
    const reveal = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Reveal' });
    reveal.addEventListener('click', () => act(() => window.opendocShell.revealBackup(item.name)));
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete' });
    remove.setAttribute('aria-label', `Delete the backup ${item.name}`);
    remove.addEventListener('click', () => act(() => window.opendocShell.deleteBackup(item.name)));
    actions.append(reveal, remove);
    const kind = item.kind === 'before-restore' ? ' (before a restore)' : item.from && item.to ? ` (${item.from} to ${item.to})` : '';
    row.append(cell(item.name + kind, 'name'), cell(item.source ?? '', 'mono'), cell(item.time ? new Date(item.time).toLocaleString() : ''), cell(item.sizeText ?? ''), actions);
    table.append(row);
  }
  list.append(table);
}

void load();
