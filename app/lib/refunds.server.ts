import { alias } from "drizzle-orm/sqlite-core";
import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  refundRequests,
  refunds,
  users,
  RefundRequestStatus,
  RefundStatus,
} from "~/db/schema";
import { canChangeRefundStatus } from "~/lib/refund-status";
import { daysSince, formatPrice } from "~/lib/utils";
import { getSecondsWatchedInCourse } from "~/lib/watch-time.server";

export { canChangeRefundStatus };

const SECONDS_PER_HOUR = 60 * 60;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

  return rows.map(withDecisionFacts);
}

/**
 * Adds the numbers an admin judges a Refund Request by: whole days since the
 * purchase, and hours watched (the furthest point reached in each lesson,
 * added up, the same calculation the request route uses).
 */
function withDecisionFacts<
  T extends { learnerId: number; courseId: number; purchasedAt: string },
>(row: T) {
  return {
    ...row,
    daysSincePurchase: daysSince(row.purchasedAt),
    hoursWatched:
      getSecondsWatchedInCourse(row.learnerId, row.courseId) / SECONDS_PER_HOUR,
  };
}

export type DecidedRefundRequestRow = ReturnType<
  typeof listDecidedRefundRequests
>[number];

const resolvers = alias(users, "resolvers");
const refundStatusChangers = alias(users, "refund_status_changers");

/**
 * Every Refund Request that has been decided (Approved or Declined), most
 * recently decided first, for the history section.
 */
