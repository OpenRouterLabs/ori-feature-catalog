import { describe, expect, test } from "bun:test";

import { parseGraphSource } from "./graph-source.ts";

const idsOf = (source: string): string =>
  parseGraphSource(source)
    .nodes.map((node) => `${node.id}:${node.kind ?? "-"}:${node.label}`)
    .join(" ");

const edgesOf = (source: string): string =>
  parseGraphSource(source)
    .edges.map(
      (edge) => `${edge.from}->${edge.to}${edge.label ? `(${edge.label})` : ""}`
    )
    .join(" ");

describe("parseGraphSource", () => {
  test("reads a branch that splits and rejoins", () => {
    // The shape our own schema made awkward enough that the model never drew
    // it: two paths out of a decision, back into one step.
    const source = `flowchart TD
      A(Boots) --> B{Bundled?}
      B -->|yes| C[Copy to temp]
      B -->|no| D[Load in place]
      C --> E[Lazy import]
      D --> E`;

    expect(edgesOf(source)).toBe("A->B B->C(yes) B->D(no) C->E D->E");
  });

  test("bracket shapes carry the node kind", () => {
    expect(idsOf("A(Start) --> B{Choose} --> C[Do it]")).toBe(
      "A:start:Start B:decision:Choose C:step:Do it"
    );
  });

  test("a label given once survives a later bare mention", () => {
    // "C --> E" after "C[Copy to temp]" must not rename C to "C".
    expect(idsOf("A[Copy to temp] --> B[Next]\n A --> B")).toBe(
      "A:step:Copy to temp B:step:Next"
    );
  });

  test("a bare id is its own label", () => {
    expect(idsOf("start --> finish")).toBe("start:-:start finish:-:finish");
  });

  test("the header, comments and blank lines are skipped", () => {
    expect(edgesOf("graph LR\n%% a note\n\n  A --> B")).toBe("A->B");
  });

  test("a line it cannot read is skipped, not fatal", () => {
    // A diagram missing one line still reads; an error message does not.
    expect(edgesOf("A --> B\n!!! nonsense (((\nB --> C")).toContain("A->B");
    expect(edgesOf("A --> B\n!!! nonsense (((\nB --> C")).toContain("B->C");
  });

  test("a chained line links every pair", () => {
    expect(edgesOf("A[One] --> B[Two] --> C[Three]")).toBe("A->B B->C");
  });

  test("each arrow in a chain keeps its own label", () => {
    expect(edgesOf("A -->|first| B -->|second| C")).toBe(
      "A->B(first) B->C(second)"
    );
  });

  test("an undirected link still connects", () => {
    expect(edgesOf("A --- B")).toBe("A->B");
  });
});
