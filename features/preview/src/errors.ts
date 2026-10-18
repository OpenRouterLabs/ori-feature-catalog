import { Schema } from "effect";

const PreviewFailureCodeSchema = Schema.Literals([
  "repo_not_found",
  "recipe_unresolved",
  "install_failed",
  "start_failed",
  "not_ready",
  "browser_unavailable",
  "capture_failed",
  "state_unreadable",
  "sandbox_unavailable",
  "github_unavailable",
]);

export class PreviewError extends Schema.TaggedError<PreviewError>()(
  "PreviewError",
  {
    code: PreviewFailureCodeSchema,
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}
