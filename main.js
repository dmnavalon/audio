// Polifonía — transcripción con identificación de hablantes.
// La API key vive en localStorage. Las llamadas van directo a AssemblyAI
// (no pasa por ningún servidor — sin límite de tamaño).

const KEY_STORAGE = 'polifonia.aai.key';
const HIST_STORAGE = 'polifonia.history';
const HIST_MAX = 50;
const AAI = 'https://api.assemblyai.com/v2';

const els = {
  input: document.getElementById('audioInput'),
  drop: document.getElementById('uploadBox'),
  langSelect: document.getElementById('languageSelect'),
  speakersInput: document.getElementById('speakersInput'),
  progressPanel: document.getElementById('progressPanel'),
  progressLabel: document.getElementById('progressLabel'),
  progressBar: document.getElementById('progressBar'),
  cancelBtn: document.getElementById('cancelBtn'),
  historySection: document.getElementById('historySection'),
  historyList: document.getElementById('historyList'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  logs: document.getElementById('logs'),
  toasts: document.getElementById('toasts'),
  keyNotice: document.getElementById('keyNotice'),
  keyStatus: document.getElementById('keyStatus'),
  keyForm: document.getElementById('keyForm'),
  keyInput: document.getElementById('keyInput'),
  keyCancelBtn: document.getElementById('keyCancelBtn'),
  configureKeyBtn: document.getElementById('configureKeyBtn'),
  editKeyBtn: document.getElementById('editKeyBtn'),
  clearKeyBtn: document.getElementById('clearKeyBtn'),
  optionsPanel: document.getElementById('optionsPanel'),
};

const SPEAKER_VARS = [
  '--speaker-1','--speaker-2','--speaker-3','--speaker-4','--speaker-5',
  '--speaker-6','--speaker-7','--speaker-8','--speaker-9','--speaker-10',
];

const state = {
  xhr: null,
  transcriptId: null,
  cancelled: false,
};

// --- API key management ---
function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}
function saveApiKey(key) {
  localStorage.setItem(KEY_STORAGE, key.trim());
  refreshKeyUI();
}
function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
  refreshKeyUI();
}
function maskedKey() {
  const k = getApiKey();
  return k.length > 8 ? `•••${k.slice(-4)}` : '•••';
}
function refreshKeyUI() {
  const hasKey = !!getApiKey();
  els.keyNotice.hidden = hasKey;
  els.keyStatus.textContent = hasKey ? `Configurada (${maskedKey()})` : 'No configurada';
  els.editKeyBtn.hidden = !hasKey;
  els.clearKeyBtn.hidden = !hasKey;
  setDropDisabled(!hasKey);
}
function showKeyForm() {
  els.keyForm.hidden = false;
  els.keyInput.value = '';
  els.keyInput.focus();
}
function hideKeyForm() {
  els.keyForm.hidden = true;
  els.keyInput.value = '';
}
function openOptionsAndEditKey() {
  els.optionsPanel.open = true;
  showKeyForm();
}

els.configureKeyBtn.addEventListener('click', openOptionsAndEditKey);
els.editKeyBtn.addEventListener('click', showKeyForm);
els.clearKeyBtn.addEventListener('click', () => {
  if (confirm('¿Borrar la API key guardada?')) clearApiKey();
});
els.keyForm.addEventListener('submit', e => {
  e.preventDefault();
  const v = els.keyInput.value.trim();
  if (!v) {
    toast('Pega una API key válida', 'error');
    return;
  }
  saveApiKey(v);
  hideKeyForm();
  toast('API key guardada', 'success');
});
els.keyCancelBtn.addEventListener('click', hideKeyForm);

