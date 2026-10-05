// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

import { TimeAgo } from "./time-ago";

afterEach(cleanup);

describe("TimeAgo", () => {
  it("shows a relative time and keeps the exact time machine-readable", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    render(<TimeAgo value="2026-10-05T11:59:52.000Z" now={now} />);
    const time = screen.getByText("8 seconds ago");
    expect(time.getAttribute("datetime")).toBe("2026-10-05T11:59:52.000Z");
    expect(time.getAttribute("title")).toBeTruthy();
  });

  it("uses the largest unit that fits", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    render(<TimeAgo value="2026-10-03T12:00:00.000Z" now={now} />);
    expect(screen.getByText("2 days ago")).toBeTruthy();
  });

  it("says never for a missing time", () => {
    render(<TimeAgo value={null} />);
    expect(screen.getByText("dashboard:time.never")).toBeTruthy();
  });
});
