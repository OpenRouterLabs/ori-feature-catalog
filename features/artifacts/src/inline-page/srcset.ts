export interface SrcsetCandidate {
  readonly descriptor: string;
  readonly url: string;
}

const WHITESPACE = /\s/u;
const TRAILING_COMMAS = /,+$/u;

export const parseSrcset = (value: string): readonly SrcsetCandidate[] => {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (
      index < value.length &&
      (WHITESPACE.test(value.charAt(index)) || value.charAt(index) === ",")
    ) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    const urlStart = index;
    while (index < value.length && !WHITESPACE.test(value.charAt(index))) {
      index += 1;
    }
    const rawUrl = value.slice(urlStart, index);
    const url = rawUrl.replace(TRAILING_COMMAS, "");
    if (url !== rawUrl) {
      candidates.push({ descriptor: "", url });
      continue;
    }
    const descriptorEnd = value.indexOf(",", index);
    const end = descriptorEnd === -1 ? value.length : descriptorEnd;
    candidates.push({ descriptor: value.slice(index, end).trim(), url });
    index = end + 1;
  }
  return candidates;
};

export const serializeSrcset = (
  candidates: readonly SrcsetCandidate[]
): string =>
  candidates
    .map((candidate) =>
      candidate.descriptor === ""
        ? candidate.url
        : `${candidate.url} ${candidate.descriptor}`
    )
    .join(", ");
