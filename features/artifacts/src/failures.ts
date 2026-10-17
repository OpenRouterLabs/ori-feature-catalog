import { Predicate, Schema } from "effect";

import { formatUnknownError } from "#src/format-unknown.ts";

export class CliFailureError extends Schema.TaggedError<CliFailureError>()(
  "CliFailureError",
  {
    detail: Schema.String,
    hint: Schema.optional(Schema.String),
    failureCode: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {
  override readonly message = this.detail;
}

export const makeCliFailureFromCause =
  (input: {
    readonly detail: string;
    readonly failureCode: string;
    readonly hint?: string | undefined;
  }) =>
  (cause: unknown): CliFailureError => {
    if (Schema.is(CliFailureError)(cause)) {
      return new CliFailureError({
        cause,
        detail: `${input.detail}: ${cause.detail}`,
        failureCode: input.failureCode,
        hint: cause.hint ?? input.hint,
      });
    }
    return new CliFailureError({
      cause,
      detail: `${input.detail}: ${formatUnknownError(cause)}`,
      failureCode: input.failureCode,
      hint: input.hint,
    });
  };
