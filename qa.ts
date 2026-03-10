export function extractPlaceholderTokens(input: string): string[] {
  const tokens: Array<{ index: number; token: string }> = [];
  const patterns = [/\{[^{}]+\}/g, /<\/?[\w-]+(?:\s+[^<>]*)?>/g, /%[sd]/g];

  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      tokens.push({
        index: match.index ?? 0,
        token: match[0]
      });
    }
  }

  return tokens
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.token);
}

export function placeholdersMatch(source: string, target: string): boolean {
  const sourceTokens = extractPlaceholderTokens(source);
  const targetTokens = extractPlaceholderTokens(target);

  if (sourceTokens.length !== targetTokens.length) {
    return false;
  }

  return sourceTokens.every((token, index) => token === targetTokens[index]);
}

