import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { requirePlatformAdmin } from "~/lib/access.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequests,
  markRefundFailed,
  markRefundIssued,
  RefundRuleError,
  type DecidedRefundRequestRow,
  type OpenRefundRequestRow,
} from "~/lib/refunds.server";
import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";
import { parseFormData } from "~/lib/validation";
import { ConfirmAction } from "~/components/confirm-action";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

// Admin-only: the loader and every action call requirePlatformAdmin first.
// All refund logic lives in ~/lib/refunds.server; this route only parses
// input and renders.

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

const DECLINE_NOTE_MAX_LENGTH = 1000;

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineNote: z
      .string()
      .trim()
      .max(
        DECLINE_NOTE_MAX_LENGTH,
        `Please keep the Decline Note under ${DECLINE_NOTE_MAX_LENGTH} characters.`
      )
      .optional(),
  }),
  z.object({
    intent: z.literal("mark-issued"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-failed"),
    refundId: z.coerce.number().int(),
  }),
]);

export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);

  const { open, decided } = listRefundRequests();
  return { openRequests: open, decidedRequests: decided };
}

export async function action({ request }: Route.ActionArgs) {
  const { userId } = await requirePlatformAdmin(request);

  const parsed = parseFormData(await request.formData(), refundActionSchema);
  if (!parsed.success) {
    const message = Object.values(parsed.errors)[0] ?? "Invalid request.";
    throw data(message, { status: 400 });
  }

  try {
    switch (parsed.data.intent) {
      case "approve":
        approveRefundRequest(parsed.data.refundRequestId, userId);
        return { success: true };
      case "decline":
        declineRefundRequest(
          parsed.data.refundRequestId,
          userId,
          parsed.data.declineNote
        );
        return { success: true };
      case "mark-issued":
        markRefundIssued(parsed.data.refundId, userId);
        return { success: true };
      case "mark-failed":
        markRefundFailed(parsed.data.refundId, userId);
        return { success: true };
    }
  } catch (error) {
    if (error instanceof RefundRuleError) {
      throw data(error.message, { status: 409 });
    }
    throw error;
  }
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { openRequests, decidedRequests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Work through Refund Requests, oldest first
        </p>
      </div>

      <OpenRefundRequestsSection requests={openRequests} />
      <DecidedRefundRequestsSection requests={decidedRequests} />
    </div>
  );
}

// ─── Open Refund Requests ───

function OpenRefundRequestsSection({
  requests,
}: {
  requests: OpenRefundRequestRow[];
}) {
  return (
    <section>
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <ReceiptText className="size-4" />
        <span>
          {requests.length} open{" "}
          {requests.length === 1 ? "request" : "requests"}
        </span>
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="mb-1 text-muted-foreground">
              No Open Refund Requests.
            </p>
            <p className="text-sm text-muted-foreground">
              New requests from learners will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <HeaderCell>Learner</HeaderCell>
                    <HeaderCell>Course</HeaderCell>
                    <HeaderCell>Amount paid</HeaderCell>
                    <HeaderCell>Since purchase</HeaderCell>
                    <HeaderCell>Watched</HeaderCell>
                    <HeaderCell>Reason</HeaderCell>
                    <HeaderCell>Decide</HeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <OpenRefundRequestRowView
                      key={request.id}
                      request={request}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  );
}

function OpenRefundRequestRowView({
  request,
}: {
  request: OpenRefundRequestRow;
}) {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3 text-sm">
        <div className="font-medium">{request.learnerName}</div>
        <div className="text-muted-foreground">{request.learnerEmail}</div>
      </td>
      <td className="px-4 py-3 text-sm">{request.courseTitle}</td>
      <td className="px-4 py-3 text-sm">{formatPrice(request.amountPaid)}</td>
      <td className="px-4 py-3 text-sm">
        {request.daysSincePurchase}{" "}
        {request.daysSincePurchase === 1 ? "day" : "days"}
      </td>
      <td className="px-4 py-3 text-sm">
        {formatHours(request.hoursWatched)}
      </td>
      <td className="max-w-md whitespace-pre-wrap px-4 py-3 text-sm">
        {request.reason}
      </td>
      <td className="px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <ApproveRefundRequest request={request} />
          <DeclineRefundRequest request={request} />
        </div>
      </td>
    </tr>
  );
}

function ApproveRefundRequest({ request }: { request: OpenRefundRequestRow }) {
  // No eligibility warning here on purpose: the admin may approve past the
  // window or the watch limit (ADR 0001). The facts are in the row.
  return (
    <ConfirmAction
      triggerLabel="Approve"
      title="Approve this Refund Request?"
      description={
        <>
          {request.learnerName} will get a Pending Refund of{" "}
          <strong>{formatPrice(request.amountPaid)}</strong>, the full amount
          paid for {request.courseTitle}, and an approval email. You can't
          undo this.
        </>
      }
      confirmLabel="Approve request"
      fields={{ intent: "approve", refundRequestId: String(request.id) }}
    />
  );
}

