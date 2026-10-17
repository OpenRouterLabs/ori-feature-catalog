import { Data, Predicate } from "effect";

export type CssReference = Data.TaggedEnum<{
  Import: {
    readonly condition: string;
    readonly end: number;
    readonly start: number;
    readonly url: string;
  };
  Url: { readonly end: number; readonly start: number; readonly url: string };
}>;
export const CssReference = Data.taggedEnum<CssReference>();

interface Scanned {
  readonly end: number;
  readonly value: string;
}

const HEX_ESCAPE = /^[0-9a-fA-F]{1,6}[ \t\n]?/u;
const NAME_CHARACTER = /^[A-Za-z0-9_\u0080-￿-]$/u;
const IMAGE_SET_OPENING = /^(?:-webkit-)?image-set\(/iu;
const MAX_CODE_POINT = 0x10_ff_ff;

const isWhitespace = (character: string): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f";

const isNameCharacter = (character: string): boolean =>
  NAME_CHARACTER.test(character);

const startsWithWord = (css: string, at: number, word: string): boolean =>
  css.slice(at, at + word.length).toLowerCase() === word;

const readEscape = (css: string, backslash: number): Scanned => {
  const hex = HEX_ESCAPE.exec(css.slice(backslash + 1, backslash + 8));
  if (hex !== null) {
    const codePoint = Number.parseInt(hex[0].trim(), 16);
    return {
      end: backslash + 1 + hex[0].length,
      value:
        codePoint === 0 || codePoint > MAX_CODE_POINT
          ? "�"
          : String.fromCodePoint(codePoint),
    };
  }
  return { end: backslash + 2, value: css.charAt(backslash + 1) };
};

const readString = (css: string, start: number): Scanned => {
  const quote = css.charAt(start);
  let index = start + 1;
  let value = "";
  while (index < css.length) {
    const character = css.charAt(index);
    if (character === quote) {
      return { end: index + 1, value };
    }
    if (character === "\n") {
      return { end: index, value };
    }
    if (character === "\\") {
      if (css.charAt(index + 1) === "\n") {
        index += 2;
        continue;
      }
      const escape = readEscape(css, index);
      value += escape.value;
      index = escape.end;
      continue;
    }
    value += character;
    index += 1;
  }
  return { end: index, value };
};

const skipWhitespace = (css: string, start: number): number => {
  let index = start;
  while (index < css.length && isWhitespace(css.charAt(index))) {
    index += 1;
  }
  return index;
};

const readUrlBody = (css: string, start: number): Scanned => {
  const open = skipWhitespace(css, start);
  const first = css.charAt(open);
  if (first === '"' || first === "'") {
    const quoted = readString(css, open);
    const close = css.indexOf(")", quoted.end);
    return {
      end: close === -1 ? css.length : close + 1,
      value: quoted.value,
    };
  }
  let index = open;
  let value = "";
  while (index < css.length && css.charAt(index) !== ")") {
    if (css.charAt(index) === "\\") {
      const escape = readEscape(css, index);
      value += escape.value;
      index = escape.end;
      continue;
    }
    value += css.charAt(index);
    index += 1;
  }
  return {
    end: Math.min(index + 1, css.length),
    value: value.trim(),
  };
};

const readImportTarget = (css: string, start: number): Scanned | undefined => {
  const first = css.charAt(start);
  if (first === '"' || first === "'") {
    return readString(css, start);
  }
  if (startsWithWord(css, start, "url(")) {
    return readUrlBody(css, start + 4);
  }
  return undefined;
};

const findRuleEnd = (css: string, start: number): number => {
  let index = start;
  let depth = 0;
  while (index < css.length) {
    const character = css.charAt(index);
    if (character === '"' || character === "'") {
      index = readString(css, index).end;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    } else if (character === ";" && depth === 0) {
      return index;
    }
    index += 1;
  }
  return css.length;
};

const readImport = (css: string, at: number): CssReference | undefined => {
  const targetStart = skipWhitespace(css, at + "@import".length);
  const target = readImportTarget(css, targetStart);
  if (Predicate.isUndefined(target)) {
    return undefined;
  }
  const ruleEnd = findRuleEnd(css, target.end);
  return CssReference.Import({
    condition: css.slice(target.end, ruleEnd).trim(),
    end: Math.min(ruleEnd + 1, css.length),
    start: at,
    url: target.value,
  });
};

interface ScanState {
  depth: number;
  imageSetDepth: number;
  readonly references: CssReference[];
}

const scanQuoted = (css: string, index: number, state: ScanState): number => {
  const scanned = readString(css, index);
  if (state.imageSetDepth > 0 && state.depth === state.imageSetDepth) {
    state.references.push(
      CssReference.Url({ end: scanned.end, start: index, url: scanned.value })
    );
  }
  return scanned.end;
};

const scanParenthesis = (
  character: string,
  index: number,
  state: ScanState
): number => {
  if (character === "(") {
    state.depth += 1;
    return index + 1;
  }
  if (state.depth === state.imageSetDepth) {
    state.imageSetDepth = 0;
  }
  state.depth = Math.max(0, state.depth - 1);
  return index + 1;
};

const scanFunctionName = (
  css: string,
  index: number,
  state: ScanState
): number | undefined => {
  if (isNameCharacter(css.charAt(index - 1))) {
    return undefined;
  }
  if (startsWithWord(css, index, "url(")) {
    const body = readUrlBody(css, index + 4);
    state.references.push(
      CssReference.Url({ end: body.end, start: index, url: body.value })
    );
    return body.end;
  }
  const imageSet = IMAGE_SET_OPENING.exec(css.slice(index, index + 18));
  if (imageSet === null) {
    return undefined;
  }
  state.depth += 1;
  state.imageSetDepth = state.depth;
  return index + imageSet[0].length;
};

const scanImport = (
  css: string,
  index: number,
  state: ScanState
): number | undefined => {
  if (!startsWithWord(css, index, "@import")) {
    return undefined;
  }
  const rule = readImport(css, index);
  if (Predicate.isUndefined(rule)) {
    return undefined;
  }
  state.references.push(rule);
  return rule.end;
};

const skipComment = (css: string, index: number): number => {
  const close = css.indexOf("*/", index + 2);
  return close === -1 ? css.length : close + 2;
};

const scanStep = (css: string, index: number, state: ScanState): number => {
  const character = css.charAt(index);
  if (character === "/" && css.charAt(index + 1) === "*") {
    return skipComment(css, index);
  }
  if (character === "\\") {
    return index + 2;
  }
  if (character === '"' || character === "'") {
    return scanQuoted(css, index, state);
  }
  if (character === "(" || character === ")") {
    return scanParenthesis(character, index, state);
  }
  return (
    (character === "@" ? scanImport(css, index, state) : undefined) ??
    scanFunctionName(css, index, state) ??
    index + 1
  );
};

export const scanCssReferences = (css: string): readonly CssReference[] => {
  const state: ScanState = { depth: 0, imageSetDepth: 0, references: [] };
  let index = 0;
  while (index < css.length) {
    index = scanStep(css, index, state);
  }
  return state.references;
};

export const replaceCssReferences = (
  css: string,
  references: readonly CssReference[],
  replacements: readonly (string | undefined)[]
): string => {
  let output = "";
  let cursor = 0;
  references.forEach((reference, position) => {
    const replacement = replacements[position];
    if (Predicate.isUndefined(replacement)) {
      return;
    }
    output += css.slice(cursor, reference.start) + replacement;
    cursor = reference.end;
  });
  return output + css.slice(cursor);
};

const CHARSET_RULE = /^﻿?@charset\s+(?:"[^"]*"|'[^']*')\s*;/iu;
const LAYER_CONDITION = /^layer(?:\(([^)]*)\))?\s*/iu;
const SUPPORTS_CONDITION = /^supports\(/iu;

const takeSupports = (
  condition: string
): { readonly query: string; readonly rest: string } | undefined => {
  if (!SUPPORTS_CONDITION.test(condition)) {
    return undefined;
  }
  let depth = 0;
  for (let index = "supports".length; index < condition.length; index += 1) {
    const character = condition.charAt(index);
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          query: condition.slice("supports".length, index + 1),
          rest: condition.slice(index + 1).trim(),
        };
      }
    }
  }
  return undefined;
};

export const wrapImportedCss = (css: string, condition: string): string => {
  const body = css.replace(CHARSET_RULE, "");
  let rest = condition.trim();
  let wrapped = body;
  const wrappers: string[] = [];
  const layer = LAYER_CONDITION.exec(rest);
  if (layer !== null) {
    wrappers.push(
      `@layer${Predicate.isUndefined(layer[1]) ? "" : ` ${layer[1].trim()}`}`
    );
    rest = rest.slice(layer[0].length);
  }
  const supports = takeSupports(rest);
  if (Predicate.isNotUndefined(supports)) {
    wrappers.push(`@supports ${supports.query}`);
    rest = supports.rest;
  }
  if (rest !== "") {
    wrappers.push(`@media ${rest}`);
  }
  for (const wrapper of wrappers.toReversed()) {
    wrapped = `${wrapper}{${wrapped}}`;
  }
  return wrapped;
};
