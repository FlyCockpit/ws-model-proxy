import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, Trans } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import enAuth from "../locales/en-US/auth.json";

/**
 * Regression tests for the Phase 13 `<Trans>` rendering bugs. The originals
 * passed JSX children whose positional indices did not match the `<N>` tags
 * in the JSON, which produced duplicated phrases and dropped `<code>` content
 * (see Phase 12 smoke test report). The fix is to use the explicit
 * `components` prop so the JSON value remains the source of truth for both
 * text and tag positions.
 *
 * If a future refactor reverts to children-as-source-of-truth these snapshots
 * will diverge from the JSON values and the test will fail loudly.
 */
describe("<Trans> components-prop rendering", () => {
  const i18n = createInstance();

  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["auth"],
      defaultNS: "auth",
      resources: {
        "en-US": { auth: enAuth },
      },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  function renderTrans(node: React.ReactElement): string {
    return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
  }

  it("renders device.enterCodeDescription with the user_code wrapped in <code>", () => {
    const html = renderTrans(
      <Trans i18nKey="device.enterCodeDescription" ns="auth" components={[<code key="0" />]} />,
    );

    expect(html).toBe(
      "The device that initiated this request will display a short code. Open the link it provided, or paste the code into the URL as <code>?user_code=YOURCODE</code>.",
    );
  });
});
