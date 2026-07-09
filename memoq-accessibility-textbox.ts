import { normalizeText } from './utils.ts';

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