export function listDecidedRefundRequests() {
  const rows = db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      declineNote: refundRequests.declineNote,
      requestedAt: refundRequests.requestedAt,
      resolvedAt: refundRequests.resolvedAt,
      resolvedByName: resolvers.name,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      // Null for a Declined Refund Request, which has no Refund.
      refundId: refunds.id,
      refundStatus: refunds.status,
      refundAmount: refunds.amount,
      refundStatusChangedAt: refunds.statusChangedAt,
      refundStatusChangedByName: refundStatusChangers.name,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(resolvers, eq(refundRequests.resolvedByUserId, resolvers.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .leftJoin(
      refundStatusChangers,
      eq(refunds.statusChangedByUserId, refundStatusChangers.id)
    )
    .where(ne(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(desc(refundRequests.resolvedAt), desc(refundRequests.id))
    .all();

  return rows.map(withDecisionFacts);
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

// ─── Learner side ───

export type LearnerRefundRequestRow = ReturnType<
  typeof listLearnerRefundRequests
>[number];

/**
 * A learner's own Refund Requests for their settings page: Open ones first,
 * then decided ones most recently decided first, with the Decline Note and
 * the Refund status where there is one.
 */
export function listLearnerRefundRequests(learnerId: number) {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      resolvedAt: refundRequests.resolvedAt,
      declineNote: refundRequests.declineNote,
      // Null unless the Refund Request is Approved.
      refundStatus: refunds.status,
      refundAmount: refunds.amount,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(purchases.userId, learnerId))
    .orderBy(
      sql`case when ${refundRequests.status} = ${RefundRequestStatus.Open} then 0 else 1 end`,
      desc(refundRequests.resolvedAt),
      desc(refundRequests.requestedAt),
      desc(refundRequests.id)
    )
    .all();
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

/**
 * The Approved Refund Request on a purchase, if any, or any Refund Request
 * that has a Refund. A purchase is refunded at most once, so once one exists
 * nothing more can be asked for or approved on it.
 */
function findApprovedRefundRequest(
  executor: typeof db | Transaction,
  purchaseId: number
) {
  return executor
    .select({ id: refundRequests.id, status: refundRequests.status })
    .from(refundRequests)
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        or(
          eq(refundRequests.status, RefundRequestStatus.Approved),
          isNotNull(refunds.id)
        )
      )
    )
    .get();
}

/**
 * The Refund Request that stops a learner raising a new one on a purchase:
 * an Open one (only one can be undecided at once) or an Approved one (a
 * purchase is refunded at most once). A Declined request doesn't block.
 * The request route and the course page both ask this.
 */
export function findRefundRequestBlockingNewRequest(purchaseId: number) {
  return (
    findOpenRefundRequest(purchaseId) ??
    findApprovedRefundRequest(db, purchaseId)
  );
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

// ─── Approve ───

/**
 * Approves an Open Refund Request: records the admin and the time, creates
 * its Pending Refund for the full amount paid, and sends the learner the
 * approval email. Refund Eligibility is deliberately NOT re-checked
 * (ADR 0001): the rules gate asking, and the decision is the admin's.
 */
export function approveRefundRequest(requestId: number, adminUserId: number) {
  const result = db.transaction((tx) => {
    const request = tx
      .select({
        status: refundRequests.status,
        purchaseId: refundRequests.purchaseId,
        amountPaid: purchases.amountPaid,
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
        `This Refund Request has already been ${request.status}, so it can't be approved.`
      );
    }
    if (findApprovedRefundRequest(tx, request.purchaseId)) {
      throw new RefundRuleError(
        "This purchase already has an Approved Refund Request, so it can't be refunded again."
      );
    }

    const now = new Date().toISOString();

    const { changes } = tx
      .update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        resolvedAt: now,
        resolvedByUserId: adminUserId,
      })
      .where(
        and(
          eq(refundRequests.id, requestId),
          eq(refundRequests.status, RefundRequestStatus.Open)
        )
      )
      .run();
    // The guard above lost a race: another admin decided it first.
    if (changes === 0) {
      throw new RefundRuleError("Another admin has just decided this Refund Request.");
    }

    const refund = tx
      .insert(refunds)
      .values({
        refundRequestId: requestId,
        amount: request.amountPaid,
        status: RefundStatus.Pending,
        createdAt: now,
        statusChangedAt: now,
        statusChangedByUserId: adminUserId,
      })
      .returning()
      .get();

    const email = buildApprovalEmail({
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

    const { changes } = tx
      .update(refundRequests)
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
    // The guard above lost a race: another admin decided it first.
    if (changes === 0) {
      throw new RefundRuleError("Another admin has just decided this Refund Request.");
    }

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

// ─── Mark Issued / Mark Failed ───

/** The facts about a Refund that its status changes and side effects need. */
type RefundContext = {
  refundId: number;
  status: RefundStatus;
  amount: number;
  purchaseId: number;
  learnerId: number;
  learnerName: string;
  learnerEmail: string;
  courseId: number;
  courseTitle: string;
};

function loadRefund(tx: Transaction, refundId: number): RefundContext {
  const refund = tx
    .select({
      refundId: refunds.id,
      status: refunds.status,
      amount: refunds.amount,
      purchaseId: purchases.id,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundId))
    .get();

  if (!refund) throw new RefundRuleError("That Refund doesn't exist.");
  return refund;
}

const REFUND_STATUS_PAST: Record<RefundStatus, string> = {
  [RefundStatus.Pending]: "pending",
  [RefundStatus.Issued]: "been issued",
  [RefundStatus.Failed]: "failed",
};

/**
 * Moves a Refund to a new status, recording the admin and the time, or
 * throws a RefundRuleError if the change isn't allowed.
 */
function changeRefundStatus(
  tx: Transaction,
  refund: RefundContext,
  to: RefundStatus,
  adminUserId: number
) {
  if (!canChangeRefundStatus(refund.status, to)) {
    throw new RefundRuleError(
      `This Refund has already ${REFUND_STATUS_PAST[refund.status]}, so it can't be marked ${to}.`
    );
  }

  const { changes } = tx
    .update(refunds)
    .set({
      status: to,
      statusChangedAt: new Date().toISOString(),
      statusChangedByUserId: adminUserId,
    })
    // Guarding on the status read above means two admins acting at once
    // can't both apply a change.
    .where(and(eq(refunds.id, refund.refundId), eq(refunds.status, refund.status)))
    .run();
  if (changes === 0) {
    throw new RefundRuleError("Another admin has just changed this Refund.");
  }
}

/**
 * Ends the learner's access to the course. Access depends on the
 * enrollment, so deleting it is enough; lesson progress and watch history
 * stay, so buying the course again picks up where they left off.
 */
function endCourseAccess(tx: Transaction, refund: RefundContext) {
  tx.delete(enrollments)
    .where(
      and(
        eq(enrollments.userId, refund.learnerId),
        eq(enrollments.courseId, refund.courseId)
      )
    )
    .run();
}

/**
 * Voids every unclaimed seat coupon from the purchase, so nobody can take a
 * seat that has been refunded. Claimed coupons are left alone: the person
 * who claimed one keeps their seat.
 */
function voidUnclaimedSeats(tx: Transaction, refund: RefundContext) {
  tx.update(coupons)
    .set({ voidedAt: new Date().toISOString() })
    .where(
      and(
        eq(coupons.purchaseId, refund.purchaseId),
        isNull(coupons.redeemedByUserId),
        isNull(coupons.voidedAt)
      )
    )
    .run();
}

/**
 * Marks a Refund Issued: the admin has confirmed the money was sent.
 * Everything that follows from it happens in the same transaction.
 */
export function markRefundIssued(refundId: number, adminUserId: number) {
  const email = db.transaction((tx) => {
    const refund = loadRefund(tx, refundId);
    changeRefundStatus(tx, refund, RefundStatus.Issued, adminUserId);
    // Side effects of an Issued Refund, in the same transaction.
    endCourseAccess(tx, refund);
    voidUnclaimedSeats(tx, refund);
    return buildIssuedEmail(refund);
  });

  logEmail(email);
  return { email };
}

/**
 * Marks a Refund Failed: the money couldn't be sent and the team will
 * retry. No email goes out, and the learner keeps access.
 */
export function markRefundFailed(refundId: number, adminUserId: number) {
  db.transaction((tx) => {
    const refund = loadRefund(tx, refundId);
    changeRefundStatus(tx, refund, RefundStatus.Failed, adminUserId);
  });
}

// ─── Emails ───
// Built as plain objects and logged; there is no mail transport yet.

export type Email = { to: string; subject: string; body: string };

function buildApprovalEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): Email {
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

function buildIssuedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Your refund is on its way — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `Good news: your money is on its way. We have sent back ${formatPrice(input.amount)} for "${input.courseTitle}".`,
      "Depending on your bank, it can take a few days to reach your account.",
      "",
      "Your access to the course has ended. Your progress is saved, so if you buy the course again you can pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function logEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
