import { Schema } from "effect";

type AnyFunction = (...args: never[]) => unknown;

/**
 * A schema for a function member. Decoding checks only that the value is
 * callable; the signature is a type-level claim the runtime cannot verify.
 */
export const functionSchema = <Shape extends AnyFunction>(
  identifier: string
): Schema.declare<Shape, Shape> =>
  Schema.declare<Shape>(
    (value): value is Shape => typeof value === "function",
    { identifier }
  );

/**
 * A schema for a value this feature does not own the shape of -- a Promise, an
 * AbortSignal, a Slack SDK client. It accepts anything, so it carries a type
 * through a schema without claiming the type was validated. Use it only where
 * nothing decodes.
 */
export const opaqueSchema = <Shape>(
  identifier: string
): Schema.declare<Shape, Shape> =>
  Schema.declare<Shape>((_value): _value is Shape => true, { identifier });
