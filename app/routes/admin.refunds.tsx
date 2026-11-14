import { useEffect, useState } from "react";
import { AlertTriangle, History, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { requirePlatformAdmin } from "~/lib/access.server";
import {
  approveRefundRequest,
  listRefundRequests,
  RefundRuleError,
  type DecidedRefundRequestRow,
  type OpenRefundRequestRow,
} from "~/lib/refunds.server";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/confirm-dialog";

// Admin-only: the loader and every action call requirePlatformAdmin first.
// All refund logic lives in ~/lib/refunds.server; this route only parses
// input and renders.

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

// One member per admin decision. Later tickets add decline, mark-issued and
// mark-failed alongside approve.
const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int().positive(),
  }),
]);

export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);

  const { open, decided } = listRefundRequests();
  return { openRequests: open, decidedRequests: decided };
}

export async function action({ request }: Route.ActionArgs) {
  const { userId } = await requirePlatformAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    throw data(Object.values(parsed.errors)[0] ?? "Invalid input.", {
      status: 400,
    });
  }

  try {
    switch (parsed.data.intent) {
      case "approve":
        approveRefundRequest(parsed.data.refundRequestId, userId);
        return { success: true, message: "Refund Request approved." };
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

      <RefundHistorySection requests={decidedRequests} />
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
                    <HeaderCell>Decision</HeaderCell>
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
          <ApproveButton request={request} />
        </div>
      </td>
    </tr>
  );
}

// ─── Decisions ───

function ApproveButton({ request }: { request: OpenRefundRequestRow }) {
  const fetcher = useFetcher<typeof action>();
  const [confirming, setConfirming] = useState(false);
  const pending = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success(fetcher.data.message);
      setConfirming(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <>
      <Button size="sm" onClick={() => setConfirming(true)}>
        Approve
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Approve this Refund Request?"
        description={
          <>
            {request.learnerName} will get a Pending Refund of{" "}
            <strong>{formatPrice(request.amountPaid)}</strong>, the full
            amount paid for {request.courseTitle}, and an approval email. You
            can't undo this.
          </>
        }
        confirmLabel="Approve"
        pendingLabel="Approving…"
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          fetcher.submit(
            { intent: "approve", refundRequestId: String(request.id) },
            { method: "post" }
          )
        }
      />
    </>
  );
}

// ─── History ───

function RefundHistorySection({
  requests,
}: {
  requests: DecidedRefundRequestRow[];
}) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-center gap-2">
        <History className="size-4 text-muted-foreground" />
        <h2 className="text-xl font-semibold">History</h2>
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
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
        <RefundRequestStatusBadge status={request.status} />
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {request.decidedAt
          ? new Date(request.decidedAt).toLocaleDateString()
          : "—"}
        {request.decidedByName ? ` by ${request.decidedByName}` : ""}
      </td>
      <td className="px-4 py-3 text-sm">
        {request.refundStatus ? (
          <RefundStatusBadge status={request.refundStatus} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

const badgeClass =
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";

function RefundRequestStatusBadge({ status }: { status: RefundRequestStatus }) {
  switch (status) {
    case RefundRequestStatus.Approved:
      return (
        <span className={`${badgeClass} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`}>
          Approved
        </span>
      );
    case RefundRequestStatus.Declined:
      return (
        <span className={`${badgeClass} bg-muted text-muted-foreground`}>
          Declined
        </span>
      );
    case RefundRequestStatus.Open:
      return (
        <span className={`${badgeClass} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`}>
          Open
        </span>
      );
  }
}

function RefundStatusBadge({ status }: { status: RefundStatus }) {
  switch (status) {
    case RefundStatus.Pending:
      return (
        <span className={`${badgeClass} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`}>
          Pending
        </span>
      );
    case RefundStatus.Issued:
      return (
        <span className={`${badgeClass} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`}>
          Issued
        </span>
      );
    case RefundStatus.Failed:
      return (
        <span className={`${badgeClass} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300`}>
          Failed
        </span>
      );
  }
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
