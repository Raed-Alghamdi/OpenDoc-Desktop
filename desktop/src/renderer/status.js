const text = document.getElementById('text');
const title = document.getElementById('title');

async function refresh() {
  try {
    const info = await window.opendocShell.statusInfo();
    if (info.title) title.textContent = info.title;
    if (info.text) text.textContent = info.text;
  } catch { /* the window is closing */ }
}

void refresh();
setInterval(refresh, 400);
