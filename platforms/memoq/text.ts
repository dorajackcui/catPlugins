import { normalizeText } from '../../utils.ts';

function stripMemoqInlineTagMarkup(value: string): string {
  return value
    .replace(/\{(\d+)>/g, '$1')
    .replace(/<(\d+)\}/g, '$1')
    .replace(/<(\d+)>/g, '$1');
}

export { stripMemoqInlineTagMarkup };

export function memoQAccessibilityTextToRenderedText(value: string): string {
  return normalizeText(stripMemoqInlineTagMarkup(value));
}

// With "show whitespace marks" enabled, memoQ renders spaces as U+00B7
// middle dots and no-break spaces as U+00B0 degree signs in the cell DOM.
const MEMOQ_RENDERED_WHITESPACE_MARKS = new RegExp(
  `[${String.fromCharCode(0x00b7, 0x00b0)}]`,
  'g'
);

function normalizeMemoqRenderedWhitespace(value: string): string {
  return normalizeText(value.replace(MEMOQ_RENDERED_WHITESPACE_MARKS, ' '));
}

export function isMemoqCommittedTargetText(cellText: string, value: string): boolean {
  // The rendered cell cannot distinguish no-break spaces from plain spaces
  // (editors render plain spaces as U+00A0 to stop HTML collapsing them), so
  // the commit check must stay whitespace-insensitive.
  const committedText = normalizeText(cellText);
  const expected = normalizeText(value);
  const renderedExpected = memoQAccessibilityTextToRenderedText(value);

  if (
    committedText === expected ||
    committedText === renderedExpected
  ) {
    return true;
  }

  // Fall back to a comparison that treats memoQ's whitespace display marks
  // as the whitespace they stand for. Mapped on both sides so genuine
  // middle dots or degree signs in the translation still line up.
  const committedMarked = normalizeMemoqRenderedWhitespace(cellText);
  return (
    committedMarked === normalizeMemoqRenderedWhitespace(value) ||
    committedMarked === normalizeMemoqRenderedWhitespace(stripMemoqInlineTagMarkup(value))
  );
}

export function formatMemoqInlineTag(className: string, tagText: string): string {
  const tagId = normalizeText(tagText);
  if (!tagId) {
    return '';
  }

  if (className.includes('inline-open')) {
    return `{${tagId}>`;
  }

  if (className.includes('inline-close')) {
    return `<${tagId}}`;
  }

  return `<${tagId}>`;
}

export function serializeMemoqContent(content: HTMLElement): string {
  const fragments: string[] = [];

  const visit = (node: ChildNode): void => {
    if (node.nodeType === 3) {
      fragments.push(node.textContent || '');
      return;
    }

    if (node.nodeType !== 1) {
      return;
    }

    const element = node as HTMLElement;
    if (element.matches('textarea,input')) {
      return;
    }

    if (element.classList.contains('tag')) {
      const tagContent = element.querySelector<HTMLElement>('.tag-content');
      fragments.push(
        formatMemoqInlineTag(
          element.className,
          tagContent?.textContent || element.textContent || ''
        )
      );
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      visit(child);
    }
  };

  for (const child of Array.from(content.childNodes)) {
    visit(child);
  }

  const serialized = fragments.join('');
  return normalizeText(serialized || content.innerText || content.textContent || '');
}
