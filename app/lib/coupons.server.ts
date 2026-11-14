import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { coupons, enrollments, purchases } from "~/db/schema";

/**
 * Team seat coupons: looking them up and redeeming one for a seat.
 */

export function getCouponByCode(code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

export function isUserEnrolled(userId: number, courseId: number) {
  const existing = db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();

  return !!existing;
}

/** Shown when an Issued Refund on the team purchase voided the seat. */
export const VOIDED_COUPON_MESSAGE =
  "This seat no longer exists: the team purchase was refunded.";

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

export function redeemCoupon(
  code: string,
  userId: number,
  userCountry: string
): RedeemResult {
  const coupon = getCouponByCode(code);
  if (!coupon) {
    return { ok: false, error: "Coupon not found" };
  }

  if (coupon.voidedAt !== null) {
    return { ok: false, error: VOIDED_COUPON_MESSAGE };
  }

  if (coupon.redeemedByUserId !== null) {
    return { ok: false, error: "Coupon has already been redeemed" };
  }

  if (isUserEnrolled(userId, coupon.courseId)) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    };
  }

  db.update(coupons)
    .set({
      redeemedByUserId: userId,
      redeemedAt: new Date().toISOString(),
    })
    .where(eq(coupons.id, coupon.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId: coupon.courseId })
    .returning()
    .get();

  return { ok: true, enrollment };
}
