// Polifonía — transcripción con identificación de hablantes.
// La API key vive en localStorage. Las llamadas van directo a AssemblyAI.
// La lista de transcripciones se trae desde AssemblyAI (cross-device sync).

const KEY_STORAGE = 'polifonia.aai.key';
const FILENAME_STORAGE = 'polifonia.filenames';
const CACHE_STORAGE = 'polifonia.cache';
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
  refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
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
  refreshHistory();
}
function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
  refreshKeyUI();
  els.historySection.hidden = true;
  els.historyList.innerHTML = '';
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
  if (confirm('¿Borrar la API key guardada en este navegador?')) clearApiKey();
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
els.refreshHistoryBtn.addEventListener('click', () => refreshHistory());

// --- Main upload flow ---
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
    saveFilenameFor(id, file.name);
    if (state.cancelled) {
      cancelRemote(id, apiKey);
      return;
    }
    log(`Transcripción iniciada: ${id}`);

    updateProgress('Transcribiendo…', null);
    const result = await waitForTranscript(id, apiKey);
    if (state.cancelled) return;
    log('Transcripción completa');

    cacheTranscript(id, result);
    await refreshHistory({ openId: id });
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

// --- Local enrichment (filenames + full-data cache) ---
function loadFilenames() {
  try { return JSON.parse(localStorage.getItem(FILENAME_STORAGE) || '{}'); }
  catch { return {}; }
}
function saveFilenameFor(id, filename) {
  const map = loadFilenames();
  map[id] = filename;
  try { localStorage.setItem(FILENAME_STORAGE, JSON.stringify(map)); } catch {}
}
function removeFilenameFor(id) {
  const map = loadFilenames();
  delete map[id];
  try { localStorage.setItem(FILENAME_STORAGE, JSON.stringify(map)); } catch {}
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_STORAGE) || '{}'); }
  catch { return {}; }
}
function cacheTranscript(id, full) {
  const cache = loadCache();
  cache[id] = {
    audio_duration: full.audio_duration || null,
    language_code: full.language_code || null,
    utterances: full.utterances || null,
    text: full.text || '',
    speakers: full.utterances ? [...new Set(full.utterances.map(u => u.speaker))] : [],
  };
  try {
    localStorage.setItem(CACHE_STORAGE, JSON.stringify(cache));
  } catch {
    // Quota: drop everything except this entry
    try { localStorage.setItem(CACHE_STORAGE, JSON.stringify({ [id]: cache[id] })); } catch {}
  }
}
function removeCacheFor(id) {
  const cache = loadCache();
  delete cache[id];
  try { localStorage.setItem(CACHE_STORAGE, JSON.stringify(cache)); } catch {}
}

