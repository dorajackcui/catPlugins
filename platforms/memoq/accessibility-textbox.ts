import { containsNoBreakSpace, normalizeText, normalizeTextPreservingNoBreakSpaces } from '../../shared/utils.ts';

export const MEMOQ_TEXTBOX_SELECTOR = 'textarea, input[type="text"]';

export function warnIfMemoqNoBreakSpacesConverted(row: string, value: string): void {
  if (!containsNoBreakSpace(value) || typeof document.querySelectorAll !== 'function') return;
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(MEMOQ_TEXTBOX_SELECTOR);
  const pair = chooseMemoqAccessibilityTextBoxes(Array.from(inputs));
  const committed = pair?.target.value || pair?.target.textContent;
  if (committed && normalizeText(committed) === normalizeText(value) &&
    normalizeTextPreservingNoBreakSpaces(committed) !== normalizeTextPreservingNoBreakSpaces(value)) {
    console.warn('[Phrase Bulk Fill] memoQ stored this segment without its no-break spaces', { row, expected: value, committed });
  }
}

type MemoqAccessibilityTextBoxLike = Pick<
  HTMLInputElement | HTMLTextAreaElement,
  'id' | 'disabled' | 'readOnly' | 'value' | 'textContent'
>;

export function shouldUseMemoqAccessibilityTextBox(
  textBox: MemoqAccessibilityTextBoxLike,
  options: { requireWritable: boolean }
): boolean {
  if (textBox.id === 'editorHiddenInput') {
    return false;
  }

  if (options.requireWritable && (textBox.disabled || textBox.readOnly)) {
    return false;
  }

  return true;
}

export function readMemoqAccessibilityTextBoxValue(
  textBox: Pick<HTMLInputElement | HTMLTextAreaElement, 'value' | 'textContent'>
): string {
  return normalizeText(textBox.value || textBox.textContent || '');
}

export function chooseMemoqAccessibilityTextBoxes<T extends MemoqAccessibilityTextBoxLike>(
  textBoxes: T[]
): { source: T; target: T } | null {
  const readable = textBoxes.filter((textBox) =>
    shouldUseMemoqAccessibilityTextBox(textBox, { requireWritable: false })
  );
  const source = readable.find((textBox) => textBox.disabled || textBox.readOnly);
  const target = readable.find((textBox) =>
    shouldUseMemoqAccessibilityTextBox(textBox, { requireWritable: true })
  );

  if (!source || !target) {
    return null;
  }

  return { source, target };
}
