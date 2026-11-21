import { data } from "react-router";

// One wording per refusal, so a status always reads the same wherever it's
// thrown. The 401 text is what CLAUDE.md's troubleshooting table keys on.

export function signedOut(): never {
  throw data("Select a user from the DevUI panel.", { status: 401 });
}

export function forbidden(message: string): never {
  throw data(message, { status: 403 });
}

export function notFound(message: string): never {
  throw data(message, { status: 404 });
}
