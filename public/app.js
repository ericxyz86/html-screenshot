const form = document.getElementById('capture-form');
const goBtn = document.getElementById('go');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const resultsEl = document.getElementById('results');
const galleryEl = document.getElementById('gallery');
const countEl = document.getElementById('count');
const zipLink = document.getElementById('zip-link');

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function logLine(message, kind) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.textContent = message;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value.trim();
  const mode = form.elements.mode.value;

  statusEl.hidden = false;
  resultsEl.hidden = true;
  clearChildren(logEl);
  clearChildren(galleryEl);
  goBtn.disabled = true;
  goBtn.textContent = 'Generating…';

  try {
    const res = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mode }),
    });

    if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const j = await res.json();
      logLine(`Error: ${j.error}`, 'error');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        handleEvent(evt);
      }
    }
  } catch (err) {
    logLine(`Network error: ${err.message}`, 'error');
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'Generate';
  }
});

function handleEvent(evt) {
  if (evt.event === 'start') {
    logLine(`Job ${evt.jobId} started — mode: ${evt.mode}`);
  } else if (evt.event === 'progress') {
    logLine(evt.message || JSON.stringify(evt));
  } else if (evt.event === 'compose') {
    logLine(evt.message);
  } else if (evt.event === 'error') {
    logLine(`Error: ${evt.message}`, 'error');
  } else if (evt.event === 'done') {
    logLine(`Done. ${evt.count} file(s) generated.`, 'done');
    showResults(evt);
  }
}

function showResults(evt) {
  resultsEl.hidden = false;
  countEl.textContent = `(${evt.count} files, ${evt.mode} mode)`;
  zipLink.href = evt.zipUrl;
  clearChildren(galleryEl);

  for (const f of evt.files) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/output/${f.file}`;
    img.alt = f.id;
    tile.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const left = document.createElement('span');
    let label = f.id;
    if (f.strategy === 'split') label += ` (${f.slide}/${f.of})`;
    else if (f.strategy === 'shrunk') label += ` · shrunk ${Math.round((f.scale || 0) * 100)}%`;
    else if (f.strategy === 'fits') label += ` · fits`;
    left.textContent = label;
    const right = document.createElement('a');
    right.href = `/output/${f.file}`;
    right.download = '';
    right.textContent = 'open';
    meta.appendChild(left);
    meta.appendChild(right);
    tile.appendChild(meta);

    galleryEl.appendChild(tile);
  }
}
