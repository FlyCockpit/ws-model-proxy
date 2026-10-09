/**
 * Built-in starting points (`runtimes.presets.list`). Each spec is complete and valid as is
 * (`runtime-presets.test.ts` parses every one); `fill` names the fields a person or agent should
 * change before creating. Single-node presets bind 127.0.0.1 (owner decision round 3, #6).
 *
 * Lives in `packages/api` rather than `packages/config` (contract note) because the specs are
 * typed by `runtimeSpecSchema`, which `packages/config` cannot import.
 */
import type { RUNTIME_PRESETS } from "../contracts/runtimes";
import type { RuntimeSpec } from "./runtime-spec";

export type RuntimePresetId = (typeof RUNTIME_PRESETS)[number];
export type RuntimePreset = {
  id: RuntimePresetId;
  kind: "ALWAYS_ON" | "STARTABLE";
  spec: RuntimeSpec;
  fill: string[];
};

const HEALTH = { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 } as const;
const READINESS = { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 } as const;

/** The languages vLLM's Whisper accepts as a `language` hint (ISO 639-1). */
const WHISPER_LANGUAGES = [
  "af",
  "ar",
  "az",
  "be",
  "bg",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gl",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "kk",
  "kn",
  "ko",
  "lt",
  "lv",
  "mi",
  "mk",
  "mr",
  "ms",
  "ne",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "sw",
  "ta",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
];

const COMPOSE = "docker compose -f /path/to/compose.yaml";

export const RUNTIME_PRESET_LIST: readonly RuntimePreset[] = [
  {
    id: "detected",
    kind: "ALWAYS_ON",
    spec: {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    },
    fill: ["address.baseUrl", "engine"],
  },
  {
    id: "vllm",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "vllm",
      modelType: "llm",
      models: [{ id: "Qwen/Qwen3-8B" }],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
        labels: [],
        commands: [
          {
            start:
              "vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port {{port}} --gpu-memory-utilization {{memory_fraction}}",
          },
        ],
        readiness: READINESS,
        health: HEALTH,
      },
    },
    fill: ["models[0].id", "launch.commands[0].start", "launch.resources[0]"],
  },
  {
    id: "vllm_transcription",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "vllm",
      modelType: "transcription",
      models: [
        {
          id: "openai/whisper-large-v3-turbo",
          transcription: {
            streaming: true,
            responseFormats: ["json", "text", "verbose_json"],
            languages: WHISPER_LANGUAGES,
            // vLLM's default upload limit (VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=25).
            maxUploadBytes: 25 * 1024 * 1024,
            // Whisper has no realtime route; each committed turn goes to the file route.
            realtime: { adapter: "segmented", maxItemSeconds: 30 },
            // `languageDetection` stays unknown: older vLLM releases assume English when a
            // request names no language.
          },
        },
      ],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "discrete", gpuCount: 1, vramGb: 12 }],
        labels: [],
        commands: [
          {
            start:
              "vllm serve openai/whisper-large-v3-turbo --host 127.0.0.1 --port {{port}} --gpu-memory-utilization {{memory_fraction}}",
          },
        ],
        readiness: READINESS,
        health: HEALTH,
      },
    },
    fill: [
      "models[0].id",
      "models[0].transcription",
      "launch.commands[0].start",
      "launch.resources[0]",
    ],
  },
  {
    id: "vllm_embeddings",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "vllm",
      modelType: "embeddings",
      models: [
        {
          id: "Qwen/Qwen3-Embedding-0.6B",
          // vLLM's embed pooler L2-normalizes by default. Pin `revision` (and `--revision` in the
          // start command) to a commit: a moving branch does not identify a vector space.
          embeddingContract: {
            model: "Qwen/Qwen3-Embedding-0.6B",
            revision: "main",
            dimensions: 1024,
            normalization: "l2",
            vectorSpace: "Qwen/Qwen3-Embedding-0.6B",
          },
        },
      ],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "discrete", gpuCount: 1, vramGb: 8 }],
        labels: [],
        commands: [
          {
            // `--runner pooling` (vLLM 0.10.2+) replaces `--task embed`: the model's architecture
            // is a causal LM, so vLLM would otherwise serve it for generation.
            start:
              "vllm serve Qwen/Qwen3-Embedding-0.6B --runner pooling --max-model-len 8192 --host 127.0.0.1 --port {{port}} --gpu-memory-utilization {{memory_fraction}}",
          },
        ],
        readiness: READINESS,
        health: HEALTH,
      },
    },
    fill: [
      "models[0].id",
      "models[0].embeddingContract",
      "launch.commands[0].start",
      "launch.resources[0]",
    ],
  },
  {
    id: "sglang",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "sglang",
      modelType: "llm",
      models: [{ id: "Qwen/Qwen3-8B" }],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
        labels: [],
        commands: [
          {
            start:
              "python -m sglang.launch_server --model-path Qwen/Qwen3-8B --host 127.0.0.1 --port {{port}} --mem-fraction-static {{memory_fraction}}",
          },
        ],
        readiness: READINESS,
        health: HEALTH,
      },
    },
    fill: ["models[0].id", "launch.commands[0].start", "launch.resources[0]"],
  },
  {
    id: "llama_cpp",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "llama_cpp",
      modelType: "llm",
      models: [{ id: "local-gguf" }],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "unified", memoryGb: 16 }],
        labels: [],
        commands: [
          {
            start:
              "llama-server -m /path/to/model.gguf --alias local-gguf --host 127.0.0.1 --port {{port}}",
          },
        ],
        readiness: { path: "/health", expectedStatus: 200, timeoutMs: 600_000 },
        health: HEALTH,
      },
    },
    fill: ["models[0].id", "launch.commands[0].start", "launch.resources[0]"],
  },
  {
    id: "ollama_service",
    kind: "STARTABLE",
    spec: {
      api: "openai",
      engine: "ollama",
      modelType: "llm",
      models: [{ id: "llama3.2" }],
      launch: {
        management: "service",
        groupSize: 1,
        resources: [{ kind: "unified", memoryGb: 8 }],
        labels: [],
        port: { fixed: 11434 },
        commands: [
          {
            start: "systemctl start ollama",
            stop: "systemctl stop ollama",
            status: "systemctl is-active --quiet ollama",
          },
        ],
        readiness: READINESS,
        health: HEALTH,
      },
    },
    fill: ["models[0].id", "launch.resources[0]"],
  },
  {
    id: "systemd_unit",
    kind: "STARTABLE",
    spec: {
      launch: {
        management: "service",
        groupSize: 1,
        resources: [{ kind: "none" }],
        labels: [],
        commands: [
          {
            start: "systemctl start my-service",
            stop: "systemctl stop my-service",
            status: "systemctl is-active --quiet my-service",
          },
        ],
        health: HEALTH,
      },
    },
    fill: ["launch.commands[0]"],
  },
  {
    // A Compose project the node starts and stops as a service; `-f` names the project.
    id: "docker_compose",
    kind: "STARTABLE",
    spec: {
      launch: {
        management: "service",
        groupSize: 1,
        resources: [{ kind: "none" }],
        labels: [],
        commands: [
          {
            start: `${COMPOSE} up -d`,
            stop: `${COMPOSE} down`,
            // 0 while a container of the project runs, 3 (stopped) when none does, and 1
            // (unknown) when docker itself fails: a pipe would turn that failure into "stopped".
            status: `out=$(${COMPOSE} ps --status running -q) || exit 1; [ -n "$out" ] || exit 3`,
          },
        ],
        health: HEALTH,
      },
    },
    fill: ["launch.commands[0]"],
  },
];
