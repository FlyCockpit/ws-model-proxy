import { describe, expect, it } from "vitest";
import { healthFailureDetail, healthHttpStatus, isHealthFailure } from "./health-reasons";

describe("health reasons", () => {
  it("keeps only the reasons it knows", () => {
    expect(healthFailureDetail("http_404")).toBe("http_404");
    expect(healthFailureDetail("serving_unconfirmed")).toBe("serving_unconfirmed");
    expect(healthFailureDetail("http_99")).toBeNull();
    expect(healthFailureDetail("port_in_use")).toBeNull();
    expect(healthFailureDetail(undefined)).toBeNull();
  });

  it("reads an HTTP status and names the plain reasons", () => {
    expect(healthHttpStatus("http_503")).toBe("503");
    expect(healthHttpStatus("timeout")).toBeNull();
    expect(isHealthFailure("connect_refused")).toBe(true);
    expect(isHealthFailure("http_503")).toBe(false);
  });
});
