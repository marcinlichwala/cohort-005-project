import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

// These tests replay the real files in drizzle/ against an in-memory database,
// so they check the SQL that will actually run on someone's data.db.

const migrationsFolder = path.resolve(__dirname, "../../drizzle");

const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
  fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")
);

function applyMigrations(
  sqlite: Database.Database,
  filter: (tag: string) => boolean
) {
  for (const { tag } of journal.entries) {
    if (!filter(tag)) continue;
    const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
}

// The last migration that still called the Refund Request table `refunds`.
const BEFORE_RENAME = "0010_cuddly_red_skull";

function isAtOrBefore(tag: string, last: string) {
  return tag.localeCompare(last) <= 0;
}

describe("Refund Request table rename", () => {
  it("keeps every existing Refund Request when the table becomes refund_requests", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite, (tag) => isAtOrBefore(tag, BEFORE_RENAME));

    // The requests need no purchases behind them: only the rows themselves
    // matter here, so foreign keys are switched off for the insert.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      INSERT INTO refunds (id, purchase_id, status, reason, amount_refunded, requested_at, resolved_at, resolved_by_user_id)
      VALUES
        (1, 10, 'open', 'Bought the wrong course.', NULL, '2026-11-01T00:00:00.000Z', NULL, NULL),
        (2, 11, 'approved', 'Did not suit me.', 7900, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 1);
    `);

    applyMigrations(sqlite, (tag) => !isAtOrBefore(tag, BEFORE_RENAME));

    const rows = sqlite
      .prepare(
        "SELECT id, purchase_id, status, reason, requested_at, resolved_at, resolved_by_user_id FROM refund_requests ORDER BY id"
      )
      .all();
    expect(rows).toEqual([
      {
        id: 1,
        purchase_id: 10,
        status: "open",
        reason: "Bought the wrong course.",
        requested_at: "2026-11-01T00:00:00.000Z",
        resolved_at: null,
        resolved_by_user_id: null,
      },
      {
        id: 2,
        purchase_id: 11,
        status: "approved",
        reason: "Did not suit me.",
        requested_at: "2026-10-01T00:00:00.000Z",
        resolved_at: "2026-10-02T00:00:00.000Z",
        resolved_by_user_id: 1,
      },
    ]);
  });
});
