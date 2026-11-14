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

// The last migration before Refunds got their own table.
const BEFORE_REFUNDS = "0012_add_decline_note_to_refund_requests";

describe("Refunds table backfill", () => {
  it("gives every existing Approved Refund Request a Pending Refund for the amount paid", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite, (tag) => isAtOrBefore(tag, BEFORE_REFUNDS));

    // Only purchases and requests matter here: the users and courses behind
    // them don't, so foreign keys are off for the insert.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      INSERT INTO purchases (id, user_id, course_id, amount_paid, country, created_at)
      VALUES
        (10, 1, 1, 7900, 'US', '2026-09-20T00:00:00.000Z'),
        (11, 2, 1, 4900, 'US', '2026-09-21T00:00:00.000Z'),
        (12, 3, 1, 9900, 'US', '2026-09-22T00:00:00.000Z');
      INSERT INTO refund_requests (id, purchase_id, status, reason, amount_refunded, requested_at, resolved_at, resolved_by_user_id)
      VALUES
        (1, 10, 'approved', 'Did not suit me.', 5000, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 99),
        (2, 11, 'open', 'Bought the wrong course.', NULL, '2026-11-01T00:00:00.000Z', NULL, NULL),
        (3, 12, 'declined', 'Changed my mind.', NULL, '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 99);
    `);

    applyMigrations(sqlite, (tag) => !isAtOrBefore(tag, BEFORE_REFUNDS));

    // The Refund is always the full amount paid (7900), not whatever partial
    // amount was typed into the old amount_refunded column (5000). Open and
    // declined requests get no Refund.
    const rows = sqlite
      .prepare(
        "SELECT refund_request_id, amount, status, status_changed_at, status_changed_by_user_id FROM refunds ORDER BY id"
      )
      .all();
    expect(rows).toEqual([
      {
        refund_request_id: 1,
        amount: 7900,
        status: "pending",
        status_changed_at: "2026-10-02T00:00:00.000Z",
        status_changed_by_user_id: 99,
      },
    ]);
  });

  it("removes the amount from the Refund Request, since it now lives on the Refund", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite, () => true);

    const columns = sqlite
      .prepare("SELECT name FROM pragma_table_info('refund_requests')")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).not.toContain("amount_refunded");
  });
});
