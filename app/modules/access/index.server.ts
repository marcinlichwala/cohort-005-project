// Access: what a Viewer may see and do. Pass plain facts (a user id, a
// country, a course id) — never a Request; ./request.server turns a Request
// into a Viewer.
//
// getAccess answers platform-wide questions (signed in? Platform Admin?
// Instructor?). getCourseAccess answers them for one course, decides PPP
// blocking, and is the only way to fetch that course's lessons and quizzes by
// id. Guards and lookups throw 401/403/404 with one wording each.

export {
  getAccess,
  type Access,
  type SignedIn,
  type User,
} from "./lib/access.server";
export {
  getCourseAccess,
  type CourseAccess,
} from "./lib/course-access.server";
export type { Viewer } from "./lib/viewer";
