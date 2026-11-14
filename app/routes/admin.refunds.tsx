import { AlertTriangle, ReceiptText } from "lucide-react";
import { isRouteErrorResponse, Link } from "react-router";
import type { Route } from "./+types/admin.refunds";
import { requirePlatformAdmin } from "~/lib/access.server";
import {
  listOpenRefundRequests,
  type OpenRefundRequestRow,
} from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

// Admin-only: the loader and every action call requirePlatformAdmin first.
// All refund logic lives in ~/lib/refunds.server; this route only parses
// input and renders.

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);

  return { openRequests: listOpenRefundRequests() };
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { openRequests } = loaderData;

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
    </tr>
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
