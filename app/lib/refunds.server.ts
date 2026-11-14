import { asc, eq } from "drizzle-orm";
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
