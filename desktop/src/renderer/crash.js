const message = document.getElementById('message');
const buttons = document.querySelectorAll('button');

void window.opendocShell.crashInfo().then(info => {
  if (info.workspace) document.getElementById('workspace').textContent = info.workspace;
  if (info.reason) document.getElementById('summary').textContent = info.reason;
});

async function run(action) {
  for (const button of buttons) button.disabled = true;
  try {
    const result = await action();
    if (result && result.ok === false) { message.className = 'error'; message.textContent = result.message; }
  } finally { for (const button of buttons) button.disabled = false; }
}

document.getElementById('retry').addEventListener('click', () => run(() => window.opendocShell.retry()));
document.getElementById('log').addEventListener('click', () => run(() => window.opendocShell.showLog()));
document.getElementById('other').addEventListener('click', () => run(() => window.opendocShell.picker()));
