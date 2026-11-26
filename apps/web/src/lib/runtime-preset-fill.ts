/**
 * A preset's `fill` names spec paths a person should check before creating (`models[0].id`,
 * `launch.commands[0].start`). The New runtime page shows each as the label of the input that
 * holds it, and focuses that input on click; the raw path is never shown.
 */
export type FillTarget = {
  /** `dashboard:` key of the label to show. */
  labelKey: string;
  /** The input to focus, as the editor's id suffix (`model-0`), or "view" for the view switch. */
  target: string;
};

const RULES: ReadonlyArray<{ pattern: RegExp; target: (match: RegExpMatchArray) => FillTarget }> = [
  {
    pattern: /^address\.baseUrl$/,
    target: () => ({ labelKey: "runtime.specForm.baseUrl", target: "base-url" }),
  },
  {
    pattern: /^engine$/,
    target: () => ({ labelKey: "runtime.specForm.engine", target: "engine" }),
  },
  {
    pattern: /^models\[(\d+)\]\.id$/,
    target: (match) => ({ labelKey: "runtime.specForm.modelId", target: `model-${match[1]}` }),
  },
  {
    // The transcription profile has no inputs: the note in Serving details says how to edit it.
    pattern: /^models\[\d+\]\.transcription$/,
    target: () => ({ labelKey: "runtime.specForm.fillTranscription", target: "transcription" }),
  },
  {
    // The revision is the part to change (pin a commit); the rest follows the model.
    pattern: /^models\[(\d+)\]\.embeddingContract/,
    target: (match) => ({
      labelKey: "runtime.specForm.fillEmbedding",
      target: `model-${match[1]}-embedding-revision`,
    }),
  },
  {
    pattern: /^launch\.commands\[(\d+)\]\.(start|stop|status|prepare|afterJoin|health)$/,
    target: (match) => ({
      labelKey: `runtime.specForm.fillCommand.${match[2]}`,
      target: `command-${match[1]}-${match[2]}`,
    }),
  },
  {
    pattern: /^launch\.commands\[(\d+)\]$/,
    target: (match) => ({
      labelKey: "runtime.specForm.commands",
      target: `command-${match[1]}-start`,
    }),
  },
  {
    pattern: /^launch\.resources\[(\d+)\]/,
    target: (match) => ({
      labelKey: "runtime.specForm.sections.size",
      target: `resource-${match[1]}-kind`,
    }),
  },
];

/** The labelled targets of a preset's `fill`, in order, one per distinct label and input. */
export function fillTargets(fill: readonly string[]): FillTarget[] {
  const out: FillTarget[] = [];
  for (const path of fill) {
    let found: FillTarget | undefined;
    for (const rule of RULES) {
      const match = path.match(rule.pattern);
      if (match) {
        found = rule.target(match);
        break;
      }
    }
    const target = found ?? { labelKey: "runtime.specForm.fillOther", target: "view" };
    if (!out.some((seen) => seen.labelKey === target.labelKey && seen.target === target.target))
      out.push(target);
  }
  return out;
}

/** Text typed in seconds as the milliseconds the draft holds; anything else is kept as typed. */
export function secondsToMs(text: string): string {
  const value = text.trim();
  if (value === "") return "";
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? String(Math.round(Number(value) * 1000)) : text;
}

/** A draft's milliseconds as seconds; text that is not a whole number of ms is shown as is. */
export function msToSeconds(ms: string): string {
  const value = ms.trim();
  return /^\d+$/.test(value) ? String(Number(value) / 1000) : ms;
}

/** Characters that may sit around a model ID inside a shell command. */
const TOKEN_EDGE = String.raw`[\s"'=]`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `id` appears in `text` as a whole word of a command (not inside a longer name). */
export function hasToken(text: string, id: string): boolean {
  if (id.trim() === "") return false;
  return new RegExp(`(^|${TOKEN_EDGE})${escapeRegExp(id)}(?=$|${TOKEN_EDGE})`).test(text);
}

/**
 * `text` with every whole-word `from` replaced by `to` (the model ID a preset's start command
 * names, after the person types another one). Text without `from` comes back unchanged.
 */
export function replaceToken(text: string, from: string, to: string): string {
  if (from.trim() === "" || from === to) return text;
  return text.replace(
    new RegExp(`(^|${TOKEN_EDGE})${escapeRegExp(from)}(?=$|${TOKEN_EDGE})`, "g"),
    (_match, edge: string) => `${edge}${to}`,
  );
}
