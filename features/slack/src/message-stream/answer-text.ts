/**
 * answer-text.ts — which of the things the agent said IS the answer.
 *
 * Its own module because the run state is otherwise about what the thread
 * SHOWS while a turn is live, and this is about what it is left with.
 *
 * Takes the three fields it reads rather than the whole `RunState`, so the
 * module the run state depends on does not depend back on it.
 */

/**
 * The prose the thread should show: the last block the agent wrote.
 *
 * Falls back to the block before it, so a run whose final act was a tool call —
 * uploading a chart, posting a status — still answers with what it said.
 */
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
  // A run whose last act was a tool call — posting a chart, say — has no prose
  // left to be the answer, and the message ended as cards with a blank body
  // under them. The last thing it said is a worse answer than a real one and a
  // far better one than nothing.
  return prior === "" ? (state.log.at(-1) ?? "").trim() : prior;
};
