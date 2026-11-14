import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

type ButtonVariant = React.ComponentProps<typeof Button>["variant"];

/**
 * A button that opens a confirmation step before it posts a form to the
 * current route's action. `fields` become hidden inputs (for example the
 * `intent` and the record id); `children` adds extra inputs to the
 * confirmation step, such as an optional note.
 */
export function ConfirmAction({
  triggerLabel,
  title,
  description,
  confirmLabel,
  fields,
  variant = "default",
  children,
}: {
  triggerLabel: string;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  fields: Record<string, string>;
  variant?: ButtonVariant;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";

  // Close once the action has finished; the loader revalidates the list.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) setOpen(false);
  }, [fetcher.state, fetcher.data]);

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <Card className="mx-4 w-full max-w-md">
            <CardHeader>
              <h2 className="text-lg font-semibold">{title}</h2>
              <div className="text-sm text-muted-foreground">{description}</div>
            </CardHeader>
            <CardContent>
              <fetcher.Form method="post" className="space-y-4">
                {Object.entries(fields).map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                {children}
                <div className="flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant={variant} disabled={submitting}>
                    {submitting ? "Working…" : confirmLabel}
                  </Button>
                </div>
              </fetcher.Form>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
