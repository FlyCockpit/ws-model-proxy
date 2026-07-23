import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  CLI_STATUSES,
  DEFAULT_OBSERVABILITY_SEARCH,
  dateInputToDate,
  dateInputToExclusiveEnd,
  parseFilterSelect,
  parseObservabilitySearch,
} from "./observability-search";

const parseUrl = (search: string) => defaultParseSearch(search) as Record<string, unknown>;
const fromUrl = (search: string) => parseObservabilitySearch(parseUrl(search));

describe("parseObservabilitySearch", () => {
  it("applies defaults for a bare visit", () => {
    expect(fromUrl("")).toEqual(DEFAULT_OBSERVABILITY_SEARCH);
  });

  it("parses page as a number from ?page=1 (JSON.parse path)", () => {
    expect(parseUrl("?page=1").page).toBe(1);
    expect(fromUrl("?page=1").page).toBe(1);
  });

  it("parses page from a string and clamps below 1", () => {
    expect(fromUrl("?page=3").page).toBe(3);
    expect(fromUrl("?page=0").page).toBe(1);
    expect(fromUrl("?page=-4").page).toBe(1);
    expect(fromUrl("?page=2.9").page).toBe(2);
    expect(fromUrl("?page=nope").page).toBe(1);
  });

  it("accepts known tabs and falls back for unknown ones", () => {
    expect(fromUrl("?tab=relays").tab).toBe("relays");
    expect(fromUrl("?tab=bogus").tab).toBe("clis");
  });

  it("accepts known enum filters and falls back to all", () => {
    expect(fromUrl("?cliStatus=CONNECTED").cliStatus).toBe("CONNECTED");
    expect(fromUrl("?cliStatus=nope").cliStatus).toBe("all");
    expect(fromUrl("?endpointStatus=DEGRADED").endpointStatus).toBe("DEGRADED");
    expect(fromUrl("?capability=VISION").capability).toBe("VISION");
    expect(fromUrl("?poolHealth=HALF_OPEN").poolHealth).toBe("HALF_OPEN");
    expect(fromUrl("?relayStatus=FAILED").relayStatus).toBe("FAILED");
  });

  it("keeps free-text filters as strings", () => {
    expect(fromUrl("?owner=alice").owner).toBe("alice");
    expect(fromUrl("?errorClass=TIMEOUT").errorClass).toBe("TIMEOUT");
  });

  it("accepts YYYY-MM-DD date inputs and rejects other shapes", () => {
    expect(fromUrl("?createdAfter=2024-01-15").createdAfter).toBe("2024-01-15");
    expect(fromUrl("?createdBefore=2024-02-01").createdBefore).toBe("2024-02-01");
    expect(fromUrl("?createdAfter=not-a-date").createdAfter).toBe("");
    expect(fromUrl("?createdAfter=2024/01/15").createdAfter).toBe("");
  });

  it("ignores non-string free-text values", () => {
    expect(parseObservabilitySearch({ owner: 12, errorClass: true })).toMatchObject({
      owner: "",
      errorClass: "",
    });
  });

  it("keeps explicit all / multi-param combinations", () => {
    expect(fromUrl("?cliStatus=all").cliStatus).toBe("all");
    expect(
      fromUrl("?tab=relays&page=4&owner=bob&relayStatus=FAILED&errorClass=TIMEOUT"),
    ).toMatchObject({
      tab: "relays",
      page: 4,
      owner: "bob",
      relayStatus: "FAILED",
      errorClass: "TIMEOUT",
    });
  });
});

describe("parseFilterSelect", () => {
  it("accepts all and known enum values", () => {
    expect(parseFilterSelect("all", CLI_STATUSES)).toBe("all");
    expect(parseFilterSelect("CONNECTED", CLI_STATUSES)).toBe("CONNECTED");
  });

  it("falls back to all for unknown values", () => {
    expect(parseFilterSelect("nope", CLI_STATUSES)).toBe("all");
  });
});

describe("dateInputToDate / dateInputToExclusiveEnd", () => {
  it("converts empty input to undefined", () => {
    expect(dateInputToDate("")).toBeUndefined();
    expect(dateInputToExclusiveEnd("")).toBeUndefined();
  });

  it("parses a date at UTC midnight and exclusive end as next day", () => {
    expect(dateInputToDate("2024-01-15")?.toISOString()).toBe("2024-01-15T00:00:00.000Z");
    expect(dateInputToExclusiveEnd("2024-01-15")?.toISOString()).toBe("2024-01-16T00:00:00.000Z");
  });

  it("rolls month-end exclusive ends into the next month", () => {
    expect(dateInputToExclusiveEnd("2024-01-31")?.toISOString()).toBe("2024-02-01T00:00:00.000Z");
  });
});
