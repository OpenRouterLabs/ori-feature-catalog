export const ARTIFACT_COMMAND_NAMES = {
  save: "save",
  list: "list",
  delete: "delete",
} as const;

export const qualifiedArtifactCommand = (
  name: (typeof ARTIFACT_COMMAND_NAMES)[keyof typeof ARTIFACT_COMMAND_NAMES]
): string => `artifacts-o-${name}`;
