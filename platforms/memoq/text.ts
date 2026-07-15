import { normalizeText } from '../../shared/utils.ts';

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

const MEMOQ_RENDERED_SPACE_PATTERN = `[\\s${String.fromCharCode(0x00b7, 0x00b0)}]+`;

function escapeRegExpCharacter(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesMemoqRenderedWhitespace(cellText: string, expected: string): boolean {
  const trimmedExpected = expected.trim();
  let pattern = '';

  for (let index = 0; index < trimmedExpected.length; index += 1) {
    const character = trimmedExpected[index];
    if (/\s/.test(character)) {
      while (index + 1 < trimmedExpected.length && /\s/.test(trimmedExpected[index + 1])) {
        index += 1;
      }
      pattern += MEMOQ_RENDERED_SPACE_PATTERN;
      continue;
    }

    pattern += escapeRegExpCharacter(character);
  }

  return new RegExp(`^${pattern}$`, 'u').test(cellText.trim());
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

  // Only expected whitespace can match memoQ's display marks. Literal middle
  // dots and degree signs in the expected translation must remain literal.
  return (
    matchesMemoqRenderedWhitespace(cellText, value) ||
    matchesMemoqRenderedWhitespace(cellText, stripMemoqInlineTagMarkup(value))
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
