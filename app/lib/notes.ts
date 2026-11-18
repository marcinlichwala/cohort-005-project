import { z } from "zod";

// ─── Notes (shared) ───
// The Note body rules, shared by the Lesson page's form parsing and the notes
// service so the two can never disagree. A Note is plain text: it is never
// passed through the Markdown renderer.

export const MAX_NOTE_LENGTH = 2000;

export const noteBodySchema = z
  .string()
  .trim()
  .min(1, "Write something before saving your note.")
  .max(
    MAX_NOTE_LENGTH,
    `A note must be ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`
  );