// --- History fetching ---
async function refreshHistory(options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    els.historySection.hidden = true;
    return;
  }

  els.historySection.hidden = false;
  els.refreshHistoryBtn.disabled = true;
  els.refreshHistoryBtn.textContent = 'Cargando…';

  if (!els.historyList.children.length || els.historyList.querySelector('.history-empty')) {
    els.historyList.innerHTML = '<p class="muted history-empty">Cargando transcripciones…</p>';
  }

  try {
    const all = [];
    const seen = new Set();
    const MAX_PAGES = 10;
    const PER_PAGE = 200;
    let beforeId = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${AAI}/transcript`);
      url.searchParams.set('limit', String(PER_PAGE));
      if (beforeId) url.searchParams.set('before_id', beforeId);

      const res = await fetch(url.toString(), {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('API key inválida');
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const transcripts = data.transcripts || [];
      if (!transcripts.length) break;

      for (const t of transcripts) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          all.push(t);
        }
      }
      beforeId = transcripts[transcripts.length - 1].id;
      els.refreshHistoryBtn.textContent = `Cargando ${all.length}…`;
      if (transcripts.length < PER_PAGE) break;
    }

    renderRemoteHistory(all, options);
  } catch (err) {
    log(`Error cargando historial: ${err.message}`);
    els.historyList.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted history-empty';
    p.textContent = `No se pudo cargar: ${err.message}`;
    els.historyList.appendChild(p);
    toast(`Error: ${err.message}`, 'error');
  } finally {
    els.refreshHistoryBtn.disabled = false;
    els.refreshHistoryBtn.textContent = 'Actualizar';
  }
}

function renderRemoteHistory(list, options = {}) {
  els.historyList.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted history-empty';
    p.textContent = 'Aún no tienes transcripciones en esta cuenta.';
    els.historyList.appendChild(p);
    return;
  }
  list.forEach(item => {
    const entry = enrichListItem(item);
    const isOpen = options.openId === entry.transcript_id;
    els.historyList.appendChild(createHistoryItem(entry, isOpen));
  });
}

function enrichListItem(item) {
  const filenames = loadFilenames();
  const cache = loadCache();
  const cached = cache[item.id] || {};
  const fallbackName = `Sin título · ${formatShortDate(item.created)}`;
  return {
    transcript_id: item.id,
    filename: filenames[item.id] || fallbackName,
    created_at: item.created,
    status: item.status,
    audio_duration: cached.audio_duration ?? null,
    language_code: cached.language_code ?? null,
    speakers: cached.speakers || [],
    utterances: 'utterances' in cached ? cached.utterances : undefined,
    text: cached.text || '',
    _loaded: 'utterances' in cached,
  };
}

function formatShortDate(iso) {
  if (!iso) return 'fecha desconocida';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'fecha desconocida';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
}

// --- History rendering ---
function createHistoryItem(entry, isOpen) {
  const card = document.createElement('article');
  card.className = 'history-item panel';
  card.dataset.id = entry.transcript_id;
  if (isOpen) card.classList.add('is-open');

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
    </div>
    <span class="history-status"></span>`;
  toggle.querySelector('.history-filename').textContent = entry.filename;
  toggle.querySelector('.history-row-meta').textContent = formatRowMeta(entry);
  renderStatusBadge(toggle.querySelector('.history-status'), entry.status);
  toggle.addEventListener('click', () => onToggle(card, entry, toggle, body));
  card.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'history-item-body';

  const utterancesWrap = document.createElement('div');
  utterancesWrap.className = 'utterances-wrap';
  if (entry._loaded) {
    utterancesWrap.appendChild(renderUtterances(entry));
  } else {
    const ph = document.createElement('p');
    ph.className = 'muted';
    ph.textContent = entry.status === 'completed'
      ? '(Se carga al expandir)'
      : `Estado: ${entry.status}`;
    utterancesWrap.appendChild(ph);
  }
  body.appendChild(utterancesWrap);

  const integ = document.createElement('div');
  integ.className = 'history-integrate';
  integ.hidden = true;
  integ.appendChild(renderIntegrate(entry));
  body.appendChild(integ);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-action="copy" type="button">Copiar texto</button>
    <button class="btn btn-ghost btn-sm" data-action="download" type="button">Descargar .txt</button>
    <button class="btn btn-ghost btn-sm" data-action="integrate" type="button">Integración API</button>
    <span class="actions-spacer"></span>
    <button class="btn btn-ghost btn-sm history-delete" data-action="delete" type="button">Borrar</button>`;
  actions.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      await ensureFullData(entry, card);
      copyEntryText(entry);
    }
    if (action === 'download') {
      await ensureFullData(entry, card);
      downloadEntryTxt(entry);
    }
    if (action === 'integrate') {
      integ.hidden = !integ.hidden;
      btn.classList.toggle('is-active', !integ.hidden);
    }
    if (action === 'delete') deleteEntryRemote(entry);
  });
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

async function onToggle(card, entry, toggle, body) {
  const open = card.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && !entry._loaded && entry.status === 'completed') {
    await ensureFullData(entry, card);
  }
}

async function ensureFullData(entry, card) {
  if (entry._loaded) return;
  if (entry.status !== 'completed') return;

  const apiKey = getApiKey();
  if (!apiKey) return;

  const wrap = card.querySelector('.utterances-wrap');
  wrap.innerHTML = '<p class="muted">Cargando texto…</p>';

  try {
    const res = await fetch(`${AAI}/transcript/${encodeURIComponent(entry.transcript_id)}`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    entry.audio_duration = data.audio_duration || null;
    entry.language_code = data.language_code || null;
    entry.utterances = data.utterances || null;
    entry.text = data.text || '';
    entry.speakers = data.utterances ? [...new Set(data.utterances.map(u => u.speaker))] : [];
    entry._loaded = true;
    cacheTranscript(entry.transcript_id, data);

    wrap.innerHTML = '';
    wrap.appendChild(renderUtterances(entry));
    card.querySelector('.history-row-meta').textContent = formatRowMeta(entry);
    const integ = card.querySelector('.history-integrate');
    integ.innerHTML = '';
    integ.appendChild(renderIntegrate(entry));
  } catch (err) {
    wrap.innerHTML = `<p class="muted">No se pudo cargar: ${err.message}</p>`;
    toast(`Error: ${err.message}`, 'error');
  }
}

function deleteEntryRemote(entry) {
  if (!confirm(`¿Borrar "${entry.filename}" de AssemblyAI?\n\nEsto la elimina permanentemente — dejará de estar accesible vía API. No se puede deshacer.`)) return;
  const apiKey = getApiKey();
  if (!apiKey) return;
  fetch(`${AAI}/transcript/${encodeURIComponent(entry.transcript_id)}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey },
  }).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    removeFilenameFor(entry.transcript_id);
    removeCacheFor(entry.transcript_id);
    refreshHistory();
    toast('Transcripción borrada', 'success');
  }).catch(err => {
    toast(`No se pudo borrar: ${err.message}`, 'error');
  });
}

