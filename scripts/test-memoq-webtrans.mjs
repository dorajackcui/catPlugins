import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

// Run with CHROME_BIN pointing to Chromium or Chrome for Testing (extension support required).
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests/browser/webtrans');
if (!process.env.CHROME_BIN) throw new Error('Set CHROME_BIN to a Chromium or Chrome for Testing executable.');
await access(process.env.CHROME_BIN, constants.X_OK);
const [workbookPath, rowsPath, expectedPath] = process.argv.slice(2);
function defaultCase() {
  const rows = ['814', '822', '835', '889', '890'].map((rowNumber, i) => ({ rowNumber,
    source: 'Take <b>part ' + i + '</> <b>{item}</>.', native: 'Take <1>part ' + i + '<2> <1><3><2>.' }));
  const expected = Object.fromEntries(rows.map((row, i) => [row.rowNumber, 'Prenez <1>la partie ' + i + '<2> <1><3><2>.']));
  expected['822'] = 'Du <1>texte<2><2> et <1>ici.';
  expected['835'] = 'Aucun marqueur.';
  expected['889'] = '<3><2><1><2><3><2><1>';
  expected['890'] = '';
  const book = xlsx.utils.book_new();
  const cells = rows.map((r, i) => [r.rowNumber, i % 2 ? r.source : r.native,
    i === 4 ? '<99>inconnu' : i > 1 ? expected[r.rowNumber].replaceAll('<1>', '<b>').replaceAll('<2>', '</>').replaceAll('<3>', '{item}') : expected[r.rowNumber], 1, r.source]);
  const custom = { rowNumber: '891', source: 'Find ⟦next:α⟧ by [[bonus]] now.', native: 'Find <9> by <7> now.' };
  rows.push(custom);
  expected[custom.rowNumber] = '<7><9><7>';
  cells.push([custom.rowNumber, custom.source, '[[bonus]]⟦next:α⟧[[bonus]]', 1, custom.source]);
  const plain = { rowNumber: '892', source: 'Test Desc', native: 'Test Desc', delayedFocus: true };
  rows.push(plain);
  expected[plain.rowNumber] = 'Description de test\u00a0:  validée\u202f!';
  cells.push([plain.rowNumber, plain.source, expected[plain.rowNumber], 1, '']);
  const sheet = xlsx.utils.aoa_to_sheet([['rowNumber', 'source', 'target', 'occurrenceIndex', 'originalSource'], ...cells.reverse()]);
  xlsx.utils.book_append_sheet(book, sheet, 'Sources');
  return { rows, expected, workbook: xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
const data = workbookPath ? { rows: JSON.parse(await readFile(rowsPath, 'utf8')), expected: JSON.parse(await readFile(expectedPath, 'utf8')), workbook: await readFile(workbookPath) } : defaultCase();
const files = { '/editor.js': await readFile(join(fixture, 'editor.js')), '/webtrans/Translation.aspx': await readFile(join(fixture, 'editor.html')) };
const temp = await mkdtemp(join(tmpdir(), 'memoq-extension-browser-'));
const directory = join(temp, 'extension');
try {
  await cp(join(root, 'dist'), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['driver.js'] }];
  await cp(join(fixture, 'driver.js'), join(directory, 'driver.js'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const mode of ['native', 'literal']) await run(mode);
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
async function run(mode) {
  let report;
  const done = new Promise(resolve => { report = resolve; });
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/report' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end('ok');
      report(JSON.parse(Buffer.concat(chunks).toString()));
    } else if (path === '/rows') res.end(JSON.stringify(data.rows));
    else if (path === '/workbook') res.end(data.workbook);
    else if (files[path]) { res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(files[path]); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port + '/webtrans/Translation.aspx?' + mode;
  const child = spawn(process.env.CHROME_BIN, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-breakpad', '--disable-default-apps', '--window-size=1400,1000', '--user-data-dir=' + join(temp, 'profile-' + mode), '--disable-extensions-except=' + directory, '--load-extension=' + directory, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3500); });
  const closed = new Promise(resolve => child.once('close', resolve));
  let timeout;
  try {
    const result = await Promise.race([done, closed.then(code => { throw Error('Test Chrome exited ' + code + ' ' + stderr); }), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Extension integration timed out. ' + stderr)), 45000); })]);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.toggled, false);
    if (mode === 'native') {
      assert.equal(result.filled, Object.values(data.expected).filter(Boolean).length, JSON.stringify(result));
      for (const row of result.rows) {
        const expected = data.expected[row.row];
        assert.equal(row.value, expected);
        assert.equal(row.inputs, expected ? 1 : 0);
        assert.deepEqual(row.markers, expected.match(/<\d+>/g) ?? []);
      }
      const exported = xlsx.read(Buffer.from(result.exportBytes), { type: 'buffer' });
      const records = xlsx.utils.sheet_to_json(exported.Sheets.Sources, { defval: '' });
      assert.deepEqual(Object.fromEntries(records.map(r => [r.rowNumber, r.target])), data.expected);
      console.log('Verified', result.filled, 'filled rows,', result.rows.reduce((n, r) => n + r.markers.length, 0), 'native tags and zero inputs on rejected rows.');
      console.log('Verified the exported XLSX preserves every target, including nonbreaking and repeated spaces.');
    } else {
      assert.equal(result.filled, 0);
      assert.match(result.reason, /native tag positions/);
      assert.deepEqual(result.rows.map(r => r.inputs), data.rows.map((_, i) => i === 0 ? 1 : 0));
      console.log('Verified stop on literal tag text before writing the next row.');
    }
  } finally {
    clearTimeout(timeout);
    child.kill();
    await closed;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
