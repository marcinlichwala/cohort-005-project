import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { eq } from "drizzle-orm";
import { markdown } from "~/lib/text";
import { setCurrentUserId, setDevCountry } from "~/lib/session";
import { getAccess, getCourseAccess } from "~/modules/access/index.server";
import { readViewer } from "~/modules/access/request.server";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

function addUser(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name}@example.com`, role })
    .returning()
    .get();
}

function enroll(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function buy(userId: number, country: string | null) {
  db.insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid: 5000, country })
    .run();
}

function addCourse(slug: string) {
  return db
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: slug,
      salesCopy: markdown(slug),
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

/** The HTTP status a guard threw, or undefined if it didn't throw one. */
function thrownStatus(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return (error as { init?: { status?: number } }).init?.status;
  }
  return undefined;
}

function accessFor(userId: number | null, country: string | null = null) {
  return getCourseAccess(db, { userId, courseId: base.course.id, country });
}

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

describe("deciding course access", () => {
  it("gives a signed-out visitor no access", () => {
    const access = accessFor(null);

    expect(access.userId).toBeNull();
    expect(access.isStaff).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  it("treats a user id with no user behind it as signed out", () => {
    const access = accessFor(9999);

    expect(access.userId).toBeNull();
    expect(access.canViewContent).toBe(false);
  });

  it("refuses a course that does not exist", () => {
    expect(
      thrownStatus(() =>
        getCourseAccess(db, { userId: base.user.id, courseId: 9999, country: null })
      )
    ).toBe(404);
  });

  it("lets an enrolled Student read the content", () => {
    enroll(base.user.id);

    const access = accessFor(base.user.id);

    expect(access.enrolled).toBe(true);
    expect(access.isStaff).toBe(false);
    expect(access.canViewContent).toBe(true);
  });

  it("keeps a Student without an Enrollment out of the content", () => {
    const access = accessFor(base.user.id);

    expect(access.enrolled).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  it("lets the owning Instructor in without an Enrollment", () => {
    const access = accessFor(base.instructor.id);

    expect(access.isOwningInstructor).toBe(true);
    expect(access.isStaff).toBe(true);
    expect(access.canViewContent).toBe(true);
  });

  it("does not treat another Instructor as staff on this course", () => {
    const other = addUser("other-instructor", UserRole.Instructor);

    const access = accessFor(other.id);

    expect(access.isOwningInstructor).toBe(false);
    expect(access.isStaff).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  it("lets a Platform Admin in on any course", () => {
    const admin = addUser("admin", UserRole.Admin);

    const access = accessFor(admin.id);

    expect(access.isAdmin).toBe(true);
    expect(access.isStaff).toBe(true);
    expect(access.canViewContent).toBe(true);
  });

  describe("with PPP pricing on the course", () => {
    beforeEach(() => {
      db.update(schema.courses)
        .set({ price: 10000, pppEnabled: true })
        .where(eq(schema.courses.id, base.course.id))
        .run();
    });

    it("blocks a Student who bought at a discount from another country", () => {
      enroll(base.user.id);
      buy(base.user.id, "IN");

      const access = accessFor(base.user.id, "US");

      expect(access.pppBlocked).toBe(true);
      expect(access.pppBlockedCountry).toBe("US");
      expect(access.pppPurchaseCountry).toBe("IN");
      expect(access.canViewContent).toBe(false);
    });

    it("lets that Student in from the country they bought in", () => {
      enroll(base.user.id);
      buy(base.user.id, "IN");

      expect(accessFor(base.user.id, "IN").canViewContent).toBe(true);
    });

    it("lets that Student in when their country is unknown", () => {
      enroll(base.user.id);
      buy(base.user.id, "IN");

      expect(accessFor(base.user.id, null).canViewContent).toBe(true);
    });

    it("lets a Student in if any of their Purchases was full price", () => {
      enroll(base.user.id);
      buy(base.user.id, "IN");
      buy(base.user.id, "US");
      buy(base.user.id, "BR");

      expect(accessFor(base.user.id, "DE").canViewContent).toBe(true);
    });

    it("lets a Student in if any discounted Purchase was from where they are", () => {
      enroll(base.user.id);
      buy(base.user.id, "IN");
      buy(base.user.id, "BR");

      expect(accessFor(base.user.id, "BR").canViewContent).toBe(true);
    });

    it("never PPP-blocks a Student whose Enrollment has no Purchase behind it", () => {
      enroll(base.user.id);

      expect(accessFor(base.user.id, "US").pppBlocked).toBe(false);
    });

    it("never PPP-blocks the owning Instructor", () => {
      enroll(base.instructor.id);
      buy(base.instructor.id, "IN");

      const access = accessFor(base.instructor.id, "US");

      expect(access.pppBlocked).toBe(false);
      expect(access.canViewContent).toBe(true);
    });
  });
});

describe("looking up a course's own records", () => {
  function addModule(courseId: number) {
    return db
      .insert(schema.modules)
      .values({ courseId, title: "Module", position: 1 })
      .returning()
      .get();
  }

  function addLesson(moduleId: number) {
    return db
      .insert(schema.lessons)
      .values({ moduleId, title: "Lesson", position: 1 })
      .returning()
      .get();
  }

  function addQuiz(lessonId: number) {
    return db
      .insert(schema.quizzes)
      .values({ lessonId, title: "Quiz", passingScore: 0.7 })
      .returning()
      .get();
  }

  it("finds a lesson that belongs to the course", () => {
    const lesson = addLesson(addModule(base.course.id).id);

    expect(accessFor(base.user.id).lesson(lesson.id).id).toBe(lesson.id);
  });

  it("refuses a lesson from another course", () => {
    const elsewhere = addLesson(addModule(addCourse("other").id).id);

    expect(thrownStatus(() => accessFor(base.user.id).lesson(elsewhere.id))).toBe(
      404
    );
  });

  it("refuses a lesson that does not exist", () => {
    expect(thrownStatus(() => accessFor(base.user.id).lesson(9999))).toBe(404);
  });

  it("finds a quiz on one of the course's lessons", () => {
    const quiz = addQuiz(addLesson(addModule(base.course.id).id).id);

    expect(accessFor(base.user.id).quiz(quiz.id).id).toBe(quiz.id);
  });

  it("refuses a quiz from another course", () => {
    const elsewhere = addQuiz(addLesson(addModule(addCourse("other").id).id).id);

    expect(thrownStatus(() => accessFor(base.user.id).quiz(elsewhere.id))).toBe(
      404
    );
  });
});

describe("guarding by course access", () => {
  it("rejects a signed-out visitor with 401", () => {
    expect(thrownStatus(() => accessFor(null).requireContent())).toBe(401);
    expect(thrownStatus(() => accessFor(null).requireStaff())).toBe(401);
  });

  it("rejects a Student without an Enrollment with 403", () => {
    expect(thrownStatus(() => accessFor(base.user.id).requireContent())).toBe(
      403
    );
  });

  it("lets an enrolled Student through", () => {
    enroll(base.user.id);

    expect(accessFor(base.user.id).requireContent().userId).toBe(base.user.id);
  });

  it("rejects a Student from staff-only actions with 403", () => {
    enroll(base.user.id);

    expect(thrownStatus(() => accessFor(base.user.id).requireStaff())).toBe(403);
  });

  it("lets the owning Instructor through staff-only actions", () => {
    expect(accessFor(base.instructor.id).requireStaff().isOwningInstructor).toBe(
      true
    );
  });
});

describe("guarding by role", () => {
  it("rejects a signed-out visitor with 401", () => {
    const access = getAccess(db, { userId: null });

    expect(thrownStatus(() => access.requireSignedIn())).toBe(401);
    expect(thrownStatus(() => access.requireInstructorOrAdmin())).toBe(401);
    expect(thrownStatus(() => access.requireAdmin())).toBe(401);
  });

  it("hands back the signed-in user", () => {
    const signedIn = getAccess(db, { userId: base.user.id }).requireSignedIn();

    expect(signedIn.userId).toBe(base.user.id);
    expect(signedIn.user.id).toBe(base.user.id);
  });

  it("keeps a Student out of Instructor pages with 403", () => {
    const access = getAccess(db, { userId: base.user.id });

    expect(thrownStatus(() => access.requireInstructorOrAdmin())).toBe(403);
  });

  it("lets an Instructor into Instructor pages but not admin ones", () => {
    const access = getAccess(db, { userId: base.instructor.id });

    expect(access.requireInstructorOrAdmin().isAdmin).toBe(false);
    expect(thrownStatus(() => access.requireAdmin())).toBe(403);
  });

  it("lets a Platform Admin in everywhere", () => {
    const admin = addUser("admin", UserRole.Admin);
    const access = getAccess(db, { userId: admin.id });

    expect(access.requireInstructorOrAdmin().isAdmin).toBe(true);
    expect(access.requireAdmin().userId).toBe(admin.id);
  });
});

describe("reading the Viewer off a request", () => {
  const blank = () => new Request("http://localhost/");

  it("reads nobody from a request with no session", async () => {
    expect(await readViewer(blank())).toEqual({ userId: null, country: null });
  });

  it("reads the signed-in user and the Cloudflare country", async () => {
    const cookie = (await setCurrentUserId(blank(), 7)).split(";")[0];
    const request = new Request("http://localhost/", {
      headers: { Cookie: cookie, "CF-IPCountry": "in" },
    });

    expect(await readViewer(request)).toEqual({ userId: 7, country: "IN" });
  });

  it("prefers the DevUI country over the header", async () => {
    const cookie = (await setDevCountry(blank(), "BR")).split(";")[0];
    const request = new Request("http://localhost/", {
      headers: { Cookie: cookie, "CF-IPCountry": "US" },
    });

    expect((await readViewer(request)).country).toBe("BR");
  });
});
