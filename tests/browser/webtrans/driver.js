// Loaded only into this test's temporary extension and loopback origin.
(async () => {
  const send = async request => {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.ok) throw new Error(response?.error || 'Missing extension response');
    return response.data;
  };
  while (!document.body.dataset.ready) await new Promise(resolve => setTimeout(resolve, 25));
  const file = await (await fetch('/workbook')).arrayBuffer();
  await send({ type: 'SET_EDITOR_PLATFORM', payload: { editorPlatform: 'memoq' } });
  await send({ type: 'PARSE_EXCEL', payload: { fileName: 'integration.xlsx', bytes: Array.from(new Uint8Array(file)) } });
  const fillOptions = { validatePlaceholders: true, autoStopAfterFilledCount: document.querySelectorAll('tbody tr').length };
  const result = await send({ type: 'RUN_FILL', payload: { fillOptions } });
  const rows = Array.from(document.querySelectorAll('tbody tr')).map(tr => {
    const content = tr.querySelector('.translated-segment-grid .content-container');
    const value = Array.from(content.childNodes, node => node.nodeType === 3 ? node.textContent : '<' + node.firstElementChild.dataset.tagid + '>').join('');
    return { row: tr.dataset.number, value, inputs: Number(content.dataset.inputs || 0),
      markers: Array.from(content.querySelectorAll('.tag-content'), chip => '<' + chip.dataset.tagid + '>') };
  });
  const toggled = !!document.body.dataset.toggled;
  const exported = location.search === '?native' ? await send({ type: 'EXPORT_SOURCES' }) : null;
  return { filled: result.filledCount, reason: result.stopReason, toggled, rows, exportBytes: exported?.bytes };
})().catch(error => ({ error: error.message })).then(report => fetch('/report', { method: 'POST', body: JSON.stringify(report) }));
