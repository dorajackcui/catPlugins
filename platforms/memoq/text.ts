import { MEMOQ_MARKER_PATTERN } from '../../domain/memoq-file-tags.ts';
import { normalizeText } from '../../shared/utils.ts';

const MEMOQ_NUMERIC_PLACEHOLDER_PATTERN = /\{(\d+)\}/g;

/**
 * Escapes literal numeric placeholders for memoQ's plain-text input path.
 * memoQ interprets `{n}` as a native marker while `{{n}` commits as the
 * intended literal `{n}`.
 */
export function escapeMemoqPlainTargetText(value: string): string {
  return value.replace(MEMOQ_NUMERIC_PLACEHOLDER_PATTERN, '{{$1}');
}

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

function nativeTagText(element: HTMLElement): string {
  const chip = element.querySelector<HTMLElement>('.tag-content');
  const id = chip?.getAttribute?.('data-tagid');
  return formatMemoqInlineTag(element.className,
    id && /^\d+$/.test(id) ? id : chip?.textContent || element.textContent || '');
}

export function readMemoqNativeMarkers(content: HTMLElement): string[] {
  return Array.from(content.querySelectorAll<HTMLElement>('.tag'), nativeTagText);
}

export function readMemoqOriginalSource(content: HTMLElement): string | undefined {
  let hasTags = false;
  let complete = true;
  const value = serializeContent(content, undefined, element => {
    hasTags = true;
    const label = element.querySelector('.tag-content')?.textContent ?? '';
    // webTrans shows the protected source verbatim in the last val attribute.
    // Quotes and backslashes inside that value belong to the source file.
    const match = /^mq:rxt\s+displaytext="[\s\S]*?"\s+val="([\s\S]*)"$/.exec(label);
    if (!match) complete = false;
    return match?.[1] ?? '';
  });
  return hasTags && complete ? value : undefined;
}

export function serializeMemoqContentExact(
  content: HTMLElement,
  visitText?: (node: Text, start: number) => void
): string {
  return serializeContent(content, visitText, nativeTagText);
}

/** A literal "<1>" in a text node must never confirm a native marker paste. */
export function matchesMemoqNativeTarget(content: HTMLElement, expected: string): boolean {
  const markers = expected.matchAll(MEMOQ_MARKER_PATTERN);
  let matches = true;
  const actual = serializeContent(content, undefined, (element, offset) => {
    const marker = nativeTagText(element);
    const next = markers.next();
    if (next.done || next.value.index !== offset || next.value[0] !== marker) matches = false;
    return marker;
  });
  return matches && markers.next().done === true && actual === expected;
}

function serializeContent(
  content: HTMLElement,
  visitText: ((node: Text, start: number) => void) | undefined,
  tagText: (element: HTMLElement, offset: number) => string
): string {
  let value = '';

  const visit = (node: ChildNode): void => {
    if (node.nodeType === 3) {
      visitText?.(node as Text, value.length);
      value += node.textContent || '';
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
      value += tagText(element, value.length);
      return;
    }

    if (element.classList.contains('ws-space')) {
      value += ' ';
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      visit(child);
    }
  };

  for (const child of Array.from(content.childNodes)) {
    visit(child);
  }

  return value || content.innerText || content.textContent || '';
}

export function serializeMemoqContent(content: HTMLElement): string {
  return normalizeText(serializeMemoqContentExact(content));
}
