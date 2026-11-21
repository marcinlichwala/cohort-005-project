import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { CourseStatus, LessonProgressStatus, UserRole } from "~/db/schema";
import { markdown } from "~/lib/text";
import {
  getInstructorAnalytics,
  type AnalyticsOptions,
} from "../index.server";

// Tests run with TZ=UTC (vitest.config.ts), so calendar days are UTC days.
const NOW = new Date("2026-03-15T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

/** An ISO timestamp `days` whole days before NOW. */
function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/**
 * Always injects the test database and the fixed clock: a test that forgot
 * them would silently read data.db and the real date.
 */
function analyticsFor(
  overrides: Partial<Omit<AnalyticsOptions, "db" | "now">> = {}
) {
  return getInstructorAnalytics({
    viewer: { userId: base.instructor.id, isAdmin: false },
    range: "30d",
    ...overrides,
    db,
    now: NOW,
  });
}

function addUser(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name}@example.com`, role })
    .returning()
    .get();
}

function addCourse(
  slug: string,
  instructorId: number,
  status = CourseStatus.Published
) {
  return db
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: slug,
      salesCopy: markdown(slug),
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function buy(
  courseId: number,
  amountPaid: number,
  createdAt: string,
  userId = base.user.id
) {
  db.insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt })
    .run();
}

function addLesson(courseId: number, position = 1) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: `Lesson ${position}`, position })
    .returning()
    .get();
}

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

describe("deciding whose figures the viewer sees", () => {
  it("pins an instructor to their own figures even if they ask for another's", () => {
    const rival = addUser("rival", UserRole.Instructor);
    const rivalCourse = addCourse("rival-course", rival.id);
    buy(base.course.id, 1000, daysAgo(1));
    buy(rivalCourse.id, 9000, daysAgo(1));

    const analytics = analyticsFor({ instructorId: rival.id });

    expect(analytics.instructorId).toBe(base.instructor.id);
    expect(analytics.summary.grossCents).toBe(1000);
  });

  it("lets an admin see every instructor at once", () => {
    const admin = addUser("admin", UserRole.Admin);
    const rival = addUser("rival", UserRole.Instructor);
    buy(base.course.id, 1000, daysAgo(1));
    buy(addCourse("rival-course", rival.id).id, 9000, daysAgo(1));

    const analytics = analyticsFor({
      viewer: { userId: admin.id, isAdmin: true },
    });

    expect(analytics.instructorId).toBeNull();
    expect(analytics.summary.grossCents).toBe(10000);
    expect(analytics.instructors.map((i) => i.id).sort()).toEqual(
      [base.instructor.id, rival.id].sort()
    );
  });

  it("lets an admin narrow to one instructor", () => {
    const admin = addUser("admin", UserRole.Admin);
    const rival = addUser("rival", UserRole.Instructor);
    buy(base.course.id, 1000, daysAgo(1));
    buy(addCourse("rival-course", rival.id).id, 9000, daysAgo(1));

    const analytics = analyticsFor({
      viewer: { userId: admin.id, isAdmin: true },
      instructorId: rival.id,
    });

    expect(analytics.summary.grossCents).toBe(9000);
  });

  it("refuses another instructor's course panels", () => {
    const rival = addUser("rival", UserRole.Instructor);
    const rivalCourse = addCourse("rival-course", rival.id);

    const analytics = analyticsFor({ courseId: rivalCourse.id });

    expect(analytics.selectedCourseId).toBeNull();
    expect(analytics.funnel).toBeNull();
    expect(analytics.progress).toBeNull();
    expect(analytics.quizzes).toBeNull();
    expect(analytics.countries).toBeNull();
  });

  it("shows the course panels for a course the instructor owns", () => {
    addLesson(base.course.id);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    const analytics = analyticsFor({ courseId: base.course.id });

    expect(analytics.selectedCourseId).toBe(base.course.id);
    expect(analytics.funnel?.enrolledCount).toBe(1);
    expect(analytics.progress?.totalLessons).toBe(1);
  });

  it("prompts an instructor with nothing published to publish", () => {
    const newcomer = addUser("newcomer", UserRole.Instructor);
    addCourse("draft", newcomer.id, CourseStatus.Draft);

    const analytics = analyticsFor({
      viewer: { userId: newcomer.id, isAdmin: false },
    });

    expect(analytics.unpublished).toBe(true);
    expect(analyticsFor().unpublished).toBe(false);
  });
});

describe("the range, counted back from now", () => {
  it("includes a sale inside the window and leaves out one before it", () => {
    buy(base.course.id, 1000, daysAgo(29));
    buy(base.course.id, 5000, daysAgo(31));

    expect(analyticsFor({ range: "30d" }).summary.grossCents).toBe(1000);
    expect(analyticsFor({ range: "all" }).summary.grossCents).toBe(6000);
  });

  it("draws every day of the window, ending today, even with no sales", () => {
    const { series } = analyticsFor({ range: "30d" });

    expect(series.granularity).toBe("day");
    expect(series.points).toHaveLength(31);
    expect(series.points[0].bucket).toBe("2026-02-13");
    expect(series.points.at(-1)?.bucket).toBe("2026-03-15");
    expect(series.points.every((p) => p.grossCents === 0)).toBe(true);
  });

  it("counts a question older than the range separately rather than dropping it", () => {
    const lesson = addLesson(base.course.id);
    for (const createdAt of [daysAgo(2), daysAgo(60)]) {
      db.insert(schema.comments)
        .values({
          lessonId: lesson.id,
          userId: base.user.id,
          body: markdown("How does this work?"),
          createdAt,
        })
        .run();
    }

    expect(analyticsFor({ range: "30d" }).questions).toEqual({
      inRange: 1,
      older: 1,
    });
  });
});

describe("refund exposure", () => {
  it("counts only purchases still inside their refund window", () => {
    buy(base.course.id, 1000, daysAgo(13));
    buy(base.course.id, 4000, daysAgo(15));

    const { refundExposure } = analyticsFor();

    expect(refundExposure.grossCents).toBe(1000);
    expect(refundExposure.purchaseCount).toBe(1);
    expect(refundExposure.sharePercent).toBe(20);
  });

  it("flags a window closing today", () => {
    buy(base.course.id, 1000, daysAgo(14));

    const { refundExposure } = analyticsFor();

    expect(refundExposure.closingTodayCount).toBe(1);
    expect(refundExposure.courses[0].daysLeft).toBe(0);
  });

  it("headlines each course with its most urgent purchase", () => {
    buy(base.course.id, 1000, daysAgo(2));
    buy(base.course.id, 1000, daysAgo(10));

    const [course] = analyticsFor().refundExposure.courses;

    expect(course.purchaseCount).toBe(2);
    expect(course.daysLeft).toBe(4);
  });
});

describe("the course funnel", () => {
  it("counts a student who reached a later lesson as having passed the earlier ones", () => {
    addLesson(base.course.id, 1);
    const second = addLesson(base.course.id, 2);
    const quitter = addUser("quitter", UserRole.Student);
    for (const userId of [base.user.id, quitter.id]) {
      db.insert(schema.enrollments)
        .values({ userId, courseId: base.course.id })
        .run();
    }
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: second.id,
        status: LessonProgressStatus.InProgress,
      })
      .run();

    const funnel = analyticsFor({ courseId: base.course.id }).funnel!;
    const reached = funnel.modules.flatMap((m) =>
      m.lessons.map((l) => l.reachedCount)
    );

    expect(funnel.enrolledCount).toBe(2);
    expect(reached).toEqual([1, 1]);
  });
});
