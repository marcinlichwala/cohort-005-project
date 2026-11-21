// Instructor analytics: everything the instructor analytics page shows, behind
// one call. Pass the viewer, a range, and the raw instructor/course ids from the
// URL; get back every figure already scoped to what that viewer may see.
//
// Queries, scoping rules, and refund-window maths live in ./lib and are not
// importable from outside this module.

export {
  getInstructorAnalytics,
  type AnalyticsOptions,
  type InstructorAnalytics,
  type CourseCountryRevenue,
  type CountryRevenueRow,
  type CourseFunnel,
  type CourseProgressSummary,
  type ExposedCourse,
  type FunnelLesson,
  type FunnelModule,
  type QuizPassRate,
  type RatingSummary,
  type RefundExposure,
  type RevenuePoint,
  type RevenueSeries,
  type RevenueSummary,
  type TopBuyer,
} from "./lib/instructor-analytics.server";
