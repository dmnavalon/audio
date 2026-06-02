// Polifonía — transcripción con identificación de hablantes.
// API key vive en el servidor (env ASSEMBLYAI_API_KEY). El front solo habla con /api/*.

const els = {
  input: document.getElementById('audioInput'),
  drop: document.getElementById('uploadBox'),
  langSelect: document.getElementById('languageSelect'),
  speakersInput: document.getElementById('speakersInput'),
  progressPanel: document.getElementById('progressPanel'),
  progressLabel: document.getElementById('progressLabel'),
  progressBar: document.getElementById('progressBar'),
  cancelBtn: document.getElementById('cancelBtn'),
  resultPanel: document.getElementById('resultPanel'),
  resultFilename: document.getElementById('resultFilename'),
  resultMeta: document.getElementById('resultMeta'),
  utterances: document.getElementById('utterances'),
  copyBtn: document.getElementById('copyBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  logs: document.getElementById('logs'),
  toasts: document.getElementById('toasts'),
};

const SPEAKER_VARS = [
  '--speaker-1','--speaker-2','--speaker-3','--speaker-4','--speaker-5',
  '--speaker-6','--speaker-7','--speaker-8','--speaker-9','--speaker-10',
];

const state = {
  xhr: null,
  transcriptId: null,
  cancelled: false,
  currentFile: null,
  result: null,
};

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
  if (els.drop.classList.contains('is-disabled')) return;
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
els.drop.addEventListener('click', () => {
  if (!els.drop.classList.contains('is-disabled')) els.input.click();
});
els.drop.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && !els.drop.classList.contains('is-disabled')) {
    e.preventDefault();
    els.input.click();
  }
});
els.input.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = '';
});

els.cancelBtn.addEventListener('click', cancel);
els.copyBtn.addEventListener('click', copyToClipboard);
els.downloadBtn.addEventListener('click', downloadTxt);

async function handleFile(file) {
  state.cancelled = false;
  state.currentFile = file;
  state.result = null;
  hideResult();
  setDropDisabled(true);
  showProgress(`Subiendo "${file.name}"…`, 0);
  log(`Iniciando: ${file.name} (${formatBytes(file.size)})`);

  try {
    const uploadUrl = await uploadFile(file);
    if (state.cancelled) return;
    log('Subida completa');

    updateProgress('Iniciando transcripción…', null);
    const langValue = els.langSelect.value;
    const speakers = Math.max(1, Math.min(10, +els.speakersInput.value || 2));
    const id = await startTranscription(uploadUrl, langValue, speakers);
    state.transcriptId = id;
    if (state.cancelled) {
      cancelRemote(id);
      return;
    }
    log(`Transcripción iniciada: ${id}`);

    updateProgress('Transcribiendo…', null);
    const result = await waitForTranscript(id);
    if (state.cancelled) return;
    log('Transcripción completa');

    state.result = result;
    renderResult(file, result);
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
    setDropDisabled(false);
    state.xhr = null;
    state.transcriptId = null;
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', '/api/upload');
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
      } else if (xhr.status === 413) {
        reject(new Error('El archivo es demasiado grande (límite 4.5MB en Vercel Hobby)'));
      } else {
        reject(new Error(`Subida falló (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Error de red al subir'));
    xhr.onabort = () => reject(new Error('Subida cancelada'));
    xhr.send(file);
  });
}

async function startTranscription(uploadUrl, lang, speakers) {
  const body = {
    audio_url: uploadUrl,
    speaker_labels: true,
    speakers_expected: speakers,
  };
  if (lang === 'auto') {
    body.language_detection = true;
  } else {
    body.language_code = lang;
  }
  const res = await fetch('/api/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    log(`Error iniciando transcripción: ${txt}`);
    throw new Error(`No se pudo iniciar la transcripción (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.id;
}

async function waitForTranscript(id) {
  let lastStatus = '';
  while (true) {
    if (state.cancelled) throw new Error('Cancelado');
    const res = await fetch(`/api/transcript?id=${encodeURIComponent(id)}`);
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

async function cancelRemote(id) {
  try {
    await fetch(`/api/transcript?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    log(`Cancelado en AssemblyAI: ${id}`);
  } catch (e) {
    log(`No se pudo cancelar en AssemblyAI: ${e.message}`);
  }
}

function cancel() {
  if (state.cancelled) return;
  state.cancelled = true;
  if (state.xhr) state.xhr.abort();
  if (state.transcriptId) cancelRemote(state.transcriptId);
  hideProgress();
  setDropDisabled(false);
  toast('Operación cancelada');
}

function renderResult(file, result) {
  els.resultFilename.textContent = file.name;
  const parts = [];
  if (result.audio_duration) parts.push(formatDuration(result.audio_duration));
  if (result.utterances && result.utterances.length) {
    const speakers = new Set(result.utterances.map(u => u.speaker)).size;
    parts.push(`${speakers} ${speakers === 1 ? 'hablante' : 'hablantes'}`);
  }
  if (result.language_code) parts.push(`idioma: ${result.language_code}`);
  els.resultMeta.textContent = parts.join(' · ');

  els.utterances.innerHTML = '';
  if (result.utterances && result.utterances.length) {
    const colorOf = new Map();
    result.utterances.forEach(u => {
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
      els.utterances.appendChild(node);
    });
  } else {
    const node = document.createElement('p');
    node.className = 'utterance-text';
    node.textContent = result.text || '(sin texto)';
    els.utterances.appendChild(node);
  }
  els.resultPanel.hidden = false;
}

function hideResult() {
  els.resultPanel.hidden = true;
  els.utterances.innerHTML = '';
}

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
  els.drop.setAttribute('tabindex', disabled ? '-1' : '0');
}

async function copyToClipboard() {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(formatPlainText(state.result));
    toast('Copiado al portapapeles', 'success');
  } catch {
    toast('No se pudo copiar', 'error');
  }
}
function downloadTxt() {
  if (!state.result || !state.currentFile) return;
  const blob = new Blob([formatPlainText(state.result)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = state.currentFile.name.replace(/\.[^.]+$/, '');
  a.href = url;
  a.download = `${base}-transcripcion.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function formatPlainText(result) {
  if (result.utterances && result.utterances.length) {
    return result.utterances
      .map(u => `Hablante ${u.speaker}: ${u.text}`)
      .join('\n\n');
  }
  return result.text || '';
}

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
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
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
