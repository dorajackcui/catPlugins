"use strict";
(() => {
  // chrome-api.ts
  async function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  // popup.ts
  var state = {
    busy: false,
    stopping: false
  };
  var uploadButton = document.querySelector("#upload-button");
  var fileInput = document.querySelector("#file-input");
  var previewButton = document.querySelector("#preview-button");
  var fillButton = document.querySelector("#fill-button");
  var stopButton = document.querySelector("#stop-button");
  var fileInfo = document.querySelector("#file-info");
  var statusNode = document.querySelector("#status");
  var previewNode = document.querySelector("#preview-summary");
  var previewListNode = document.querySelector("#preview-items");
  var STOP_ERROR_MESSAGE = "Operation stopped by user.";
  async function sendMessage(message) {
    const response = await runtimeSendMessage(message);
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.data;
  }
  function setBusy(nextBusy) {
    state.busy = nextBusy;
    if (uploadButton) uploadButton.disabled = nextBusy;
    if (previewButton) previewButton.disabled = nextBusy;
    if (fillButton) fillButton.disabled = nextBusy;
    if (stopButton) stopButton.disabled = !nextBusy || state.stopping;
  }
  function setStopping(nextStopping) {
    state.stopping = nextStopping;
    if (stopButton) stopButton.disabled = !state.busy || nextStopping;
  }
  function renderStatus(message, kind = "default") {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.dataset.kind = kind;
  }
  function renderPreview(preview) {
    if (!previewNode || !previewListNode) {
      return;
    }
    if (!preview) {
      previewNode.innerHTML = "<li>Total segments: -</li><li>Matched: -</li><li>Already translated: -</li><li>Placeholder errors: -</li><li>Ready to fill: -</li><li>Skipped: -</li>";
      previewListNode.innerHTML = "";
      return;
    }
    previewNode.innerHTML = [
      `Total segments: ${preview.totalSegments}`,
      `Matched: ${preview.matched}`,
      `Already translated: ${preview.alreadyTranslated}`,
      `Placeholder errors: ${preview.placeholderErrors}`,
      `Ready to fill: ${preview.readyToFill}`,
      `Skipped: ${preview.skipped}`
    ].map((line) => `<li>${line}</li>`).join("");
    const readyItems = preview.items.filter((item) => item.status === "ready").slice(0, 15);
    previewListNode.innerHTML = readyItems.length ? readyItems.map((item) => `<li>${escapeHtml(item.sourceRaw)}</li>`).join("") : "<li>No fillable segments in the current preview.</li>";
  }
  function renderFileInfo(popupState) {
    if (!fileInfo) {
      return;
    }
    if (!popupState.uploadMeta) {
      fileInfo.textContent = "No Excel file uploaded yet.";
      if (previewButton) previewButton.disabled = true;
      if (fillButton) fillButton.disabled = true;
      if (stopButton) stopButton.disabled = true;
      return;
    }
    fileInfo.textContent = `${popupState.uploadMeta.fileName} \xB7 ${popupState.uploadMeta.entryCount} rows \xB7 sheet ${popupState.uploadMeta.sheetName}`;
    if (previewButton) previewButton.disabled = state.busy;
    if (fillButton) fillButton.disabled = state.busy;
    if (stopButton) stopButton.disabled = !state.busy || state.stopping;
  }
  async function refreshState() {
    const popupState = await sendMessage({ type: "GET_STATE" });
    renderFileInfo(popupState);
    renderPreview(popupState.previewResult);
  }
  function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  async function handleUpload(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    try {
      setBusy(true);
      renderStatus("Parsing Excel...");
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const result = await sendMessage({
        type: "PARSE_EXCEL",
        payload: { fileName: file.name, bytes }
      });
      renderStatus(`Loaded ${result.entryCount} translation rows from ${file.name}.`);
      await refreshState();
    } catch (error) {
      renderStatus(error instanceof Error ? error.message : "Upload failed.", "error");
    } finally {
      input.value = "";
      setBusy(false);
    }
  }
  async function handlePreview() {
    try {
      setBusy(true);
      setStopping(false);
      renderStatus("Scanning Phrase segments...");
      const preview = await sendMessage({ type: "RUN_PREVIEW" });
      renderPreview(preview);
      renderStatus(`Preview ready. ${preview.readyToFill} segment(s) can be filled.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed.";
      renderStatus(message === STOP_ERROR_MESSAGE ? "Stopped." : message, message === STOP_ERROR_MESSAGE ? "default" : "error");
    } finally {
      setStopping(false);
      setBusy(false);
      await refreshState();
    }
  }
  async function handleFill() {
    try {
      setBusy(true);
      setStopping(false);
      renderStatus("Re-scanning and filling segments...");
      const result = await sendMessage({ type: "RUN_FILL" });
      renderPreview(result.preview);
      renderStatus(`Filled ${result.filledCount} segment(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fill failed.";
      renderStatus(message === STOP_ERROR_MESSAGE ? "Stopped." : message, message === STOP_ERROR_MESSAGE ? "default" : "error");
    } finally {
      setStopping(false);
      setBusy(false);
      await refreshState();
    }
  }
  async function handleStop() {
    if (!state.busy || state.stopping) {
      return;
    }
    try {
      setStopping(true);
      renderStatus("Stopping current run...");
      await sendMessage({ type: "STOP_RUN" });
    } catch (error) {
      setStopping(false);
      renderStatus(error instanceof Error ? error.message : "Stop failed.", "error");
    }
  }
  uploadButton?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (event) => {
    void handleUpload(event);
  });
  previewButton?.addEventListener("click", () => {
    void handlePreview();
  });
  fillButton?.addEventListener("click", () => {
    void handleFill();
  });
  stopButton?.addEventListener("click", () => {
    void handleStop();
  });
  void refreshState().catch((error) => {
    renderStatus(error instanceof Error ? error.message : "Failed to load state.", "error");
  });
})();
//# sourceMappingURL=popup.js.map
