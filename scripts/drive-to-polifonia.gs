/**
 * Polifonía — Trigger Drive → AssemblyAI
 *
 * Vigila una carpeta de Google Drive y transcribe automáticamente cualquier
 * audio o video que aparezca ahí. Crea un Google Doc con el resultado y
 * mueve el audio a "Procesados".
 *
 * Setup:
 *   1) Crea un proyecto nuevo en https://script.google.com
 *   2) Pega ESTE archivo entero (reemplaza el código demo de hello world)
 *   3) Pega tu API key de AssemblyAI en la constante API_KEY (abajo)
 *   4) Corre la función `setup()` una vez (autoriza permisos cuando lo pida)
 *   5) Agrega un trigger temporal:
 *        Triggers (icono del reloj) → Add Trigger →
 *        Function: processInbox · Event: Time-driven · Every 5 minutes
 *   6) Listo. Arrastra audios a la carpeta "Polifonía Inbox" en tu Drive.
 *
 * Las transcripciones también aparecen automáticamente en la web de Polifonía
 * (https://audio-pi-rosy.vercel.app) porque comparten la misma API key.
 */

// =============== CONFIGURACIÓN ===============
const API_KEY = 'PEGA_AQUI_TU_API_KEY_DE_ASSEMBLYAI';

const LANGUAGE = 'auto';     // 'auto' (auto-detectar) | 'es' | 'en' | 'pt' | ...
const SPEAKERS = 2;           // Hablantes esperados por defecto

const FOLDER_INBOX       = 'Polifonía Inbox';
const FOLDER_PROCESSED   = 'Polifonía Procesados';
const FOLDER_TRANSCRIPTS = 'Polifonía Transcripciones';
// =============================================

const AAI = 'https://api.assemblyai.com/v2';

/**
 * Corre esto UNA VEZ a mano después de pegar el script,
 * para crear las carpetas en tu Drive y autorizar permisos.
 */
function setup() {
  if (!API_KEY || API_KEY === 'PEGA_AQUI_TU_API_KEY_DE_ASSEMBLYAI') {
    throw new Error('Falta pegar tu API key de AssemblyAI en la constante API_KEY');
  }
  const inbox       = getOrCreateFolder(FOLDER_INBOX);
  const processed   = getOrCreateFolder(FOLDER_PROCESSED);
  const transcripts = getOrCreateFolder(FOLDER_TRANSCRIPTS);
  Logger.log('Carpetas listas:');
  Logger.log('  ' + FOLDER_INBOX       + ' → ' + inbox.getUrl());
  Logger.log('  ' + FOLDER_PROCESSED   + ' → ' + processed.getUrl());
  Logger.log('  ' + FOLDER_TRANSCRIPTS + ' → ' + transcripts.getUrl());
  Logger.log('Ahora crea el trigger temporal para processInbox (cada 5 min).');
}

/**
 * Función principal — corre cada N minutos vía time trigger.
 *  1) Revisa transcripciones pendientes y procesa las que ya terminaron
 *  2) Sube los audios nuevos de Inbox y los marca como pendientes
 */
function processInbox() {
  if (!API_KEY || API_KEY === 'PEGA_AQUI_TU_API_KEY_DE_ASSEMBLYAI') {
    Logger.log('Falta API_KEY — abortando');
    return;
  }

  const props   = PropertiesService.getScriptProperties();
  const pending = JSON.parse(props.getProperty('pending') || '{}');

  const inbox             = getOrCreateFolder(FOLDER_INBOX);
  const processedFolder   = getOrCreateFolder(FOLDER_PROCESSED);
  const transcriptsFolder = getOrCreateFolder(FOLDER_TRANSCRIPTS);

  // 1) Checkear los pendientes
  for (const fileId of Object.keys(pending)) {
    const transcriptId = pending[fileId];
    try {
      const status = getTranscriptStatus(transcriptId);
      if (status.status === 'completed') {
        const file = DriveApp.getFileById(fileId);
        createTranscriptDoc(status, file.getName(), transcriptsFolder);
        moveFile(file, processedFolder);
        delete pending[fileId];
        Logger.log('✓ Procesada: ' + file.getName());
      } else if (status.status === 'error') {
        Logger.log('✗ Error en ' + transcriptId + ': ' + status.error);
        delete pending[fileId];
      } else {
        Logger.log('… ' + status.status + ': ' + transcriptId);
      }
    } catch (e) {
      Logger.log('Error chequeando ' + transcriptId + ': ' + e.message);
    }
  }

  // 2) Subir los nuevos
  const files = inbox.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (pending[file.getId()]) continue;
    if (!isAudioOrVideo(file)) continue;

    try {
      Logger.log('↑ Subiendo: ' + file.getName() + ' (' + file.getSize() + ' bytes)');
      const blob        = file.getBlob();
      const uploadUrl   = uploadToAssembly(blob);
      const transcriptId = startTranscription(uploadUrl);
      pending[file.getId()] = transcriptId;
      Logger.log('→ Iniciada: ' + transcriptId);
    } catch (e) {
      Logger.log('Error subiendo ' + file.getName() + ': ' + e.message);
    }
  }

  props.setProperty('pending', JSON.stringify(pending));
}

