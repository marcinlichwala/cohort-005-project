import { and, eq } from "drizzle-orm";
import {
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  quizzes,
} from "~/db/schema";
import { checkPppAccess } from "~/lib/ppp";
import type { Db } from "./db";
import type { Viewer } from "./viewer";
import { getAccess, type User } from "./access.server";
import { forbidden, notFound, signedOut } from "./errors";

type Course = typeof courses.$inferSelect;
type Lesson = typeof lessons.$inferSelect;
type Quiz = typeof quizzes.$inferSelect;

/**
 * Who the Viewer is to one course, and the only way to reach that course's
 * lessons and quizzes by id. Never throws while deciding — the lesson page
 * renders a paywall preview for signed-out and unenrolled visitors — but the
 * require* guards and lookups do.
 */
export type CourseAccess = {
  userId: number | null;
  user: User | undefined;
  isAdmin: boolean;
  /** The Instructor who owns this specific course. */
  isOwningInstructor: boolean;
  /** Owning Instructor or Platform Admin — the people who speak for the course. */
  isStaff: boolean;
  enrolled: boolean;
  pppBlocked: boolean;
  pppBlockedCountry: string | null;
  pppPurchaseCountry: string | null;
  /**
   * May they read the course's content (lesson bodies, comments)?
   * Staff always can. Students need an Enrollment that isn't PPP-blocked.
   */
  canViewContent: boolean;
  /** Throws 401 when signed out, 403 unless they can view the content. */
  requireContent(): CourseAccess & { userId: number; user: User };
  /** Throws 401 when signed out, 403 unless they're staff on this course. */
  requireStaff(): CourseAccess & { userId: number; user: User };
  /** The lesson, or 404 unless it belongs to this course. */
  lesson(lessonId: number): Lesson;
  /** The quiz, or 404 unless it's on one of this course's lessons. */
  quiz(quizId: number): Quiz;
};

const NOT_BLOCKED = { blocked: false, blockedCountry: null, purchaseCountry: null };

/**
 * A Student is PPP-blocked only when every Purchase they made of the course is
 * blocked from where they are now. One full-price or same-country Purchase lets
 * them in, and an Enrollment from a Claimed Seat has no Purchase to block on.
 */
function pppCheck(db: Db, course: Course, userId: number, country: string | null) {
  const bought = db
    .select({ country: purchases.country })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, course.id)))
    .all();

  const checks = bought.map((purchase) =>
    checkPppAccess(course.price, course.pppEnabled, purchase.country, country)
  );

  if (checks.length === 0 || checks.some((check) => !check.blocked)) {
    return NOT_BLOCKED;
  }
  return checks[0];
}

function isEnrolled(db: Db, userId: number, courseId: number) {
  return !!db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function getCourseAccess(
  db: Db,
  { userId, courseId, country }: Viewer & { courseId: number }
): CourseAccess {
  const course = db.select().from(courses).where(eq(courses.id, courseId)).get();
  if (!course) notFound("Course not found");

  const { user, isAdmin } = getAccess(db, { userId });
  const isOwningInstructor = !!user && course.instructorId === user.id;
  const isStaff = isAdmin || isOwningInstructor;
  const enrolled = !!user && isEnrolled(db, user.id, course.id);

  // PPP only restricts Students — staff are exempt (ADR-0009).
  const ppp =
    user && enrolled && !isStaff
      ? pppCheck(db, course, user.id, country)
      : NOT_BLOCKED;

  const access: CourseAccess = {
    userId: user?.id ?? null,
    user,
    isAdmin,
    isOwningInstructor,
    isStaff,
    enrolled,
    pppBlocked: ppp.blocked,
    pppBlockedCountry: ppp.blockedCountry,
    pppPurchaseCountry: ppp.purchaseCountry,
    canViewContent: isStaff || (enrolled && !ppp.blocked),

    requireContent() {
      if (!user) signedOut();
      if (!access.canViewContent) {
        forbidden("You must be enrolled in this course.");
      }
      return { ...access, userId: user.id, user };
    },

    requireStaff() {
      if (!user) signedOut();
      if (!isStaff) forbidden("Only this course's instructor can do that.");
      return { ...access, userId: user.id, user };
    },

    lesson(lessonId) {
      const found = db
        .select({ lesson: lessons })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .where(and(eq(lessons.id, lessonId), eq(modules.courseId, course.id)))
        .get();
      if (!found) notFound("Lesson not found in this course");
      return found.lesson;
    },

    quiz(quizId) {
      const found = db
        .select({ quiz: quizzes })
        .from(quizzes)
        .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .where(and(eq(quizzes.id, quizId), eq(modules.courseId, course.id)))
        .get();
      if (!found) notFound("Quiz not found in this course");
      return found.quiz;
    },
  };

  return access;
}
