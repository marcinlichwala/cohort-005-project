import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import { coupons, enrollments, purchases, teams, users, UserRole } from "~/db/schema";

// The coupon module reads `db` from `~/db` at call time, so a getter lets
// every test run against its own fresh in-memory database with the real
// migrations applied.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { redeemCoupon } from "./coupons.server";

// ─── Fixtures ───

type Base = ReturnType<typeof seedBaseData>;

/** A team purchase of the base course with one unclaimed seat coupon. */
function addSeat(base: Base, input: { voidedAt?: string } = {}) {
  const buyer = testDb
    .insert(users)
    .values({ name: "Bea Buyer", email: "bea@example.com", role: UserRole.Student })
    .returning()
    .get();
  const purchase = testDb
    .insert(purchases)
    .values({ userId: buyer.id, courseId: base.course.id, amountPaid: 39500, country: "US" })
    .returning()
    .get();
  const team = testDb.insert(teams).values({}).returning().get();
  return testDb
    .insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: "TEAM-SEAT-1",
      purchaseId: purchase.id,
      voidedAt: input.voidedAt ?? null,
    })
    .returning()
    .get();
}

describe("redeemCoupon", () => {
  let base: Base;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  function enrollmentsFor(userId: number) {
    return testDb.select().from(enrollments).where(eq(enrollments.userId, userId)).all();
  }

  it("enrolls the learner and claims the seat when the coupon is unclaimed", () => {
    const seat = addSeat(base);

    const result = redeemCoupon(seat.code, base.user.id, "US");

    expect(result.ok).toBe(true);
    expect(enrollmentsFor(base.user.id).map((e) => e.courseId)).toEqual([base.course.id]);
  });

  it("refuses a voided coupon with a clear message, because the seat was refunded", () => {
    const seat = addSeat(base, { voidedAt: "2026-06-15T12:00:00.000Z" });

    const result = redeemCoupon(seat.code, base.user.id, "US");

    expect(result).toEqual({
      ok: false,
      error: "This seat no longer exists: the team purchase was refunded.",
    });
    // Nothing changes: no enrollment, and the seat stays unclaimed.
    expect(enrollmentsFor(base.user.id)).toEqual([]);
    expect(
      testDb.select().from(coupons).where(eq(coupons.id, seat.id)).get()?.redeemedByUserId
    ).toBeNull();
  });

  it("refuses a coupon that doesn't exist", () => {
    expect(redeemCoupon("NOPE", base.user.id, "US")).toEqual({
      ok: false,
      error: "Coupon not found",
    });
  });
});
