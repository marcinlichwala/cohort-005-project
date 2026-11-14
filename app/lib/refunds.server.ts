import { asc, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courses,
  purchases,
  refundRequests,
  refunds,
  users,
  RefundRequestStatus,
  RefundStatus,
} from "~/db/schema";
import { daysSince, formatPrice } from "~/lib/utils";
import { getSecondsWatchedInCourse } from "~/lib/watch-time.server";

const SECONDS_PER_HOUR = 60 * 60;

/**
 * The refund module for admins: every admin operation on Refund Requests
 * and Refunds goes through here, so the route stays a thin form parser.
 */

// ─── List ───

export type OpenRefundRequestRow = ReturnType<
  typeof listOpenRefundRequests
>[number];

/**
 * Every Open Refund Request, oldest first, with the facts an admin needs to
 * decide it. Refund Eligibility is not re-checked here (ADR 0001): the
 * numbers are shown so the admin can judge.
 */
export function listOpenRefundRequests() {
  const rows = db
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all();

  return rows.map((row) => ({
    ...row,
    daysSincePurchase: daysSince(row.purchasedAt),
    hoursWatched:
      getSecondsWatchedInCourse(row.learnerId, row.courseId) / SECONDS_PER_HOUR,
  }));
}

export type DecidedRefundRequestRow = ReturnType<
  typeof listDecidedRefundRequests
>[number];

/**
 * Every decided Refund Request (Approved or Declined), most recently decided
 * first, with its Refund if it has one.
 */
export function listDecidedRefundRequests() {
  const decider = alias(users, "decider");
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      decidedAt: refundRequests.resolvedAt,
      decidedByUserId: refundRequests.resolvedByUserId,
      decidedByName: decider.name,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      refundId: refunds.id,
      refundStatus: refunds.status,
      refundAmount: refunds.amount,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(decider, eq(refundRequests.resolvedByUserId, decider.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(ne(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(desc(refundRequests.resolvedAt), desc(refundRequests.id))
    .all();
}

/**
 * Everything the admin Refunds page shows: Open Refund Requests to decide,
 * and decided ones as history.
 */
export function listRefundRequests() {
  return {
    open: listOpenRefundRequests(),
    decided: listDecidedRefundRequests(),
  };
}

// ─── Errors ───

/**
 * A change the refund rules don't allow, such as deciding a Refund Request
 * that isn't Open. The message is written for the admin to read.
 */
export class RefundRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRuleError";
  }
}

// ─── Emails ───
// Built as plain objects and logged to the console, the same way the request
// confirmation is. There is no real email delivery yet.

export type RefundEmail = { to: string; subject: string; body: string };

function logEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

export function buildRefundApprovedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): RefundEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have approved your refund request for "${input.courseTitle}".`,
      `We are sending back ${formatPrice(input.amount)}, the full amount you paid.`,
      "",
      "You keep access to the course until the money has been sent. We will email you again when it is on its way.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

// ─── Approve ───

/**
 * Approves an Open Refund Request and creates its Pending Refund for the full
 * amount paid. Refund Eligibility is deliberately NOT re-checked (ADR 0001):
 * the rules gate asking, and the decision is the admin's.
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminUserId: number
) {
  const result = db.transaction((tx) => {
    const request = tx
      .select({
        id: refundRequests.id,
        status: refundRequests.status,
        amountPaid: purchases.amountPaid,
        learnerName: users.name,
        learnerEmail: users.email,
        courseTitle: courses.title,
      })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .innerJoin(users, eq(purchases.userId, users.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(refundRequests.id, refundRequestId))
      .get();

    if (!request) {
      throw new RefundRuleError("That Refund Request doesn't exist.");
    }

    if (request.status !== RefundRequestStatus.Open) {
      throw new RefundRuleError(
        `This Refund Request has already been ${request.status}.`
      );
    }

    const now = new Date().toISOString();

    tx.update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        resolvedAt: now,
        resolvedByUserId: adminUserId,
      })
      .where(eq(refundRequests.id, refundRequestId))
      .run();

    const refund = tx
      .insert(refunds)
      .values({
        refundRequestId,
        amount: request.amountPaid,
        status: RefundStatus.Pending,
        createdAt: now,
        statusChangedAt: now,
        statusChangedByUserId: adminUserId,
      })
      .returning()
      .get();

    const email = buildRefundApprovedEmail({
      learnerName: request.learnerName,
      learnerEmail: request.learnerEmail,
      courseTitle: request.courseTitle,
      amount: refund.amount,
    });

    return { refund, email };
  });

  logEmail(result.email);
  return result;
}
