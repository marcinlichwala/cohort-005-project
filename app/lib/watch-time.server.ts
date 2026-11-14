import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { lessons, modules, videoWatchEvents } from "~/db/schema";

/**
 * How much of a course a learner has watched: the furthest point reached in
 * each lesson, added up. Rewatching the start of a lesson adds nothing.
 *
 * This is the one definition used by Refund Eligibility (the course page and
 * the refund request route) and by the admin refund screen.
 */
export function getSecondsWatchedInCourse(userId: number, courseId: number) {
  const courseLessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (courseLessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, courseLessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}
