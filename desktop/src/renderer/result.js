const message = document.getElementById('message');
const buttons = document.querySelectorAll('button');

function say(text, error = false) { message.className = error ? 'error' : ''; message.textContent = text; }

async function run(action) {
  for (const button of buttons) button.disabled = true;
  try {
    const result = await action();
    if (result && result.ok === false) say(result.message, true);
  } catch (error) { say(`Something went wrong: ${error.message}`, true); }
  finally { for (const button of buttons) button.disabled = false; }
}

void window.opendocShell.resultInfo().then(info => {
  document.getElementById('summary').textContent = info.message || `${info.failures.length === 1 ? 'One thing' : `${info.failures.length} things`} did not pass after the upgrade to OpenDoc ${info.to}.`;
  const list = document.getElementById('failures');
  for (const failure of info.failures) {
    const item = document.createElement('li');
    item.append(Object.assign(document.createElement('strong'), { textContent: failure.label }), Object.assign(document.createElement('pre'), { textContent: failure.message }));
    list.append(item);
  }
  if (info.backup) document.getElementById('backup').textContent = info.backup.directory;
  document.getElementById('open').hidden = !info.canOpen;
});

document.getElementById('copy').addEventListener('click', () => run(async () => { const result = await window.opendocShell.copyPrompt(); if (result.ok) say('Copied. Paste it into your agent.'); return result; }));
document.getElementById('restore').addEventListener('click', () => run(() => window.opendocShell.resultAction('restore')));
document.getElementById('open').addEventListener('click', () => run(() => window.opendocShell.resultAction('open')));
document.getElementById('close').addEventListener('click', () => run(() => window.opendocShell.resultAction('close')));
