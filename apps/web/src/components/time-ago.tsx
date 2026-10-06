import { useTranslation } from "react-i18next";

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** Relative time ("8 seconds ago") with the exact time in the element's title and datetime. */
export function TimeAgo({
  value,
  now = Date.now(),
}: {
  value: Date | string | null;
  now?: number;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  if (!value) return <span>{t("dashboard:time.never")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span>{t("dashboard:time.never")}</span>;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const [unit, size] = UNITS.find(([, span]) => Math.abs(seconds) >= span) ?? ["second", 1];
  const text = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "medium" })}
    >
      {text}
    </time>
  );
}
