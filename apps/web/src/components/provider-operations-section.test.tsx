// @vitest-environment jsdom

import { FormApi } from "@tanstack/react-form";
import { fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode, useState } from "react";
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
  CapabilityInventoryInput,
  focusFirstInvalidProviderField,
  parseProviderCapabilityInventory,
  providerAccountFormSchema,
  providerBudgetFormSchema,
  providerBudgetRules,
  providerCapabilityInventory,
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

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findElement(child as ReactNode, predicate);
    if (match) return match;
  }
  return undefined;
}

describe("ProviderOperationsSection form workflows", () => {
  it("mounts the exact inventory editor and submits a multi-surface v4 inventory", () => {
    let submitted: ReturnType<typeof parseProviderCapabilityInventory> | undefined;
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitted = parseProviderCapabilityInventory(value);
          }}
        >
          <CapabilityInventoryInput
            id="inventory"
            label="Exact capability inventory"
            value={value}
            onBlur={() => undefined}
            onChange={setValue}
          />
          <button type="submit">Save inventory</button>
        </form>
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Exact capability inventory"), {
      target: {
        value: JSON.stringify({
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "dashboard",
              confidence: "exact",
              operations: ["create"],
              tools: true,
              parallelTools: true,
            },
            openaiResponses: {
              source: "dashboard",
              confidence: "exact",
              operations: ["create", "retrieve", "countTokens"],
              structuredOutput: true,
              reasoning: true,
              hostedTools: true,
              maxContextTokens: 128000,
            },
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save inventory" }));
    expect(submitted).toMatchObject({
      surfaces: {
        openaiChatCompletions: { operations: ["create"], parallelTools: true },
        openaiResponses: { operations: ["create", "retrieve", "countTokens"] },
      },
    });
  });

  it("builds strict v4 native inventories including version-scoped Anthropic betas", () => {
    expect(
      providerCapabilityInventory({
        nativeSurface: "OPENAI_RESPONSES",
        streaming: true,
        anthropicVersion: "2023-06-01",
        betaFeatures: "",
      }),
    ).toMatchObject({
      version: 4,
      protocol: "openai-compatible",
      surfaces: { openaiResponses: { operations: ["create"], streaming: true } },
    });
    expect(
      providerCapabilityInventory({
        nativeSurface: "ANTHROPIC_MESSAGES",
        streaming: false,
        anthropicVersion: "2023-06-01",
        betaFeatures: "cache-beta, tools-beta, cache-beta",
      }),
    ).toMatchObject({
      version: 4,
      protocol: "anthropic-compatible",
      surfaces: {
        anthropicMessages: {
          operations: ["create"],
          protocolVersions: [{ version: "2023-06-01", betaFeatures: ["cache-beta", "tools-beta"] }],
        },
      },
    });
  });

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

  it("builds the successful seven-rule mutation payload with explicit modes", () => {
    const rules = providerBudgetRules(
      {
        ...unlimitedBudget,
        concurrencyMode: "LIMITED",
        concurrency: "2",
        tokenAttemptMode: "LIMITED",
        tokenAttempt: "1000",
        spendDayMode: "LIMITED",
        spendDay: "5.50",
      },
      "USD",
    );
    expect(rules).toHaveLength(7);
    expect(rules).toContainEqual({
      metric: "CONCURRENCY",
      period: "PER_ATTEMPT",
      mode: "LIMITED",
      limitValue: "2",
      currency: null,
    });
    expect(rules).toContainEqual({
      metric: "SPEND",
      period: "UTC_DAY",
      mode: "LIMITED",
      limitValue: "5.50",
      currency: "USD",
    });
    expect(rules).toContainEqual({
      metric: "SPEND",
      period: "UTC_MONTH",
      mode: "UNLIMITED",
      limitValue: null,
      currency: "USD",
    });
  });

  it("submits a real TanStack form after interactive mode and value changes", async () => {
    let submitted: ReturnType<typeof providerBudgetRules> | undefined;
    const defaults: Parameters<typeof providerBudgetRules>[0] = { ...unlimitedBudget };
    const form = new FormApi({
      defaultValues: defaults,
      validators: { onSubmit: providerBudgetFormSchema },
      onSubmit: ({ value }) => {
        submitted = providerBudgetRules(value, "USD");
      },
    });
    const unmount = form.mount();
    form.setFieldValue("tokenDayMode", "LIMITED");
    form.setFieldValue("tokenDay", "2500");
    form.setFieldValue("spendMonthMode", "LIMITED");
    form.setFieldValue("spendMonth", "25.75");
    await form.handleSubmit();
    expect(submitted).toContainEqual({
      metric: "TOKENS",
      period: "UTC_DAY",
      mode: "LIMITED",
      limitValue: "2500",
      currency: null,
    });
    expect(submitted).toContainEqual({
      metric: "SPEND",
      period: "UTC_MONTH",
      mode: "LIMITED",
      limitValue: "25.75",
      currency: "USD",
    });
    unmount();
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

  it("handles a mode-control interaction and rerenders the unlimited warning", () => {
    let mode: "LIMITED" | "UNLIMITED" = "LIMITED";
    const renderRule = () =>
      BudgetRuleField({
        id: "interactive-budget",
        label: "Tokens / day",
        mode,
        value: "100",
        onMode: (next) => {
          mode = next;
        },
        onValue: () => undefined,
      });
    const select = findElement(
      renderRule(),
      (element) => element.props.id === "interactive-budget-mode",
    );
    expect(select).toBeDefined();
    if (!select) throw new Error("budget mode select not rendered");
    (select.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "UNLIMITED" },
    });
    expect(mode).toBe("UNLIMITED");
    expect(renderToStaticMarkup(renderRule())).toContain("providers.unlimitedRuleWarning");
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
