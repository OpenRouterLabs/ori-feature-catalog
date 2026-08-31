export const clampToWord = (text: string, budget: number): string => {
  if (text.length <= budget) {
    return text;
  }
  const cut = text.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};
