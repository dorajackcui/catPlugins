/** webTrans gives each filtered result a position before it has fetched its cells. */
interface ExportRow {
  number: string;
  position: number | null;
  pending: boolean;
}

export function createWebTransExportReader(
  doc: Document,
  visibleRows: () => HTMLElement[],
  scrollBack: () => Promise<boolean>
): (checkStop: () => void) => Promise<string[]> {
  const collected: string[] = [];
  const numbers = new Set<string>();
  let indexed: boolean | undefined;

  function snapshot(): ExportRow[] {
    const rows = visibleRows().sort((left, right) =>
      left.getBoundingClientRect().top - right.getBoundingClientRect().top
    );
    return rows.flatMap(row => {
      const number = row.querySelector('.order')?.textContent?.trim().replace(/\.$/, '');
      if (!number) return [];
      const position = row.getAttribute('data-id') ?? '';
      return [{
        number,
        position: /^\d+$/.test(position) ? Number(position) : null,
        pending: row.classList.contains('not-loaded-row')
      }];
    });
  }

  async function loadedPage(checkStop: () => void): Promise<ExportRow[]> {
    let page = snapshot();
    const expectRows = page.length > 0 || collected.length > 0;
    // A completed fetch can leave the old placeholder on screen. Refreshing
    // the tag display repaints the grid from webTrans's own loaded row data.
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((page.length || !expectRows) && page.every(row => !row.pending)) return page;
      checkStop();
      if (attempt % 10 === 1) {
        const toggle = doc.getElementById('gridBtnLongInlineTag');
        if (toggle) {
          const selected = toggle.classList.contains('selected');
          try {
            toggle.click();
          } finally {
            if (toggle.classList.contains('selected') !== selected) toggle.click();
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      page = snapshot();
    }
    const pending = page.find(row => row.pending);
    if (pending) throw new Error(`memoQ has not loaded row ${pending.number}. No workbook was created.`);
    if (!page.length && expectRows) throw new Error('The memoQ grid became empty during export. No workbook was created.');
    return page;
  }

  return async checkStop => {
    let page = await loadedPage(checkStop);
    if (page.length && indexed === undefined) {
      // Other webTrans versions may expose document IDs here instead.
      indexed = page[0].position === 0;
    }
    if (indexed) {
      // Repainting variable-height rows can move the window past unread rows.
      while (page[0]?.position != null && page[0].position > collected.length) {
        checkStop();
        if (!await scrollBack()) break;
        page = await loadedPage(checkStop);
      }
      for (const { number, position } of page) {
        if (position === collected.length && !numbers.has(number)) {
          collected.push(number);
          numbers.add(number);
        } else if (position === null || collected[position] !== number) {
          throw new Error(`The filtered memoQ row order changed before row ${number}. No workbook was created.`);
        }
      }
    }
    return page.map(row => row.number);
  };
}
