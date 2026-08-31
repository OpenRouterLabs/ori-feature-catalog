export const answerText = (state: {
  readonly log: readonly string[];
  readonly priorText: string;
  readonly text: string;
}): string => {
  const current = state.text.trim();
  if (current !== "") {
    return current;
  }
  const prior = state.priorText.trim();
  return prior === "" ? (state.log.at(-1) ?? "").trim() : prior;
};
