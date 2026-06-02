// La API key vive en el servidor (variable de entorno ASSEMBLYAI_API_KEY).
// El front solo habla con /api/* — nunca con AssemblyAI directamente.

// Referencia al XHR para poder abortar la subida
let currentXhr = null;

// Elementos del DOM
const audioInput = document.getElementById("audioInput");
const uploadBox = document.getElementById("uploadBox");
const stopUploadBtn = document.getElementById("stopUploadBtn");

// Listeners
audioInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

// Para detener la subida
stopUploadBtn.addEventListener("click", stopUpload);

// DRAG & DROP
uploadBox.addEventListener("dragenter", (e) => {
  e.preventDefault();
  uploadBox.classList.add("drag-over");
});
uploadBox.addEventListener("dragleave", (e) => {
  e.preventDefault();
  uploadBox.classList.remove("drag-over");
});
uploadBox.addEventListener("dragover", (e) => {
  e.preventDefault();
});
uploadBox.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadBox.classList.remove("drag-over");
  if (e.dataTransfer.files.length) {
    const file = e.dataTransfer.files[0];
    handleFile(file);
  }
});

// Clic en la caja: dispara el input "file"
uploadBox.addEventListener("click", () => {
  audioInput.click();
});

// Procesar archivo
async function handleFile(file) {
  clearLogs();
  showLoading(true);
  showStopButton(true);

  try {
    logMessage("Iniciando subida...");
    const uploadUrl = await uploadFile(file);

    logMessage("Subida completada. URL: " + uploadUrl);
    showStopButton(false);

    const language = document.getElementById("languageSelect").value;
    const speakers = document.getElementById("speakersInput").value;

    updateStatus("Procesando audio...");
    logMessage(`Iniciando transcripción: idioma=${language}, hablantes=${speakers}`);

    const transcriptId = await startTranscription(uploadUrl, language, speakers);
    logMessage("Transcripción iniciada. ID: " + transcriptId);

    updateStatus("Transcribiendo...");
    const result = await waitForTranscript(transcriptId);
    logMessage("Transcripción finalizada con éxito.");

    showResults(result.utterances);
    autoSaveLocal(result.text);

  } catch (error) {
    alert(`Error: ${error.message}`);
    logMessage("ERROR: " + error.message);
  } finally {
    showLoading(false);
    showStopButton(false);
  }
}

// Subir archivo con XHR (progress y cancelación)
function uploadFile(file) {
  updateStatus("Subiendo archivo... (0%)");

  return new Promise((resolve, reject) => {
    currentXhr = new XMLHttpRequest();
    currentXhr.open("POST", "/api/upload", true);

    currentXhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = (event.loaded / event.total) * 100;
        updateStatus(`Subiendo archivo... (${percent.toFixed(2)}%)`);
      }
    };

    currentXhr.onload = () => {
      if (currentXhr.status === 200) {
        const data = JSON.parse(currentXhr.responseText || "{}");
        if (data.upload_url) {
          resolve(data.upload_url);
        } else {
          logMessage("Error en respuesta: " + currentXhr.responseText);
          reject(new Error('No se encontró "upload_url" en la respuesta'));
        }
      } else {
        logMessage(`Error al subir. Status: ${currentXhr.status}`);
        logMessage("Respuesta del servidor: " + currentXhr.responseText);
        reject(new Error(`Error al subir. Status: ${currentXhr.status}`));
      }
      currentXhr = null;
    };

    currentXhr.onerror = () => {
      logMessage("Error de red o CORS al subir.");
      reject(new Error("Error de red o CORS"));
      currentXhr = null;
    };

    currentXhr.send(file);
  });
}

// Detener la subida en curso
function stopUpload() {
  if (currentXhr) {
    logMessage("El usuario canceló la subida.");
    currentXhr.abort();
    currentXhr = null;
    updateStatus("Subida cancelada por el usuario");
    showStopButton(false);
  }
}

// Iniciar transcripción
async function startTranscription(uploadUrl, lang, spk) {
  const response = await fetch("/api/transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speaker_labels: true,
      language_code: lang,
      speakers_expected: +spk
    })
  });

  if (!response.ok) {
    const text = await response.text();
    logMessage(`Error iniciando transcripción. Status: ${response.status}`);
    logMessage("Respuesta del servidor: " + text);
    throw new Error(`No se pudo iniciar la transcripción (HTTP ${response.status})`);
  }

  const data = await response.json();
  return data.id;
}

// Esperar a que finalice (polling)
async function waitForTranscript(id) {
  while (true) {
    const response = await fetch(`/api/transcript?id=${encodeURIComponent(id)}`);
    const data = await response.json();

    if (data.status === "completed") return data;
    if (data.status === "error") {
      logMessage(`Error en transcripción: ${data.error}`);
      throw new Error(`Transcripción fallida: ${data.error}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
    updateStatus(`Estado: ${data.status}...`);
    logMessage(`Esperando transcripción. Estado: ${data.status}`);
  }
}

// Mostrar resultado
function showResults(utterances) {
  const formattedText = utterances
    .map(u => `Speaker ${u.speaker}: ${u.text}`)
    .join("\n\n");
  document.getElementById("resultado").textContent = formattedText;
}

// Guardar txt
function autoSaveLocal(text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `transcripcion_${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

// Helpers
function showLoading(show) {
  document.querySelector(".loading").style.display = show ? "block" : "none";
}

function updateStatus(text) {
  document.getElementById("statusText").textContent = text;
}

function showStopButton(show) {
  stopUploadBtn.style.display = show ? "block" : "none";
}

function logMessage(msg) {
  const logsEl = document.getElementById("logs");
  const timestamp = new Date().toLocaleTimeString();
  logsEl.textContent += `[${timestamp}] ${msg}\n`;
}

function clearLogs() {
  document.getElementById("logs").textContent = "";
}