// --- Drop zone ---
['dragenter', 'dragover'].forEach(ev =>
  els.drop.addEventListener(ev, e => {
    e.preventDefault();
    if (!els.drop.classList.contains('is-disabled')) {
      els.drop.classList.add('is-dragging');
    }
  })
);
['dragleave', 'drop'].forEach(ev =>
  els.drop.addEventListener(ev, e => {
    e.preventDefault();
    els.drop.classList.remove('is-dragging');
  })
);
els.drop.addEventListener('drop', e => {
  if (els.drop.classList.contains('is-disabled')) {
    toast('Configura primero tu API key', 'error');
    openOptionsAndEditKey();
    return;
  }
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
els.drop.addEventListener('click', () => {
  if (els.drop.classList.contains('is-disabled')) {
    openOptionsAndEditKey();
    return;
  }
  els.input.click();
});
els.drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (els.drop.classList.contains('is-disabled')) {
      openOptionsAndEditKey();
    } else {
      els.input.click();
    }
  }
});
els.input.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = '';
});

els.cancelBtn.addEventListener('click', cancel);
els.clearHistoryBtn.addEventListener('click', clearAllHistory);

// --- Main flow ---
async function handleFile(file) {
  const apiKey = getApiKey();
  if (!apiKey) {
    toast('Configura primero tu API key', 'error');
    openOptionsAndEditKey();
    return;
  }

  state.cancelled = false;
  setDropDisabled(true);
  showProgress(`Subiendo "${file.name}"…`, 0);
  log(`Iniciando: ${file.name} (${formatBytes(file.size)})`);

  try {
    const uploadUrl = await uploadFile(file, apiKey);
    if (state.cancelled) return;
    log('Subida completa');

    updateProgress('Iniciando transcripción…', null);
    const langValue = els.langSelect.value;
    const speakers = Math.max(1, Math.min(10, +els.speakersInput.value || 2));
    const id = await startTranscription(uploadUrl, langValue, speakers, apiKey);
    state.transcriptId = id;
    if (state.cancelled) {
      cancelRemote(id, apiKey);
      return;
    }
    log(`Transcripción iniciada: ${id}`);

    updateProgress('Transcribiendo…', null);
    const result = await waitForTranscript(id, apiKey);
    if (state.cancelled) return;
    log('Transcripción completa');

    addToHistory(result, file);
    toast('Transcripción lista', 'success');
  } catch (err) {
    if (state.cancelled) {
      log('Operación cancelada');
      return;
    }
    log(`ERROR: ${err.message}`);
    toast(err.message || 'Algo salió mal', 'error');
  } finally {
    hideProgress();
    setDropDisabled(!getApiKey());
    state.xhr = null;
    state.transcriptId = null;
  }
}