function DeclineRefundRequest({ request }: { request: OpenRefundRequestRow }) {
  const noteId = `decline-note-${request.id}`;
  return (
    <ConfirmAction
      triggerLabel="Decline"
      variant="destructive"
      title="Decline this Refund Request?"
      description={
        <>
          {request.learnerName} will get an email saying their request for{" "}
          {request.courseTitle} ({formatPrice(request.amountPaid)}) was
          declined. They can raise a new one later.
        </>
      }
      confirmLabel="Decline request"
      fields={{ intent: "decline", refundRequestId: String(request.id) }}
    >
      <div className="space-y-2">
        <Label htmlFor={noteId}>Decline Note (optional)</Label>
        <Textarea
          id={noteId}
          name="declineNote"
          maxLength={DECLINE_NOTE_MAX_LENGTH}
          placeholder="Tell the learner why. This goes in the email."
        />
      </div>
    </ConfirmAction>
  );
}

// ─── History: decided Refund Requests ───

function DecidedRefundRequestsSection({
  requests,
}: {
  requests: DecidedRefundRequestRow[];
}) {
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-xl font-semibold">History</h2>
      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No decided Refund Requests yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <HeaderCell>Learner</HeaderCell>
                    <HeaderCell>Course</HeaderCell>
                    <HeaderCell>Amount paid</HeaderCell>
                    <HeaderCell>Decision</HeaderCell>
                    <HeaderCell>Decided</HeaderCell>
                    <HeaderCell>Refund</HeaderCell>
                    <HeaderCell>Reason</HeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <DecidedRefundRequestRowView
                      key={request.id}
                      request={request}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function DecidedRefundRequestRowView({
  request,
}: {
  request: DecidedRefundRequestRow;
}) {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3 text-sm">
        <div className="font-medium">{request.learnerName}</div>
        <div className="text-muted-foreground">{request.learnerEmail}</div>
      </td>
      <td className="px-4 py-3 text-sm">{request.courseTitle}</td>
      <td className="px-4 py-3 text-sm">{formatPrice(request.amountPaid)}</td>
      <td className="px-4 py-3 text-sm">
        <DecisionPill status={request.status} />
        {request.status === RefundRequestStatus.Declined && (
          <p className="mt-2 max-w-xs whitespace-pre-wrap text-muted-foreground">
            {request.declineNote ? (
              <>Note: {request.declineNote}</>
            ) : (
              <span className="italic">No Decline Note</span>
            )}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {request.resolvedAt
          ? new Date(request.resolvedAt).toLocaleDateString()
          : "—"}
        {request.resolvedByName && <div>by {request.resolvedByName}</div>}
      </td>
      <td className="px-4 py-3 text-sm">
        {request.refundStatus ? (
          <>
            <RefundStatusPill status={request.refundStatus} />
            {request.refundStatusChangedAt && (
              <div className="mt-1 text-muted-foreground">
                {new Date(request.refundStatusChangedAt).toLocaleDateString()}
                {request.refundStatusChangedByName &&
                  ` by ${request.refundStatusChangedByName}`}
              </div>
            )}
            <RefundStatusControls request={request} />
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="max-w-md whitespace-pre-wrap px-4 py-3 text-sm">
        {request.reason}
      </td>
    </tr>
  );
}

// Only the changes the refund module allows are offered: Pending can become
// Issued or Failed, Failed can become Issued, and Issued is final.
function RefundStatusControls({
  request,
}: {
  request: DecidedRefundRequestRow;
}) {
  const { refundId, refundStatus } = request;
  if (refundId === null || refundStatus === null) return null;
  const canMarkIssued =
    refundStatus === RefundStatus.Pending ||
    refundStatus === RefundStatus.Failed;
  const canMarkFailed = refundStatus === RefundStatus.Pending;
  if (!canMarkIssued && !canMarkFailed) return null;

  const amount = formatPrice(request.refundAmount ?? request.amountPaid);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {canMarkIssued && (
        <ConfirmAction
          triggerLabel="Mark Issued"
          title="Mark this Refund Issued?"
          description={
            <>
              Confirm you have sent <strong>{amount}</strong> to{" "}
              {request.learnerName}. Their enrollment in {request.courseTitle}{" "}
              ends (progress is kept) and they get a "your money is on its
              way" email. Issued is final.
            </>
          }
          confirmLabel="Mark Issued"
          fields={{ intent: "mark-issued", refundId: String(refundId) }}
        />
      )}
      {canMarkFailed && (
        <ConfirmAction
          triggerLabel="Mark Failed"
          variant="destructive"
          title="Mark this Refund Failed?"
          description={
            <>
              The {amount} to {request.learnerName} couldn't be sent. No email
              goes out and they keep access. You can mark it Issued after a
              successful retry.
            </>
          }
          confirmLabel="Mark Failed"
          fields={{ intent: "mark-failed", refundId: String(refundId) }}
        />
      )}
    </div>
  );
}

function DecisionPill({ status }: { status: RefundRequestStatus }) {
  const declined = status === RefundRequestStatus.Declined;
  return (
    <span
      className={
        declined
          ? "rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
          : "rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300"
      }
    >
      {declined ? "Declined" : "Approved"}
    </span>
  );
}

function RefundStatusPill({ status }: { status: RefundStatus }) {
  const styles: Record<RefundStatus, { label: string; className: string }> = {
    [RefundStatus.Pending]: {
      label: "Pending",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    },
    [RefundStatus.Issued]: {
      label: "Issued",
      className:
        "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    },
    [RefundStatus.Failed]: {
      label: "Failed",
      className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    },
  };
  const { label, className } = styles[status];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function formatHours(hours: number) {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only platform admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
