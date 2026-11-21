import { getCurrentUserId } from "~/lib/session";
import { resolveCountry } from "~/lib/country.server";
import type { Viewer } from "./viewer";

export async function readViewer(request: Request): Promise<Viewer> {
  const [userId, country] = await Promise.all([
    getCurrentUserId(request),
    resolveCountry(request),
  ]);
  return { userId, country };
}
