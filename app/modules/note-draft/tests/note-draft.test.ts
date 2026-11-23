import { describe, it, expect } from "vitest";
import { noteDraftStatus } from "../index";
import { MAX_NOTE_LENGTH } from "~/lib/notes";

describe("noteDraftStatus", () => {
  it("cannot save an empty draft when there is no Note yet", () => {
    const status = noteDraftStatus("", undefined);
    expect(status.length).toBe(0);
    expect(status.unsaved).toBe(false);
    expect(status.canSave).toBe(false);
  });

  it("cannot save a draft of only whitespace", () => {
    const status = noteDraftStatus("   \n ", undefined);
    expect(status.length).toBe(0);
    expect(status.canSave).toBe(false);
  });

  it("can save a new draft with text in it", () => {
    const status = noteDraftStatus("Offset is page minus one", undefined);
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(true);
  });

  it("treats a draft that matches the saved Note as saved", () => {
    const status = noteDraftStatus("Use a cursor", "Use a cursor");
    expect(status.unsaved).toBe(false);
    expect(status.canSave).toBe(false);
  });

  it("ignores surrounding whitespace, as the server trims it", () => {
    const status = noteDraftStatus("  Use a cursor\n", "Use a cursor");
    expect(status.length).toBe(12);
    expect(status.unsaved).toBe(false);
  });

  it("marks an edited draft as unsaved", () => {
    const status = noteDraftStatus("Use a cursor!", "Use a cursor");
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(true);
  });

  it("cannot save a draft that clears the saved Note", () => {
    const status = noteDraftStatus("", "Use a cursor");
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(false);
  });

  it("allows a draft exactly at the cap", () => {
    const status = noteDraftStatus("a".repeat(MAX_NOTE_LENGTH), undefined);
    expect(status.overLimit).toBe(false);
    expect(status.canSave).toBe(true);
  });

  it("refuses a draft one character over the cap", () => {
    const status = noteDraftStatus("a".repeat(MAX_NOTE_LENGTH + 1), undefined);
    expect(status.overLimit).toBe(true);
    expect(status.canSave).toBe(false);
  });

  it("counts characters against the cap with thousands separators", () => {
    expect(noteDraftStatus("hello", undefined).counter).toBe("5 / 2,000");
    expect(noteDraftStatus("a".repeat(1234), undefined, 1500).counter).toBe(
      "1,234 / 1,500"
    );
  });

  it("defaults the cap to the Note limit", () => {
    expect(noteDraftStatus("", undefined).max).toBe(MAX_NOTE_LENGTH);
  });
});
