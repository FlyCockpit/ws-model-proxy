import { describe, expect, it } from "vitest";

import {
  fillTargets,
  hasToken,
  msToSeconds,
  replaceToken,
  secondsToMs,
} from "./runtime-preset-fill";

describe("fillTargets", () => {
  it("names each path by the input that holds it, never by the raw path", () => {
    expect(
      fillTargets([
        "models[0].id",
        "models[0].embeddingContract",
        "launch.commands[0].start",
        "launch.resources[0]",
      ]),
    ).toEqual([
      { labelKey: "runtime.specForm.modelId", target: "model-0" },
      { labelKey: "runtime.specForm.fillEmbedding", target: "model-0-embedding-revision" },
      { labelKey: "runtime.specForm.fillCommand.start", target: "command-0-start" },
      { labelKey: "runtime.specForm.sections.size", target: "resource-0-kind" },
    ]);
  });

  it("points a whole command entry at its start command and folds duplicates", () => {
    expect(fillTargets(["launch.commands[0]", "launch.commands[0].start"])).toEqual([
      { labelKey: "runtime.specForm.commands", target: "command-0-start" },
      { labelKey: "runtime.specForm.fillCommand.start", target: "command-0-start" },
    ]);
    expect(fillTargets(["address.baseUrl", "engine", "address.baseUrl"])).toEqual([
      { labelKey: "runtime.specForm.baseUrl", target: "base-url" },
      { labelKey: "runtime.specForm.engine", target: "engine" },
    ]);
  });

  it("sends the transcription profile to its note and anything unknown to the JSON view", () => {
    expect(fillTargets(["models[0].transcription", "launch.secrets"])).toEqual([
      { labelKey: "runtime.specForm.fillTranscription", target: "transcription" },
      { labelKey: "runtime.specForm.fillOther", target: "view" },
    ]);
  });
});

describe("seconds and milliseconds", () => {
  it("reads typed seconds as milliseconds", () => {
    expect(secondsToMs("15")).toBe("15000");
    expect(secondsToMs(" 1.5 ")).toBe("1500");
    expect(secondsToMs("1.")).toBe("1000");
    expect(secondsToMs(".25")).toBe("250");
    expect(secondsToMs("")).toBe("");
  });

  it("keeps text that is not a number as typed, so validation names it", () => {
    expect(secondsToMs("abc")).toBe("abc");
    expect(secondsToMs("1e3")).toBe("1e3");
  });

  it("shows whole milliseconds as seconds and anything else as is", () => {
    expect(msToSeconds("900000")).toBe("900");
    expect(msToSeconds("1500")).toBe("1.5");
    expect(msToSeconds("")).toBe("");
    expect(msToSeconds("abc")).toBe("abc");
  });
});

describe("the model ID inside a start command", () => {
  const start =
    "vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port {{port}} --served-model-name Qwen/Qwen3-8B";

  it("replaces every whole-word use", () => {
    expect(replaceToken(start, "Qwen/Qwen3-8B", "Qwen/Qwen3-32B")).toBe(
      "vllm serve Qwen/Qwen3-32B --host 127.0.0.1 --port {{port}} --served-model-name Qwen/Qwen3-32B",
    );
  });

  it("leaves a longer name that merely starts with the ID alone", () => {
    expect(replaceToken("ollama pull llama3.2-vision", "llama3.2", "qwen3")).toBe(
      "ollama pull llama3.2-vision",
    );
    expect(hasToken("ollama pull llama3.2-vision", "llama3.2")).toBe(false);
  });

  it("matches IDs in quotes and after an equals sign, and treats regex characters literally", () => {
    expect(replaceToken(`run --model="a.b+c" x`, "a.b+c", "d")).toBe(`run --model="d" x`);
    expect(replaceToken("--model=a.b+c", "a.b+c", "d")).toBe("--model=d");
    expect(hasToken("axbxc", "a.b")).toBe(false);
  });

  it("does nothing for an empty ID", () => {
    expect(replaceToken(start, "", "x")).toBe(start);
    expect(hasToken(start, " ")).toBe(false);
  });
});
