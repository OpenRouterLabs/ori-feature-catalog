import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, PlatformError } from "effect";

// Tests run unprivileged, so a real chown to PREVIEW_UID always fails; these
// layers keep the Bun services and replace only the hand-off.
const servicesWithChown = (chown: FileSystem.FileSystem["chown"]) =>
  Layer.merge(
    BunServicesLayer,
    Layer.effect(FileSystem.FileSystem)(
      FileSystem.FileSystem.pipe(Effect.map((fs) => ({ ...fs, chown })))
    ).pipe(Layer.provide(BunServicesLayer))
  );

export const chownRecordingServicesLayer = (chowned: string[] = []) =>
  servicesWithChown((path) =>
    Effect.sync(() => {
      chowned.push(path);
    })
  );

export const chownRefusedServicesLayer = servicesWithChown((path) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "chown",
      pathOrDescriptor: path,
    })
  )
);
