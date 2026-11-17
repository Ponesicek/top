export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
    }
  }
  if (started || word) words.push(word);
  return words;
}

export function joinCommand(words: readonly string[]): string {
  return words
    .map((word) => {
      if (word && !/[\s"']/.test(word)) return word;
      return word.includes('"') ? `'${word}'` : `"${word}"`;
    })
    .join(" ");
}
