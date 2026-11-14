import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refundRequests,
  teams,
  users,
  videoWatchEvents,
  RefundRequestStatus,
  RefundStatus,
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

import {
  approveRefundRequest,
  canChangeRefundStatus,
  declineRefundRequest,
  findOpenRefundRequest,
  findRefundRequestBlockingNewRequest,
  listLearnerRefundRequests,
  listOpenRefundRequests,
  listRefundRequests,
  markRefundFailed,
  markRefundIssued,
  RefundRuleError,
} from "./refunds.server";

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

function addAdmin(name = "Alex Admin") {
  return testDb
    .insert(users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      role: UserRole.Admin,
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

/**
 * Makes every UPDATE on a table change nothing, the way it would if another
 * admin had changed the row between our read and our status-guarded write.
 */
function makeUpdatesChangeNothing(table: "refund_requests" | "refunds") {
  testDb.run(
    sql.raw(
      `CREATE TRIGGER lost_race_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`
    )
  );
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

  // ─── Listing for the admin screen ───

  describe("listRefundRequests", () => {
    it("returns Open requests and decided requests as separate collections, most recently decided first", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const admin = addAdmin();
      const open = addOpenRequest(base, { name: "Owen Open", requestedDaysAgo: 5 });
      const declinedEarlier = addOpenRequest(base, { name: "Dana Early", requestedDaysAgo: 4 });
      const declinedLater = addOpenRequest(base, { name: "Dina Late", requestedDaysAgo: 3 });
      declineRefundRequest(declinedEarlier.request.id, admin.id);
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      declineRefundRequest(declinedLater.request.id, admin.id);

      const { open: openRows, decided } = listRefundRequests();

      expect(openRows.map((row) => row.id)).toEqual([open.request.id]);
      expect(decided.map((row) => row.id)).toEqual([
        declinedLater.request.id,
        declinedEarlier.request.id,
      ]);
    });
    it("reports days since purchase and hours watched on decided requests too", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const admin = addAdmin();
      const { learner, request } = addOpenRequest(base, {
        name: "Liam Learner",
        purchasedDaysAgo: 9,
        requestedDaysAgo: 4,
      });
      const lesson = addLesson(base.course.id, "Intro");
      addWatchEvent(learner.id, lesson.id, 2700);
      approveRefundRequest(request.id, admin.id);

      const [row] = listRefundRequests().decided;

      expect(row).toMatchObject({ daysSincePurchase: 9, hoursWatched: 0.75 });
    });
  });

  // ─── Declining a Refund Request ───

  describe("declineRefundRequest", () => {
    // The decline email goes to the console log; keep test output quiet.
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("moves a declined request out of Open and into the history, with the admin, the time and the Decline Note", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });

      declineRefundRequest(request.id, admin.id, "You have watched most of the course.");

      const { open, decided } = listRefundRequests();
      expect(open).toEqual([]);
      expect(decided).toHaveLength(1);
      expect(decided[0]).toMatchObject({
        id: request.id,
        status: RefundRequestStatus.Declined,
        declineNote: "You have watched most of the course.",
        resolvedAt: NOW.toISOString(),
        resolvedByName: "Alex Admin",
        learnerName: "Liam Learner",
      });
    });

    it("builds a decline email to the learner that includes the Decline Note", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });

      const { email } = declineRefundRequest(
        request.id,
        admin.id,
        "You have watched most of the course."
      );

      expect(email.to).toBe("liam.learner@example.com");
      expect(email.subject).toBe("Refund request declined — Test Course");
      expect(email.body).toContain("Hi Liam Learner,");
      expect(email.body).toContain("You have watched most of the course.");
    });

    it("declines without a note: nothing is stored and the email has no note section", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });

      const { email } = declineRefundRequest(request.id, admin.id);

      const [row] = listRefundRequests().decided;
      expect(row.status).toBe(RefundRequestStatus.Declined);
      expect(row.declineNote).toBeNull();
      expect(email.body).not.toContain("A note from our team");
    });

    it("treats a blank note as no note, so the learner isn't shown an empty one", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });

      const { email } = declineRefundRequest(request.id, admin.id, "   ");

      expect(listRefundRequests().decided[0].declineNote).toBeNull();
      expect(email.body).not.toContain("A note from our team");
    });

    it("rejects declining a request that has already been decided, and leaves it as it was", () => {
      // Two admins on the same screen: the second one must get a clear
      // message, not silently overwrite the first decision.
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });
      declineRefundRequest(request.id, admin.id, "First decision.");

      expect(() => declineRefundRequest(request.id, admin.id, "Second decision.")).toThrow(
        "This Refund Request has already been declined, so it can't be declined."
      );
      expect(listRefundRequests().decided[0].declineNote).toBe("First decision.");
    });

    it("rejects declining an Approved Refund Request", () => {
      const admin = addAdmin();
      const { purchase } = addOpenRequest(base, { name: "Ada Approved", requestedDaysAgo: 3 });
      const approved = addRefundRequest({
        purchaseId: purchase.id,
        requestedDaysAgo: 2,
        status: RefundRequestStatus.Approved,
      });

      expect(() => declineRefundRequest(approved.id, admin.id)).toThrow(
        "This Refund Request has already been approved, so it can't be declined."
      );
    });

    it("rejects the decline when the guarded update changes nothing", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });
      makeUpdatesChangeNothing("refund_requests");

      expect(() => declineRefundRequest(request.id, admin.id, "Too late.")).toThrow(
        new RefundRuleError("Another admin has just decided this Refund Request.")
      );
    });

    it("lets the learner raise a new Refund Request for the same purchase after a decline", () => {
      const admin = addAdmin();
      const { request, purchase } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });
      expect(findOpenRefundRequest(purchase.id)?.id).toBe(request.id);

      declineRefundRequest(request.id, admin.id);

      // The request route refuses a new request only while one is Open.
      expect(findOpenRefundRequest(purchase.id)).toBeUndefined();
    });
  });

  // ─── Whether a learner may raise a new Refund Request ───

  describe("findRefundRequestBlockingNewRequest", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("blocks a new request while one is Open", () => {
      const { purchase, request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });

      expect(findRefundRequestBlockingNewRequest(purchase.id)).toMatchObject({
        id: request.id,
        status: RefundRequestStatus.Open,
      });
    });

    it("blocks a new request once one is Approved, so a purchase can't be refunded twice", () => {
      const admin = addAdmin();
      const { purchase, request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });
      approveRefundRequest(request.id, admin.id);

      expect(findRefundRequestBlockingNewRequest(purchase.id)).toMatchObject({
        id: request.id,
        status: RefundRequestStatus.Approved,
      });
    });

    it("doesn't block after a decline: the learner may ask again", () => {
      const admin = addAdmin();
      const { purchase, request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 3 });
      declineRefundRequest(request.id, admin.id);

      expect(findRefundRequestBlockingNewRequest(purchase.id)).toBeUndefined();
    });

    it("doesn't block a purchase with no Refund Requests", () => {
      const learner = addLearner("Nina New", "nina@example.com");
      const purchase = addPurchase({
        userId: learner.id,
        courseId: base.course.id,
        amountPaid: 7900,
        purchasedDaysAgo: 2,
      });

      expect(findRefundRequestBlockingNewRequest(purchase.id)).toBeUndefined();
    });
  });

  // ─── The learner's own Refund Requests (settings page) ───

  describe("listLearnerRefundRequests", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("lists the learner's Open requests first, then decided ones most recent first, with the Decline Note and Refund status", () => {
      const admin = addAdmin();
      const learner = addLearner("Liam Learner", "liam@example.com");
      const buy = (title: string) =>
        addPurchase({
          userId: learner.id,
          courseId: addCourse(base, title).id,
          amountPaid: 4900,
          purchasedDaysAgo: 5,
        });
      const declined = addRefundRequest({ purchaseId: buy("Declined Course").id, requestedDaysAgo: 4 });
      const approved = addRefundRequest({ purchaseId: buy("Approved Course").id, requestedDaysAgo: 3 });
      const open = addRefundRequest({ purchaseId: buy("Open Course").id, requestedDaysAgo: 2 });
      declineRefundRequest(declined.id, admin.id, "You have watched most of it.");
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      const { refund } = approveRefundRequest(approved.id, admin.id);
      markRefundFailed(refund.id, admin.id);

      const rows = listLearnerRefundRequests(learner.id);

      expect(rows).toEqual([
        expect.objectContaining({
          id: open.id,
          status: RefundRequestStatus.Open,
          courseTitle: "Open Course",
          amountPaid: 4900,
          refundStatus: null,
        }),
        expect.objectContaining({
          id: approved.id,
          status: RefundRequestStatus.Approved,
          courseTitle: "Approved Course",
          refundStatus: RefundStatus.Failed,
          refundAmount: 4900,
        }),
        expect.objectContaining({
          id: declined.id,
          status: RefundRequestStatus.Declined,
          courseTitle: "Declined Course",
          declineNote: "You have watched most of it.",
          refundStatus: null,
        }),
      ]);
    });

    it("leaves out other learners' Refund Requests", () => {
      addOpenRequest(base, { name: "Someone Else", requestedDaysAgo: 2 });
      const learner = addLearner("Liam Learner", "liam@example.com");

      expect(listLearnerRefundRequests(learner.id)).toEqual([]);
    });
  });

  // ─── Approving ───

  describe("approveRefundRequest", () => {
    // The approval email goes to the console log; keep test output quiet.
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("turns an Open Refund Request into an Approved one with a Pending Refund for the full amount paid", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, {
        name: "Liam Learner",
        amountPaid: 7900,
        requestedDaysAgo: 4,
      });

      approveRefundRequest(request.id, admin.id);

      const { open, decided } = listRefundRequests();
      expect(open).toEqual([]);
      expect(decided).toHaveLength(1);
      expect(decided[0]).toMatchObject({
        id: request.id,
        status: RefundRequestStatus.Approved,
        refundStatus: RefundStatus.Pending,
        refundAmount: 7900,
      });
    });
    it("records which admin approved it and when, for the audit trail", () => {
      const admin = addAdmin("Alex Rivera");
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 4 });

      approveRefundRequest(request.id, admin.id);

      const [row] = listRefundRequests().decided;
      expect(row).toMatchObject({
        resolvedAt: NOW.toISOString(),
        resolvedByName: "Alex Rivera",
      });
    });
    it("approves even when the learner is now past the 14-day window and over 2 hours watched (ADR 0001)", () => {
      // Eligibility gates asking, not approving. By the time the admin gets
      // to this request the learner is on day 30 with 3 hours watched, and
      // the admin may still approve.
      const admin = addAdmin();
      const { learner, request } = addOpenRequest(base, {
        name: "Late Larry",
        amountPaid: 4900,
        purchasedDaysAgo: 30,
        requestedDaysAgo: 20,
      });
      const lesson = addLesson(base.course.id, "Long lesson");
      addWatchEvent(learner.id, lesson.id, 3 * 60 * 60);

      approveRefundRequest(request.id, admin.id);

      const [row] = listRefundRequests().decided;
      expect(row).toMatchObject({
        status: RefundRequestStatus.Approved,
        refundStatus: RefundStatus.Pending,
        refundAmount: 4900,
      });
    });
    it("rejects approving a request another admin has already approved, and creates no second Refund", () => {
      const first = addAdmin("First Admin");
      const second = addAdmin("Second Admin");
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 4 });
      approveRefundRequest(request.id, first.id);

      expect(() => approveRefundRequest(request.id, second.id)).toThrow(
        new RefundRuleError("This Refund Request has already been approved, so it can't be approved.")
      );

      const { decided } = listRefundRequests();
      expect(decided).toHaveLength(1);
      expect(decided[0].resolvedByName).toBe("First Admin");
    });

    it("rejects approving a Declined Refund Request", () => {
      const admin = addAdmin();
      const learner = addLearner("Dan Declined", "dan@example.com");
      const purchase = addPurchase({
        userId: learner.id,
        courseId: base.course.id,
        amountPaid: 7900,
        purchasedDaysAgo: 5,
      });
      const request = addRefundRequest({
        purchaseId: purchase.id,
        requestedDaysAgo: 3,
        status: RefundRequestStatus.Declined,
      });

      expect(() => approveRefundRequest(request.id, admin.id)).toThrow(
        new RefundRuleError("This Refund Request has already been declined, so it can't be approved.")
      );

      const [row] = listRefundRequests().decided;
      expect(row.status).toBe(RefundRequestStatus.Declined);
      expect(row.refundStatus).toBeNull();
    });
    it("rejects approving a second Refund Request on a purchase that already has an Approved one, and creates no second Refund", () => {
      // A purchase is refunded at most once: a second Open request on the
      // same purchase (raised before the route refused it) can't be approved.
      const admin = addAdmin();
      const { purchase, request: first } = addOpenRequest(base, {
        name: "Liam Learner",
        requestedDaysAgo: 4,
      });
      approveRefundRequest(first.id, admin.id);
      const second = addRefundRequest({ purchaseId: purchase.id, requestedDaysAgo: 1 });

      expect(() => approveRefundRequest(second.id, admin.id)).toThrow(
        new RefundRuleError(
          "This purchase already has an Approved Refund Request, so it can't be refunded again."
        )
      );

      const { open, decided } = listRefundRequests();
      expect(open.map((row) => row.id)).toEqual([second.id]);
      expect(decided.filter((row) => row.refundId !== null)).toHaveLength(1);
    });

    it("rejects the approval and creates no Refund when the guarded update changes nothing", () => {
      // Another admin decided the request between our read and our write.
      const admin = addAdmin();
      const { request } = addOpenRequest(base, { name: "Liam Learner", requestedDaysAgo: 4 });
      makeUpdatesChangeNothing("refund_requests");

      expect(() => approveRefundRequest(request.id, admin.id)).toThrow(
        new RefundRuleError("Another admin has just decided this Refund Request.")
      );
      expect(listRefundRequests().decided).toEqual([]);
    });

    it("builds an approval email to the learner saying how much is coming back", () => {
      const admin = addAdmin();
      const { request } = addOpenRequest(base, {
        name: "Liam Learner",
        amountPaid: 7900,
        requestedDaysAgo: 4,
      });

      const { email } = approveRefundRequest(request.id, admin.id);

      expect(email.to).toBe("liam.learner@example.com");
      expect(email.subject).toBe("Refund approved — Test Course");
      expect(email.body).toContain("Hi Liam Learner,");
      expect(email.body).toContain('We have approved your refund request for "Test Course".');
      expect(email.body).toContain("$79.00");
    });
  });

  // ─── Marking a Refund Issued or Failed ───

  describe("markRefundIssued and markRefundFailed", () => {
    // Emails go to the console log; keep test output quiet.
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    /** An enrolled learner whose Refund Request was approved: a Pending Refund. */
    function addPendingRefund(name = "Liam Learner") {
      const approver = addAdmin("Approving Admin");
      const open = addOpenRequest(base, { name, amountPaid: 7900, requestedDaysAgo: 4 });
      testDb
        .insert(enrollments)
        .values({ userId: open.learner.id, courseId: base.course.id })
        .run();
      const { refund } = approveRefundRequest(open.request.id, approver.id);
      return { ...open, refund };
    }

    function refundRow(requestId: number) {
      const row = listRefundRequests().decided.find((r) => r.id === requestId);
      if (!row) throw new Error(`No decided Refund Request ${requestId}`);
      return row;
    }

    it("marks a Pending Refund Issued and records which admin did it and when", () => {
      const { request, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      markRefundIssued(refund.id, admin.id);

      expect(refundRow(request.id)).toMatchObject({
        refundStatus: RefundStatus.Issued,
        refundStatusChangedAt: new Date(NOW.getTime() + 60_000).toISOString(),
        refundStatusChangedByName: "Alex Rivera",
      });
    });

    function enrollmentFor(userId: number) {
      return testDb.select().from(enrollments).where(eq(enrollments.userId, userId)).all();
    }

    it("ends course access by deleting the enrollment, but keeps lesson progress and watch history", () => {
      // Buying the course again should pick up where the learner left off.
      const { learner, refund } = addPendingRefund();
      const lesson = addLesson(base.course.id, "Intro");
      testDb
        .insert(lessonProgress)
        .values({ userId: learner.id, lessonId: lesson.id, status: LessonProgressStatus.Completed })
        .run();
      addWatchEvent(learner.id, lesson.id, 1800);
      const admin = addAdmin("Alex Rivera");

      markRefundIssued(refund.id, admin.id);

      expect(enrollmentFor(learner.id)).toEqual([]);
      expect(
        testDb.select().from(lessonProgress).where(eq(lessonProgress.userId, learner.id)).all()
      ).toHaveLength(1);
      expect(
        testDb.select().from(videoWatchEvents).where(eq(videoWatchEvents.userId, learner.id)).all()
      ).toHaveLength(1);
    });

    it("leaves the learner's enrollments in other courses alone", () => {
      const { learner, refund } = addPendingRefund();
      const otherCourse = addCourse(base, "Other Course");
      testDb.insert(enrollments).values({ userId: learner.id, courseId: otherCourse.id }).run();
      const admin = addAdmin("Alex Rivera");

      markRefundIssued(refund.id, admin.id);

      expect(enrollmentFor(learner.id).map((e) => e.courseId)).toEqual([otherCourse.id]);
    });

    it("builds a \"your money is on its way\" email to the learner", () => {
      const { refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");

      const { email } = markRefundIssued(refund.id, admin.id);

      expect(email.to).toBe("liam.learner@example.com");
      expect(email.subject).toBe("Your refund is on its way — Test Course");
      expect(email.body).toContain("Hi Liam Learner,");
      expect(email.body).toContain("$79.00");
      expect(email.body).toContain("your money is on its way");
    });

    // ─── Team seats on an Issued Refund ───

    /** Seat coupons on a purchase; pass a user id to make a seat claimed. */
    function addCoupons(purchaseId: number, claimedBy: (number | null)[]) {
      const team = testDb.insert(teams).values({}).returning().get();
      return claimedBy.map((userId, i) =>
        testDb
          .insert(coupons)
          .values({
            teamId: team.id,
            courseId: base.course.id,
            code: `SEAT-${purchaseId}-${i}`,
            purchaseId,
            redeemedByUserId: userId,
            redeemedAt: userId === null ? null : daysBeforeNow(1),
          })
          .returning()
          .get()
      );
    }

    function couponById(id: number) {
      const coupon = testDb.select().from(coupons).where(eq(coupons.id, id)).get();
      if (!coupon) throw new Error(`No coupon ${id}`);
      return coupon;
    }

    it("voids every unclaimed seat coupon from the purchase, so nobody can take a refunded seat", () => {
      const { purchase, refund } = addPendingRefund();
      const seats = addCoupons(purchase.id, [null, null]);
      const admin = addAdmin("Alex Rivera");
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      markRefundIssued(refund.id, admin.id);

      for (const seat of seats) {
        expect(couponById(seat.id).voidedAt).toBe(
          new Date(NOW.getTime() + 60_000).toISOString()
        );
      }
    });

    it("leaves claimed seat coupons alone: the person who claimed it keeps their seat", () => {
      const { purchase, refund } = addPendingRefund();
      const colleague = addLearner("Cara Colleague", "cara@example.com");
      const [claimed, unclaimed] = addCoupons(purchase.id, [colleague.id, null]);
      const admin = addAdmin("Alex Rivera");

      markRefundIssued(refund.id, admin.id);

      expect(couponById(claimed.id).voidedAt).toBeNull();
      expect(couponById(unclaimed.id).voidedAt).not.toBeNull();
    });

    it("leaves seat coupons from other purchases alone", () => {
      const { refund } = addPendingRefund();
      const other = addOpenRequest(base, { name: "Olive Other", requestedDaysAgo: 2 });
      const [otherSeat] = addCoupons(other.purchase.id, [null]);
      const admin = addAdmin("Alex Rivera");

      markRefundIssued(refund.id, admin.id);

      expect(couponById(otherSeat.id).voidedAt).toBeNull();
    });

    it("doesn't void seats when a Refund is marked Failed: the refund hasn't happened yet", () => {
      const { purchase, refund } = addPendingRefund();
      const [seat] = addCoupons(purchase.id, [null]);
      const admin = addAdmin("Alex Rivera");

      markRefundFailed(refund.id, admin.id);

      expect(couponById(seat.id).voidedAt).toBeNull();
    });

    it("marks a Pending Refund Failed and records which admin did it and when", () => {
      const { request, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      markRefundFailed(refund.id, admin.id);

      expect(refundRow(request.id)).toMatchObject({
        // The decision hasn't changed: the request stays Approved.
        status: RefundRequestStatus.Approved,
        refundStatus: RefundStatus.Failed,
        refundStatusChangedAt: new Date(NOW.getTime() + 60_000).toISOString(),
        refundStatusChangedByName: "Alex Rivera",
      });
    });

    it("sends no email when a Refund is marked Failed, and the learner keeps access", () => {
      // The team is already retrying; telling the learner would only alarm them.
      const { learner, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      // Approving logged its own email; only what happens from here counts.
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      log.mockClear();

      markRefundFailed(refund.id, admin.id);

      expect(log).not.toHaveBeenCalled();
      expect(enrollmentFor(learner.id)).toHaveLength(1);
    });

    it("marks a Failed Refund Issued after a successful retry, with the same side effects", () => {
      const { learner, request, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      markRefundFailed(refund.id, admin.id);

      const { email } = markRefundIssued(refund.id, admin.id);

      expect(refundRow(request.id).refundStatus).toBe(RefundStatus.Issued);
      expect(enrollmentFor(learner.id)).toEqual([]);
      expect(email.subject).toBe("Your refund is on its way — Test Course");
    });

    it("rejects marking an Issued Refund Issued again, because Issued is final", () => {
      const { refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      markRefundIssued(refund.id, admin.id);

      expect(() => markRefundIssued(refund.id, admin.id)).toThrow(
        new RefundRuleError("This Refund has already been issued, so it can't be marked issued.")
      );
    });

    it("rejects marking an Issued Refund Failed, and leaves it Issued with the original audit trail", () => {
      const { request, refund } = addPendingRefund();
      const first = addAdmin("First Admin");
      const second = addAdmin("Second Admin");
      markRefundIssued(refund.id, first.id);

      expect(() => markRefundFailed(refund.id, second.id)).toThrow(
        new RefundRuleError("This Refund has already been issued, so it can't be marked failed.")
      );
      expect(refundRow(request.id)).toMatchObject({
        refundStatus: RefundStatus.Issued,
        refundStatusChangedByName: "First Admin",
      });
    });

    it("rejects marking a Failed Refund Failed again", () => {
      const { refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      markRefundFailed(refund.id, admin.id);

      expect(() => markRefundFailed(refund.id, admin.id)).toThrow(
        new RefundRuleError("This Refund has already failed, so it can't be marked failed.")
      );
    });

    it("rejects the status change, and runs no side effects, when the guarded update changes nothing", () => {
      // Another admin changed the Refund between our read and our write.
      const { learner, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      makeUpdatesChangeNothing("refunds");

      expect(() => markRefundIssued(refund.id, admin.id)).toThrow(
        new RefundRuleError("Another admin has just changed this Refund.")
      );
      expect(enrollmentFor(learner.id)).toHaveLength(1);
    });

    it("tells the screen which Refund status changes are allowed: Issued is final, Failed can still be Issued", () => {
      expect(canChangeRefundStatus(RefundStatus.Pending, RefundStatus.Issued)).toBe(true);
      expect(canChangeRefundStatus(RefundStatus.Pending, RefundStatus.Failed)).toBe(true);
      expect(canChangeRefundStatus(RefundStatus.Failed, RefundStatus.Issued)).toBe(true);
      expect(canChangeRefundStatus(RefundStatus.Failed, RefundStatus.Failed)).toBe(false);
      expect(canChangeRefundStatus(RefundStatus.Issued, RefundStatus.Failed)).toBe(false);
      expect(canChangeRefundStatus(RefundStatus.Issued, RefundStatus.Issued)).toBe(false);
    });

    it("rejects a Refund that doesn't exist", () => {
      const admin = addAdmin("Alex Rivera");

      expect(() => markRefundIssued(999, admin.id)).toThrow(
        new RefundRuleError("That Refund doesn't exist.")
      );
    });

    it("rolls back a rejected change: a second Issued doesn't re-run its side effects", () => {
      // The learner bought the course again after the first Issued Refund.
      const { learner, refund } = addPendingRefund();
      const admin = addAdmin("Alex Rivera");
      markRefundIssued(refund.id, admin.id);
      testDb.insert(enrollments).values({ userId: learner.id, courseId: base.course.id }).run();

      expect(() => markRefundIssued(refund.id, admin.id)).toThrow(RefundRuleError);
      expect(enrollmentFor(learner.id)).toHaveLength(1);
    });
  });
});
