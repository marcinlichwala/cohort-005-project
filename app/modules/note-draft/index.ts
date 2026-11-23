import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { describeDraft, type NoteDraftStatus } from "./lib/status";

export type { NoteDraftStatus };

/**
 * What the note box shows about the Student's draft: how long it is against
 * the cap, whether it differs from the saved Note, and whether Save would
 * succeed. Mirrors the rules `saveNote` enforces on the server.
 */
export function noteDraftStatus(
  draft: string,
  savedBody: string | undefined,
  max: number = MAX_NOTE_LENGTH
): NoteDraftStatus {
  return describeDraft(draft, savedBody, max);
}
