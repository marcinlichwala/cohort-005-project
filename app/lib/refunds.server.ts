import { alias } from "drizzle-orm/sqlite-core";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  purchases,
  refundRequests,
  users,
  RefundRequestStatus,
} from "~/db/schema";
import { daysSince } from "~/lib/utils";
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

const resolvers = alias(users, "resolvers");

/**
 * Every Refund Request that has been decided (Approved or Declined), most
 * recently decided first, for the history section.
 */
export function listDecidedRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      declineNote: refundRequests.declineNote,
      requestedAt: refundRequests.requestedAt,
      resolvedAt: refundRequests.resolvedAt,
      resolvedByName: resolvers.name,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(resolvers, eq(refundRequests.resolvedByUserId, resolvers.id))
    .where(ne(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(desc(refundRequests.resolvedAt), desc(refundRequests.id))
    .all();
}

/**
 * The admin screen's two collections: Open Refund Requests still to decide,
 * and decided ones as history.
 */
export function listRefundRequests() {
  return {
    open: listOpenRefundRequests(),
    decided: listDecidedRefundRequests(),
  };
}

/**
 * The Open Refund Request on a purchase, if any. A learner can raise a new
 * Refund Request only while there isn't one, so a Declined request doesn't
 * block asking again.
 */
export function findOpenRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .get();
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

// ─── Decline ───

/**
 * Declines an Open Refund Request: records the admin, the time and the
 * optional Decline Note, and sends the learner the decline email. The
 * learner can raise a new Refund Request afterwards.
 */
export function declineRefundRequest(
  requestId: number,
  adminUserId: number,
  declineNote?: string | null
) {
  const email = db.transaction((tx) => {
    const request = tx
      .select({
        status: refundRequests.status,
        learnerName: users.name,
        learnerEmail: users.email,
        courseTitle: courses.title,
      })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .innerJoin(users, eq(purchases.userId, users.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(refundRequests.id, requestId))
      .get();

    if (!request) {
      throw new RefundRuleError("That Refund Request doesn't exist.");
    }
    if (request.status !== RefundRequestStatus.Open) {
      throw new RefundRuleError(
        `This Refund Request has already been ${request.status}, so it can't be declined.`
      );
    }

    const note = declineNote?.trim() || null;

    tx.update(refundRequests)
      .set({
        status: RefundRequestStatus.Declined,
        declineNote: note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminUserId,
      })
      .where(
        and(
          eq(refundRequests.id, requestId),
          eq(refundRequests.status, RefundRequestStatus.Open)
        )
      )
      .run();

    return buildDeclineEmail({
      learnerName: request.learnerName,
      learnerEmail: request.learnerEmail,
      courseTitle: request.courseTitle,
      declineNote: note,
    });
  });

  logEmail(email);
  return { email };
}

// ─── Emails ───
// Built as plain objects and logged; there is no mail transport yet.

export type Email = { to: string; subject: string; body: string };

function buildDeclineEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  declineNote: string | null;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund request declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We've looked at your refund request for "${input.courseTitle}" and declined it.`,
      ...(input.declineNote
        ? ["", "A note from our team:", input.declineNote]
        : []),
      "",
      "You keep your access to the course. If something has changed, you can raise a new refund request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function logEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
