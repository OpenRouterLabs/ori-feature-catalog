export const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export const charsThatFit = (px: number, fontSize: number): number =>
  Math.max(1, Math.floor(px / (fontSize * 0.58)));

export const wrapText = (value: string, maxChars: number): readonly string[] => {
  const lines: string[] = [];
  let line = "";

  for (const word of value.split(/\s+/u).filter((part) => part !== "")) {
    if (line !== "" && line.length + 1 + word.length <= maxChars) {
      line = `${line} ${word}`;
      continue;
    }
    if (line !== "") {
      lines.push(line);
    }
    line = word;
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
  }
  lines.push(line);
  return lines;
};
