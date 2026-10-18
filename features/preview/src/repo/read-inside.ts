import { Effect, FileSystem, Option } from "effect";

export const readInside = Effect.fn("Preview.repo.readInside")(function* (
  root: string,
  relative: string
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root).pipe(Effect.option);
  const realFile = yield* fs
    .realPath(`${root}/${relative}`)
    .pipe(Effect.option);
  if (Option.isNone(realRoot) || Option.isNone(realFile)) {
    return Option.none<string>();
  }
  if (!realFile.value.startsWith(`${realRoot.value}/`)) {
    return Option.none<string>();
  }
  return yield* fs.readFileString(realFile.value).pipe(Effect.option);
});
