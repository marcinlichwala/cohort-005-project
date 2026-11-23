import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { NotebookPen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { cn, formatRelativeTime } from "~/lib/utils";
import { noteDraftStatus } from "~/modules/note-draft";

export function LessonNote({
  note,
}: {
  note: { body: string; updatedAt: string } | null | undefined;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [draft, setDraft] = useState(note?.body ?? "");
  const status = noteDraftStatus(draft, note?.body);
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  return (
    <Card className="mb-8">
      <CardContent className="space-y-4">
        <NoteHeader />

        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="save-note" />
          <Textarea
            name="body"
            aria-label="Your notes"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What do you want to remember from this lesson?"
            aria-invalid={status.overLimit || !!error}
            className="min-h-32 resize-y"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={isSaving || !status.canSave}
            >
              {isSaving ? "Saving..." : "Save note"}
            </Button>
            <NoteSaveState
              error={error}
              unsaved={status.unsaved}
              updatedAt={note?.updatedAt}
            />
            <NoteCounter
              counter={status.counter}
              overLimit={status.overLimit}
            />
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

function NoteSaveState({
  error,
  unsaved,
  updatedAt,
}: {
  error: string | undefined;
  unsaved: boolean;
  updatedAt: string | undefined;
}) {
  if (error) return <span className="text-sm text-destructive">{error}</span>;
  if (unsaved && updatedAt)
    return (
      <span className="text-xs text-muted-foreground">Unsaved changes</span>
    );
  if (!updatedAt) return null;
  return (
    <span suppressHydrationWarning className="text-xs text-muted-foreground">
      Saved · last edited {formatRelativeTime(updatedAt)}
    </span>
  );
}

function NoteHeader() {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <NotebookPen className="size-5 text-primary" />
        <h2 className="text-xl font-semibold">Your notes</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Private to you. Find every note you've written on your{" "}
        <Link to="/saved" className="underline underline-offset-2">
          Saved
        </Link>{" "}
        page.
      </p>
    </div>
  );
}

function NoteCounter({
  counter,
  overLimit,
}: {
  counter: string;
  overLimit: boolean;
}) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tabular-nums text-muted-foreground",
        overLimit && "text-destructive"
      )}
    >
      {counter}
    </span>
  );
}