function renderStatusBadge(node, status) {
  if (!status) return;
  if (status === 'completed') {
    node.remove();
    return;
  }
  node.classList.add(`status-${status}`);
  node.textContent = status;
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

  wrapper.appendChild(buildInlineRow('ID', entry.transcript_id));
  wrapper.appendChild(buildInlineRow('GET', apiUrl));
  wrapper.appendChild(buildSnippetDetails('cURL', curlSnippet));
  wrapper.appendChild(buildSnippetDetails('JSON metadata', jsonMeta));

  return wrapper;
}

function buildInlineRow(label, value) {
  const div = document.createElement('div');
  div.className = 'integrate-row';
  div.innerHTML = `
    <span class="integrate-label"></span>
    <code class="integrate-value"></code>
    <button class="btn btn-ghost btn-sm integrate-copy" type="button">Copiar</button>`;
  div.querySelector('.integrate-label').textContent = label;
  div.querySelector('.integrate-value').textContent = value;
  div.querySelector('.integrate-copy').addEventListener('click', () => copyValue(value, label));
  return div;
}

function buildSnippetDetails(label, value) {
  const det = document.createElement('details');
  det.className = 'integrate-details';
  const sum = document.createElement('summary');
  sum.className = 'integrate-summary';
  sum.textContent = label;
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'integrate-block';
  const code = document.createElement('code');
  code.textContent = value;
  pre.appendChild(code);
  det.appendChild(pre);
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm integrate-copy';
  btn.type = 'button';
  btn.textContent = 'Copiar';
  btn.addEventListener('click', e => { e.preventDefault(); copyValue(value, label); });
  det.appendChild(btn);
  return det;
}

function copyValue(value, label) {
  navigator.clipboard.writeText(value)
    .then(() => toast(`${label} copiado`, 'success'))
    .catch(() => toast('No se pudo copiar', 'error'));
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
  const base = (entry.filename || 'transcripcion').replace(/\.[^.]+$/, '');
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
  if (entry.speakers && entry.speakers.length) {
    parts.push(`${entry.speakers.length} ${entry.speakers.length === 1 ? 'hablante' : 'hablantes'}`);
  }
  if (entry.language_code) parts.push(entry.language_code);
  parts.push(formatRelativeTime(entry.created_at));
  return parts.join(' · ');
}
function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
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
if (getApiKey()) refreshHistory();
