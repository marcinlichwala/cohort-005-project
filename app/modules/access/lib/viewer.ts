/**
 * Whoever is behind a request: a signed-in user id (or nobody) and the country
 * they're visiting from (or unknown). Every access decision is made from these
 * facts alone, never from the request itself.
 */
export type Viewer = {
  userId: number | null;
  country: string | null;
};
