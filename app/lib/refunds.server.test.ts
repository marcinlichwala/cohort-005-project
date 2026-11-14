import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  courses,
  CourseStatus,
  lessons,
  modules,
  purchases,
  refundRequests,
  users,
  videoWatchEvents,
  RefundRequestStatus,
  UserRole,
} from "~/db/schema";

// The refund module reads `db` from `~/db` at call time, so a getter lets
// every test run against its own fresh in-memory database with the real
// migrations applied.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { listOpenRefundRequests } from "./refunds.server";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function daysBeforeNow(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

// ─── Fixtures ───
// Each test inserts only the rows it needs. Later operations (approve,
// decline, mark issued, mark failed) reuse these.

type Base = ReturnType<typeof seedBaseData>;

function addLearner(name: string, email: string) {
  return testDb
    .insert(users)
    .values({ name, email, role: UserRole.Student })
    .returning()
    .get();
}

function addPurchase(input: {
  userId: number;
  courseId: number;
  amountPaid: number;
  purchasedDaysAgo: number;
}) {
  return testDb
    .insert(purchases)
    .values({
      userId: input.userId,
      courseId: input.courseId,
      amountPaid: input.amountPaid,
      country: "US",
      createdAt: daysBeforeNow(input.purchasedDaysAgo),
    })
    .returning()
    .get();
}

function addRefundRequest(input: {
  purchaseId: number;
  requestedDaysAgo: number;
  reason?: string;
  status?: RefundRequestStatus;
}) {
  return testDb
    .insert(refundRequests)
    .values({
      purchaseId: input.purchaseId,
      reason: input.reason ?? "The course was not what I expected.",
      status: input.status ?? RefundRequestStatus.Open,
      requestedAt: daysBeforeNow(input.requestedDaysAgo),
    })
    .returning()
    .get();
}

function addCourse(base: Base, title: string) {
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  return testDb
    .insert(courses)
    .values({
      title,
      slug,
      description: `About ${title}`,
      salesCopy: `## ${title}`,
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: CourseStatus.Published,
    })
    .returning()
    .get();
}

function addLesson(courseId: number, title: string) {
  const mod = testDb
    .insert(modules)
    .values({ courseId, title: `${title} module`, position: 1 })
    .returning()
    .get();
  return testDb
    .insert(lessons)
    .values({ moduleId: mod.id, title, position: 1 })
    .returning()
    .get();
}

function addWatchEvent(userId: number, lessonId: number, positionSeconds: number) {
  testDb
    .insert(videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds })
    .run();
}

/** A learner who bought the base course and has an Open Refund Request. */
function addOpenRequest(
  base: Base,
  input: {
    name: string;
    amountPaid?: number;
    purchasedDaysAgo?: number;
    requestedDaysAgo: number;
    reason?: string;
  }
) {
  const learner = addLearner(
    input.name,
    `${input.name.toLowerCase().replace(/\s+/g, ".")}@example.com`
  );
  const purchase = addPurchase({
    userId: learner.id,
    courseId: base.course.id,
    amountPaid: input.amountPaid ?? 7900,
    purchasedDaysAgo: input.purchasedDaysAgo ?? input.requestedDaysAgo + 1,
  });
  const request = addRefundRequest({
    purchaseId: purchase.id,
    requestedDaysAgo: input.requestedDaysAgo,
    reason: input.reason,
  });
  return { learner, purchase, request };
}

