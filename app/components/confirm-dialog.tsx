import { useEffect } from "react";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

/**
 * A confirmation step before an action that can't be undone, such as
 * approving or declining a Refund Request. Extra fields (a note, say) go in
 * `children` and are shown between the description and the buttons.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <Card className="mx-4 w-full max-w-md">
        <CardHeader>
          <h2 id="confirm-dialog-title" className="text-lg font-semibold">
            {title}
          </h2>
          <div className="text-sm text-muted-foreground">{description}</div>
        </CardHeader>
        <CardContent className="space-y-4">
          {children}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
