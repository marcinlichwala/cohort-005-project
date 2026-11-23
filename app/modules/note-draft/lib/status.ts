export type NoteDraftStatus = {
  /** Characters the Note will hold once saved: the server trims the body. */
  length: number;
  max: number;
  overLimit: boolean;
  /** The draft differs from the saved Note. */
  unsaved: boolean;
  canSave: boolean;
  counter: string;
};

export function describeDraft(
  draft: string,
  savedBody: string | undefined,
  max: number
): NoteDraftStatus {
  const trimmed = draft.trim();
  const length = trimmed.length;
  const overLimit = length > max;
  const unsaved = trimmed !== (savedBody ?? "");
  return {
    length,
    max,
    overLimit,
    unsaved,
    canSave: unsaved && length > 0 && !overLimit,
    counter: `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`,
  };
}
