const data = await (await fetch('/rows')).json();
const body = document.querySelector('tbody');
const field = document.querySelector('input');
let target;
function render(root, value, literal = false) {
  root.replaceChildren();
  let seq = 0;
  for (const part of value.split(/(<\d+>)/)) {
    if (!/^<\d+>$/.test(part) || literal) { root.append(part); continue; }
    const tag = document.createElement('span');
    tag.className = 'tag inline-empty';
    const chip = document.createElement('span');
    chip.className = 'tag-content';
    chip.dataset.tagid = part.slice(1, -1);
    chip.dataset.seq = String(seq++);
    chip.textContent = chip.dataset.tagid;
    tag.append(chip);
    root.append(tag);
  }
}
for (const row of data) {
  const tr = body.insertRow();
  tr.dataset.number = row.rowNumber;
  Object.assign(tr.insertCell(), { className: 'order', textContent: row.rowNumber + '.' });
  for (const side of ['original', 'translated']) {
    const cell = tr.insertCell();
    cell.className = side + '-segment-grid';
    cell.innerHTML = '<div class="editor-cell-container"><div class="editor-cell"><span class="content-container"></span></div></div>';
    if (side === 'original') render(cell.querySelector('span'), row.native);
    else cell.addEventListener('mousedown', () => {
      document.querySelector('.focused')?.classList.remove('focused');
      cell.firstElementChild.classList.add('focused');
      target = cell.querySelector('.content-container');
    });
    if (side === 'translated') cell.addEventListener('click', () => {
      if (row.delayedFocus) {
        field.blur();
        setTimeout(() => field.focus(), 230);
      } else {
        field.focus();
      }
    });
  }
}
document.querySelector('button').onclick = () => { document.body.dataset.toggled = 'yes'; };
field.addEventListener('input', event => {
  if (!event.isTrusted || !target || !field.value) return;
  const cell = target;
  cell.dataset.inputs = String(Number(cell.dataset.inputs || 0) + 1);
  const text = field.value;
  field.value = '';
  setTimeout(() => render(cell, text, location.search === '?literal'), 40);
});
document.body.dataset.ready = 'true';
