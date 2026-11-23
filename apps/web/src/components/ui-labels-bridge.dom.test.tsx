// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@ws-model-proxy/ui/components/sheet";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import enCommon from "@/locales/en-US/common.json";
import esCommon from "@/locales/es-MX/common.json";
import { UiLabelsBridge } from "./ui-labels-bridge";

afterEach(cleanup);

describe.each([
  {
    name: "Dialog",
    Root: Dialog,
    Content: DialogContent,
    Title: DialogTitle,
    Description: DialogDescription,
  },
  {
    name: "Sheet",
    Root: Sheet,
    Content: SheetContent,
    Title: SheetTitle,
    Description: SheetDescription,
  },
])("$name close button", ({ name, Root, Content, Title, Description }) => {
  function popup(closeLabel?: string) {
    return (
      <Root defaultOpen>
        <Content closeLabel={closeLabel}>
          <Title>Test popup</Title>
          <Description>Test description</Description>
        </Content>
      </Root>
    );
  }

  async function mountTranslated(closeLabel?: string) {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "es-MX",
      fallbackLng: "en-US",
      resources: { "en-US": { common: enCommon }, "es-MX": { common: esCommon } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <UiLabelsBridge>{popup(closeLabel)}</UiLabelsBridge>
      </I18nextProvider>,
    );
    return i18n;
  }

  it("uses the Spanish accessible name and a 44px hit area", async () => {
    await mountTranslated();
    const close = await screen.findByRole("button", { name: "Cerrar" });
    // Sheet: the button itself is 44px. Dialog: a 28px button with a centred 44px ::after,
    // sized from the border box (an `after:-inset-*` expansion starts inside the 1px border
    // and measured 42px in the browser).
    const hitAreaClasses =
      name === "Sheet"
        ? ["size-11"]
        : [
            "size-7",
            "after:absolute",
            "after:top-1/2",
            "after:left-1/2",
            "after:size-11",
            "after:-translate-x-1/2",
            "after:-translate-y-1/2",
            "after:content-['']",
          ];
    for (const className of hitAreaClasses) {
      expect(close.classList.contains(className)).toBe(true);
    }
    expect([...close.classList].some((className) => className.startsWith("after:-inset"))).toBe(
      false,
    );
    // Sheet: the 44px box is flush with the viewport edge (right-0), so its focus ring is
    // drawn inside the box (an outer ring plus offset is clipped). Dialog: at right-2 the outer
    // ring has room inside the popup.
    if (name === "Sheet") {
      expect(close.classList.contains("focus-visible:ring-inset")).toBe(true);
      expect(close.classList.contains("focus-visible:ring-offset-0")).toBe(true);
    }
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("updates the label when the locale changes", async () => {
    const i18n = await mountTranslated();
    expect(await screen.findByRole("button", { name: "Cerrar" })).toBeTruthy();
    await act(async () => {
      await i18n.changeLanguage("en-US");
    });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("lets closeLabel override the provider", async () => {
    await mountTranslated("X");
    expect(await screen.findByRole("button", { name: "X" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cerrar" })).toBeNull();
  });

  it("defaults to Close without a provider", async () => {
    render(popup());
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
  });
});
