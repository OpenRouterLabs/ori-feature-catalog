import { Option, Predicate, Schema } from "effect";

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);

const safeStringifyError = (value: object): string | undefined => {
  const json = Option.getOrUndefined(
    Schema.encodeOption(UnknownJsonString)(value)
  );
  return Predicate.isUndefined(json) || json === "{}" ? undefined : json;
};

const stringifyValue = (value: unknown): string =>
  Option.getOrElse(Option.liftThrowable(() => String(value))(), () =>
    Object.prototype.toString.call(value)
  );

const formatObjectError = (error: object): string | undefined => {
  const message: unknown = Predicate.hasProperty(error, "message")
    ? error.message
    : undefined;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  return safeStringifyError(error);
};

export const formatUnknownError = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (Predicate.isObjectOrArray(error)) {
    const rendered = formatObjectError(error);
    if (Predicate.isNotUndefined(rendered)) {
      return rendered;
    }
  }
  return stringifyValue(error);
};