function uploadFile(file, apiKey) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', `${AAI}/upload`);
    xhr.setRequestHeader('Authorization', apiKey);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        updateProgress(`Subiendo… ${pct.toFixed(0)}%`, pct);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.upload_url) return resolve(data.upload_url);
          reject(new Error('Respuesta sin upload_url'));
        } catch {
          reject(new Error('Respuesta inválida del servidor'));
        }
      } else if (xhr.status === 401) {
        reject(new Error('API key inválida — revísala en Opciones'));
      } else {
        reject(new Error(`Subida falló (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Error de red al subir'));
    xhr.onabort = () => reject(new Error('Subida cancelada'));
    xhr.send(file);
  });
}

async function startTranscription(uploadUrl, lang, speakers, apiKey) {
  const body = {
    audio_url: uploadUrl,
    speaker_labels: true,
    speakers_expected: speakers,
  };
  if (lang === 'auto') body.language_detection = true;
  else body.language_code = lang;
  const res = await fetch(`${AAI}/transcript`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    log(`Error iniciando transcripción: ${txt}`);
    if (res.status === 401) throw new Error('API key inválida — revísala en Opciones');
    throw new Error(`No se pudo iniciar la transcripción (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.id;
}

async function waitForTranscript(id, apiKey) {
  let lastStatus = '';
  while (true) {
    if (state.cancelled) throw new Error('Cancelado');
    const res = await fetch(`${AAI}/transcript/${encodeURIComponent(id)}`, {
      headers: { Authorization: apiKey },
    });
    const data = await res.json();
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(`Transcripción falló: ${data.error || 'sin detalle'}`);
    if (data.status !== lastStatus) {
      lastStatus = data.status;
      log(`Estado: ${data.status}`);
      updateProgress(`Transcribiendo (${data.status})…`, null);
    }
    await sleep(2000);
  }
}

async function cancelRemote(id, apiKey) {
  try {
    await fetch(`${AAI}/transcript/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: apiKey },
    });
    log(`Cancelado en AssemblyAI: ${id}`);
  } catch (e) {
    log(`No se pudo cancelar en AssemblyAI: ${e.message}`);
  }
}

function cancel() {
  if (state.cancelled) return;
  state.cancelled = true;
  if (state.xhr) state.xhr.abort();
  const apiKey = getApiKey();
  if (state.transcriptId && apiKey) cancelRemote(state.transcriptId, apiKey);
  hideProgress();
  setDropDisabled(!getApiKey());
  toast('Operación cancelada');
}

// --- History ---
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HIST_STORAGE) || '[]');
  } catch {
    return [];
  }
}
function saveHistory(items) {
  const trimmed = items.slice(0, HIST_MAX);
  try {
    localStorage.setItem(HIST_STORAGE, JSON.stringify(trimmed));
  } catch {
    while (trimmed.length > 3) {
      trimmed.pop();
      try {
        localStorage.setItem(HIST_STORAGE, JSON.stringify(trimmed));
        toast('Historial truncado por límite de almacenamiento', 'info');
        return;
      } catch {}
    }
  }
}
function addToHistory(result, file) {
  const items = loadHistory();
  const speakers = result.utterances
    ? [...new Set(result.utterances.map(u => u.speaker))]
    : [];
  const entry = {
    transcript_id: result.id,
    filename: file.name,
    file_size: file.size,
    created_at: new Date().toISOString(),
    audio_duration: result.audio_duration || null,
    speakers,
    language_code: result.language_code || null,
    utterances: result.utterances || null,
    text: result.text || '',
  };
  items.unshift(entry);
  saveHistory(items);
  renderHistory({ openId: entry.transcript_id });
}
function deleteEntry(id) {
  if (!confirm('¿Quitar esta transcripción del historial?\n\n(No se borra en AssemblyAI — sigue accesible vía API con su ID.)')) return;
  saveHistory(loadHistory().filter(x => x.transcript_id !== id));
  renderHistory();
  toast('Quitada del historial');
}
function clearAllHistory() {
  if (!confirm('¿Borrar todo el historial local?\n\n(No se borran las transcripciones en AssemblyAI.)')) return;
  localStorage.removeItem(HIST_STORAGE);
  renderHistory();
  toast('Historial borrado');
}

function renderHistory(options = {}) {
  const items = loadHistory();
  els.historySection.hidden = !items.length;
  els.historyList.innerHTML = '';
  items.forEach((item, idx) => {
    const isOpen = options.openId
      ? item.transcript_id === options.openId
      : idx === 0;
    els.historyList.appendChild(createHistoryItem(item, isOpen));
  });
}

function createHistoryItem(entry, isOpen) {
  const card = document.createElement('article');
  card.className = 'history-item panel';
  card.dataset.id = entry.transcript_id;
  if (isOpen) card.classList.add('is-open');

  const header = document.createElement('header');
  header.className = 'history-item-header';

  const toggle = document.createElement('button');
  toggle.className = 'history-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggle.innerHTML = `
    <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="history-meta">
      <strong class="history-filename"></strong>
      <span class="muted history-row-meta"></span>
    </div>`;
  toggle.querySelector('.history-filename').textContent = entry.filename;
  toggle.querySelector('.history-row-meta').textContent = formatRowMeta(entry);
  toggle.addEventListener('click', () => {
    const open = card.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  header.appendChild(toggle);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.innerHTML = `
    <button class="btn btn-secondary btn-sm" data-action="copy" type="button">Copiar</button>
    <button class="btn btn-secondary btn-sm" data-action="download" type="button">.txt</button>
    <button class="btn btn-secondary btn-sm" data-action="integrate" type="button">Integración</button>
    <button class="btn btn-ghost history-delete" data-action="delete" type="button" aria-label="Quitar del historial">×</button>`;
  actions.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') copyEntryText(entry);
    if (action === 'download') downloadEntryTxt(entry);
    if (action === 'integrate') {
      const panel = card.querySelector('.history-integrate');
      panel.hidden = !panel.hidden;
    }
    if (action === 'delete') deleteEntry(entry.transcript_id);
  });
  header.appendChild(actions);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'history-item-body';
  body.appendChild(renderUtterances(entry));
  card.appendChild(body);

  const integ = document.createElement('div');
  integ.className = 'history-integrate';
  integ.hidden = true;
  integ.appendChild(renderIntegrate(entry));
  card.appendChild(integ);

  return card;
}

function renderUtterances(entry) {
  const container = document.createElement('div');
  container.className = 'utterances';
  if (entry.utterances && entry.utterances.length) {
    const colorOf = new Map();
    entry.utterances.forEach(u => {
      if (!colorOf.has(u.speaker)) {
        colorOf.set(u.speaker, SPEAKER_VARS[colorOf.size % SPEAKER_VARS.length]);
      }
      const node = document.createElement('div');
      node.className = 'utterance';
      node.style.setProperty('--speaker-color', `var(${colorOf.get(u.speaker)})`);
      node.innerHTML = `
        <span class="utterance-badge" aria-hidden="true"></span>
        <div class="utterance-body">
          <div class="utterance-meta">
            <span class="utterance-speaker"></span>
            <span class="utterance-time"></span>
          </div>
          <p class="utterance-text"></p>
        </div>`;
      node.querySelector('.utterance-badge').textContent = u.speaker;
      node.querySelector('.utterance-speaker').textContent = `Hablante ${u.speaker}`;
      node.querySelector('.utterance-time').textContent = formatTimestamp(u.start);
      node.querySelector('.utterance-text').textContent = u.text;
      container.appendChild(node);
    });
  } else {
    const node = document.createElement('p');
    node.className = 'utterance-text';
    node.textContent = entry.text || '(sin texto)';
    container.appendChild(node);
  }
  return container;
}

function renderIntegrate(entry) {
  const wrapper = document.createElement('div');
  wrapper.className = 'integrate';

  const apiUrl = `${AAI}/transcript/${entry.transcript_id}`;
  const curlSnippet = `curl ${apiUrl} \\\n  -H "Authorization: TU_API_KEY"`;
  const jsonMeta = JSON.stringify({
    transcript_id: entry.transcript_id,
    filename: entry.filename,
    duration_seconds: entry.audio_duration,
    speakers: entry.speakers,
    language: entry.language_code,
    created_at: entry.created_at,
    api_url: apiUrl,
  }, null, 2);

  const rows = [
    { label: 'Transcript ID', value: entry.transcript_id, type: 'inline' },
    { label: 'Endpoint (GET)', value: apiUrl, type: 'inline' },
    { label: 'cURL', value: curlSnippet, type: 'block' },
    { label: 'JSON metadata', value: jsonMeta, type: 'block' },
  ];

  rows.forEach(row => {
    const div = document.createElement('div');
    div.className = row.type === 'inline' ? 'integrate-row' : 'integrate-snippet';

    const label = document.createElement('span');
    label.className = 'integrate-label';
    label.textContent = row.label;
    div.appendChild(label);

    if (row.type === 'inline') {
      const code = document.createElement('code');
      code.className = 'integrate-inline-value';
      code.textContent = row.value;
      div.appendChild(code);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'integrate-block';
      const code = document.createElement('code');
      code.textContent = row.value;
      pre.appendChild(code);
      div.appendChild(pre);
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.type = 'button';
    btn.textContent = 'Copiar';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(row.value)
        .then(() => toast(`${row.label} copiado`, 'success'))
        .catch(() => toast('No se pudo copiar', 'error'));
    });
    div.appendChild(btn);

    wrapper.appendChild(div);
  });

  const note = document.createElement('p');
  note.className = 'integrate-note';
  note.textContent = 'La key viaja en el header Authorization. Nunca la incluyas en URLs ni la compartas. La transcripción queda guardada en AssemblyAI mientras tu cuenta la mantenga.';
  wrapper.appendChild(note);

  return wrapper;
}

function copyEntryText(entry) {
  navigator.clipboard.writeText(formatPlainText(entry))
    .then(() => toast('Texto copiado', 'success'))
    .catch(() => toast('No se pudo copiar', 'error'));
}
function downloadEntryTxt(entry) {
  const blob = new Blob([formatPlainText(entry)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = entry.filename.replace(/\.[^.]+$/, '');
  a.href = url;
  a.download = `${base}-transcripcion.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function formatPlainText(entry) {
  if (entry.utterances && entry.utterances.length) {
    return entry.utterances
      .map(u => `Hablante ${u.speaker}: ${u.text}`)
      .join('\n\n');
  }
  return entry.text || '';
}
function formatRowMeta(entry) {
  const parts = [];
  if (entry.audio_duration) parts.push(formatDuration(entry.audio_duration));
  if (entry.speakers.length) {
    parts.push(`${entry.speakers.length} ${entry.speakers.length === 1 ? 'hablante' : 'hablantes'}`);
  }
  if (entry.language_code) parts.push(entry.language_code);
  parts.push(formatRelativeTime(entry.created_at));
  return parts.join(' · ');
}
function formatRelativeTime(iso) {
  const then = new Date(iso).getTime();
  const delta = (Date.now() - then) / 1000;
  if (delta < 60) return 'hace unos segundos';
  if (delta < 3600) return `hace ${Math.floor(delta / 60)} min`;
  if (delta < 86400) return `hace ${Math.floor(delta / 3600)} h`;
  const days = Math.floor(delta / 86400);
  if (days < 7) return `hace ${days} d`;
  return new Date(iso).toLocaleDateString();
}

// --- Progress / state ---
function showProgress(label, pct) {
  els.progressPanel.hidden = false;
  updateProgress(label, pct);
}
function updateProgress(label, pct) {
  els.progressLabel.textContent = label;
  if (pct === null) {
    els.progressBar.classList.add('is-indeterminate');
    els.progressBar.style.width = '';
  } else {
    els.progressBar.classList.remove('is-indeterminate');
    els.progressBar.style.width = `${pct}%`;
  }
}
function hideProgress() {
  els.progressPanel.hidden = true;
  els.progressBar.style.width = '0%';
  els.progressBar.classList.remove('is-indeterminate');
}
function setDropDisabled(disabled) {
  els.drop.classList.toggle('is-disabled', disabled);
  els.drop.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

// --- Toasts ---
function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  const content = document.createElement('div');
  content.className = 'toast-content';
  content.textContent = message;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Cerrar notificación');
  close.textContent = '×';
  node.appendChild(content);
  node.appendChild(close);
  els.toasts.appendChild(node);
  const remove = () => node.remove();
  close.addEventListener('click', remove);
  setTimeout(remove, 4500);
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  els.logs.textContent += `[${t}] ${msg}\n`;
  els.logs.scrollTop = els.logs.scrollHeight;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
function pad(n) { return n.toString().padStart(2, '0'); }

// Init
refreshKeyUI();
renderHistory();
