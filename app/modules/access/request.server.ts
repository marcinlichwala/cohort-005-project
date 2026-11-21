// The adapter between HTTP and Access: reads the Viewer (signed-in user id and
// visiting country) off a request. The only part of this module that knows
// about sessions, cookies, or the CF-IPCountry header.

export { readViewer } from "./lib/read-viewer.server";