describe("refund module for admins", () => {
  let base: Base;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Listing Open Refund Requests ───

  describe("listOpenRefundRequests", () => {
    it("lists Open Refund Requests oldest first, so the longest wait is answered first", () => {
      const newest = addOpenRequest(base, { name: "Nora New", requestedDaysAgo: 1 });
      const oldest = addOpenRequest(base, { name: "Olga Old", requestedDaysAgo: 6 });
      const middle = addOpenRequest(base, { name: "Mia Middle", requestedDaysAgo: 3 });

      const ids = listOpenRefundRequests().map((row) => row.id);

      expect(ids).toEqual([oldest.request.id, middle.request.id, newest.request.id]);
    });

    it("leaves out Refund Requests that have already been decided", () => {
      const open = addOpenRequest(base, { name: "Owen Open", requestedDaysAgo: 2 });
      const approved = addOpenRequest(base, { name: "Ada Approved", requestedDaysAgo: 5 });
      const declined = addOpenRequest(base, { name: "Dan Declined", requestedDaysAgo: 4 });
      testDb
        .update(refundRequests)
        .set({ status: RefundRequestStatus.Approved })
        .where(eq(refundRequests.id, approved.request.id))
        .run();
      testDb
        .update(refundRequests)
        .set({ status: RefundRequestStatus.Declined })
        .where(eq(refundRequests.id, declined.request.id))
        .run();

      const ids = listOpenRefundRequests().map((row) => row.id);

      expect(ids).toEqual([open.request.id]);
    });

    it("shows the facts an admin needs to decide: learner, course, amount paid and the full reason", () => {
      const reason =
        "I bought the wrong course by mistake — I meant to get the advanced one. ".repeat(5).trim();
      addOpenRequest(base, {
        name: "Liam Learner",
        amountPaid: 7900,
        requestedDaysAgo: 4,
        reason,
      });

      const [row] = listOpenRefundRequests();

      expect(row).toMatchObject({
        learnerName: "Liam Learner",
        learnerEmail: "liam.learner@example.com",
        courseTitle: "Test Course",
        amountPaid: 7900,
        reason,
      });
    });

    it("counts whole days since the purchase, not since the request", () => {
      // Bought 9 days ago, asked 4 days ago: the 14-day window is measured
      // from the purchase, so that's the number the admin needs.
      addOpenRequest(base, { name: "Liam Learner", purchasedDaysAgo: 9, requestedDaysAgo: 4 });

      const [row] = listOpenRefundRequests();

      expect(row.daysSincePurchase).toBe(9);
    });

    it("rounds a part-day down, so a purchase 9.9 days ago reads as 9 days", () => {
      addOpenRequest(base, { name: "Liam Learner", purchasedDaysAgo: 9.9, requestedDaysAgo: 2 });

      const [row] = listOpenRefundRequests();

      expect(row.daysSincePurchase).toBe(9);
    });

    it("adds up the furthest point reached in each lesson to get hours watched", () => {
      const { learner } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 2 });
      const intro = addLesson(base.course.id, "Intro");
      const setup = addLesson(base.course.id, "Setup");
      // Rewatching the start of a lesson doesn't add time: only the furthest
      // point counts. Intro: 1800s, Setup: 2700s, total 4500s = 1.25 hours.
      addWatchEvent(learner.id, intro.id, 600);
      addWatchEvent(learner.id, intro.id, 1800);
      addWatchEvent(learner.id, intro.id, 300);
      addWatchEvent(learner.id, setup.id, 2700);

      const [row] = listOpenRefundRequests();

      expect(row.hoursWatched).toBe(1.25);
    });

    it("counts only this learner's watching of this course", () => {
      const { learner } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 2 });
      const lesson = addLesson(base.course.id, "Intro");
      addWatchEvent(learner.id, lesson.id, 900);
      // Someone else watching the same lesson doesn't count…
      addWatchEvent(base.user.id, lesson.id, 7200);
      // …and nor does the learner watching a different course.
      const otherCourse = addCourse(base, "Other Course");
      const otherLesson = addLesson(otherCourse.id, "Elsewhere");
      addWatchEvent(learner.id, otherLesson.id, 3600);

      const [row] = listOpenRefundRequests();

      expect(row.hoursWatched).toBe(0.25);
    });

    it("reports zero hours when the learner hasn't watched anything", () => {
      addLesson(base.course.id, "Intro");
      addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 2 });

      const [row] = listOpenRefundRequests();

      expect(row.hoursWatched).toBe(0);
    });

    it("returns an empty list when there are no Open Refund Requests", () => {
      expect(listOpenRefundRequests()).toEqual([]);
    });
  });
});
