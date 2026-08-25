import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));

import {
  BudgetRuleField,
  focusFirstInvalidProviderField,
  providerAccountFormSchema,
  providerBudgetFormSchema,
} from "./provider-operations-section";

const unlimitedBudget = {
  concurrencyMode: "UNLIMITED" as const,
  concurrency: "",
  tokenAttemptMode: "UNLIMITED" as const,
  tokenAttempt: "",
  tokenDayMode: "UNLIMITED" as const,
  tokenDay: "",
  tokenMonthMode: "UNLIMITED" as const,
  tokenMonth: "",
  tokenLifetimeMode: "UNLIMITED" as const,
  tokenLifetime: "",
  spendDayMode: "UNLIMITED" as const,
  spendDay: "",
  spendMonthMode: "UNLIMITED" as const,
  spendMonth: "",
};

describe("ProviderOperationsSection form workflows", () => {
  it("rejects invalid account setup and accepts a valid HTTPS account", () => {
    expect(
      providerAccountFormSchema.safeParse({
        label: "",
        providerType: "Open AI",
        baseUrl: "http://api.example.com",
        authType: "BEARER",
      }).success,
    ).toBe(false);
    expect(
      providerAccountFormSchema.safeParse({
        label: "Primary OpenAI",
        providerType: "openai",
        baseUrl: "https://api.example.com/v1",
        authType: "BEARER",
      }).success,
    ).toBe(true);
  });

  it("requires every LIMITED budget rule to be positive while accepting explicit UNLIMITED", () => {
    const invalid = providerBudgetFormSchema.safeParse({
      ...unlimitedBudget,
      tokenAttemptMode: "LIMITED",
      tokenDayMode: "LIMITED",
      spendMonthMode: "LIMITED",
      tokenAttempt: "0",
      tokenDay: "",
      spendMonth: "0",
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["tokenAttempt", "tokenDay", "spendMonth"]),
      );
    expect(providerBudgetFormSchema.safeParse(unlimitedBudget).success).toBe(true);
  });

  it("renders a keyboard-native mode control and a strong warning for UNLIMITED", () => {
    const markup = renderToStaticMarkup(
      <BudgetRuleField
        id="test-budget"
        label="Tokens / day"
        mode="UNLIMITED"
        value=""
        onMode={() => undefined}
        onValue={() => undefined}
      />,
    );
    expect(markup).toContain('<select id="test-budget-mode"');
    expect(markup).toContain("providers.unlimitedRuleWarning");
    expect(markup).not.toContain('id="test-budget-value"');
    expect(markup).toContain("min-w-0");
  });

  it("links a stable localized error to the finite value control", () => {
    const markup = renderToStaticMarkup(
      <BudgetRuleField
        id="test-budget"
        label="Spend / month"
        mode="LIMITED"
        value="0"
        errors={[{ message: "positiveRequired" }]}
        onMode={() => undefined}
        onValue={() => undefined}
        decimal
      />,
    );
    expect(markup).toContain('id="test-budget-value"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="test-budget-value-error"');
    expect(markup).toContain('id="test-budget-value-error"');
    expect(markup).toContain("providers.validation.positiveRequired");
  });

  it("moves keyboard focus to the first invalid control", () => {
    let focused = false;
    focusFirstInvalidProviderField({
      querySelector: (selector: string) => {
        expect(selector).toBe('[aria-invalid="true"]');
        return {
          focus: () => {
            focused = true;
          },
        } as unknown as HTMLElement;
      },
    } as HTMLFormElement);
    expect(focused).toBe(true);
  });
});