// ----- AssemblyAI -----

function uploadToAssembly(blob) {
  const res = UrlFetchApp.fetch(AAI + '/upload', {
    method: 'post',
    headers: { 'Authorization': API_KEY },
    contentType: 'application/octet-stream',
    payload: blob.getBytes(),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Upload HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  const data = JSON.parse(res.getContentText());
  if (!data.upload_url) throw new Error('Respuesta sin upload_url');
  return data.upload_url;
}

function startTranscription(uploadUrl) {
  const body = {
    audio_url: uploadUrl,
    speaker_labels: true,
    speakers_expected: SPEAKERS,
  };
  if (LANGUAGE === 'auto') body.language_detection = true;
  else body.language_code = LANGUAGE;

  const res = UrlFetchApp.fetch(AAI + '/transcript', {
    method: 'post',
    headers: { 'Authorization': API_KEY },
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Start HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()).id;
}

function getTranscriptStatus(id) {
  const res = UrlFetchApp.fetch(AAI + '/transcript/' + encodeURIComponent(id), {
    headers: { 'Authorization': API_KEY },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Status HTTP ' + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

// ----- Drive helpers -----

function createTranscriptDoc(result, audioFilename, parentFolder) {
  const baseName = audioFilename.replace(/\.[^.]+$/, '');
  const docName  = baseName + ' — Transcripción';

  const doc  = DocumentApp.create(docName);
  const body = doc.getBody();
  body.clear();

  body.appendParagraph(baseName).setHeading(DocumentApp.ParagraphHeading.HEADING1);

  const meta = [];
  if (result.audio_duration) meta.push('Duración: ' + formatDuration(result.audio_duration));
  if (result.language_code)  meta.push('Idioma: ' + result.language_code);
  if (result.utterances) {
    const n = new Set(result.utterances.map(function (u) { return u.speaker; })).size;
    meta.push(n + ' ' + (n === 1 ? 'hablante' : 'hablantes'));
  }
  meta.push('ID: ' + result.id);
  const metaPara = body.appendParagraph(meta.join(' · '));
  metaPara.editAsText().setItalic(true).setForegroundColor('#666666');

  body.appendParagraph('');

  if (result.utterances && result.utterances.length) {
    result.utterances.forEach(function (u) {
      const head = body.appendParagraph('Hablante ' + u.speaker + ' · ' + formatTime(u.start));
      head.editAsText().setBold(true).setForegroundColor('#4f46e5');
      body.appendParagraph(u.text);
      body.appendParagraph('');
    });
  } else {
    body.appendParagraph(result.text || '(sin texto)');
  }

  doc.saveAndClose();

  // Mover el doc a la carpeta de Transcripciones
  const docFile = DriveApp.getFileById(doc.getId());
  parentFolder.addFile(docFile);
  DriveApp.getRootFolder().removeFile(docFile);
}

function moveFile(file, targetFolder) {
  targetFolder.addFile(file);
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() !== targetFolder.getId()) {
      p.removeFile(file);
    }
  }
}

function isAudioOrVideo(file) {
  const mime = file.getMimeType() || '';
  return mime.indexOf('audio/') === 0 || mime.indexOf('video/') === 0;
}

function getOrCreateFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

// ----- Format helpers -----

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + ':' + pad(m) + ':' + pad(s);
  return m + ':' + pad(s);
}
function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + pad(s);
}
function pad(n) { return String(n).padStart(2, '0'); }
