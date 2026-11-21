import { eq } from "drizzle-orm";
import { UserRole, users } from "~/db/schema";
import type { Db } from "./db";
import type { Viewer } from "./viewer";
import { forbidden, signedOut } from "./errors";

export type User = typeof users.$inferSelect;

export type SignedIn = {
  userId: number;
  user: User;
  isAdmin: boolean;
};

/**
 * Who the Viewer is on the platform, independent of any course. Guards return
 * the signed-in user or throw: 401 when signed out, 403 when the role is wrong.
 */
export type Access = {
  /** Null when signed out, or when the session names a user that's gone. */
  userId: number | null;
  user: User | undefined;
  isAdmin: boolean;
  isInstructor: boolean;
  requireSignedIn(): SignedIn;
  requireInstructorOrAdmin(): SignedIn;
  requireAdmin(): SignedIn;
};

export function findUser(db: Db, userId: number | null): User | undefined {
  if (userId === null) return undefined;
  return db.select().from(users).where(eq(users.id, userId)).get();
}

export function getAccess(db: Db, viewer: Pick<Viewer, "userId">): Access {
  const user = findUser(db, viewer.userId);
  const isAdmin = user?.role === UserRole.Admin;
  const isInstructor = user?.role === UserRole.Instructor;

  function requireSignedIn(): SignedIn {
    if (!user) signedOut();
    return { userId: user.id, user, isAdmin };
  }

  return {
    userId: user?.id ?? null,
    user,
    isAdmin,
    isInstructor,
    requireSignedIn,
    requireInstructorOrAdmin() {
      const signedIn = requireSignedIn();
      if (!isAdmin && !isInstructor) {
        forbidden("Only instructors can access this page.");
      }
      return signedIn;
    },
    requireAdmin() {
      const signedIn = requireSignedIn();
      if (!isAdmin) forbidden("Only Platform Admins can access this page.");
      return signedIn;
    },
  };
}
