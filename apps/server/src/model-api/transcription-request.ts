import type { TranscriptionCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type {
  MultipartFilePart,
  MultipartPart,
  MultipartScalarPart,
} from "./multipart-form-data.js";

export type TranscriptionRequestProfile = {
  stream: boolean;
  responseFormat?: string;
  timestampGranularities: string[];
  diarizationRequested: boolean;
  languageHints: string[];
  fileMimeType?: string;
  fileSize?: number;
};

export class TranscriptionRequestError extends Error {
  constructor(
    message: string,
    readonly param: string | undefined,
    readonly code: string,
  ) {
    super(message);
    this.name = "TranscriptionRequestError";
  }
}

function scalarValues(formData: FormData, name: string): string[] {
  const values = formData.getAll(name);
  if (values.some((value) => typeof value !== "string")) {
    throw new TranscriptionRequestError(`${name} must be a string.`, name, `invalid_${name}`);
  }
  return values as string[];
}

function singleScalar(formData: FormData, name: string): string | undefined {
  const values = scalarValues(formData, name);
  if (values.length > 1) {
    throw new TranscriptionRequestError(
      `${name} must not be provided more than once.`,
      name,
      `duplicate_${name}`,
    );
  }
  return values[0];
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TranscriptionRequestError(`${name} must be true or false.`, name, `invalid_${name}`);
}

export function transcriptionRequestProfile(formData: FormData): TranscriptionRequestProfile {
  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) {
    throw new TranscriptionRequestError(
      files.length > 1
        ? "file must not be provided more than once."
        : "Missing required file field: file.",
      "file",
      files.length > 1 ? "duplicate_file" : "missing_file",
    );
  }
  const file = files[0];
  const responseFormat = singleScalar(formData, "response_format")?.trim() || undefined;
  const timestampGranularities = [
    ...scalarValues(formData, "timestamp_granularities[]"),
    ...scalarValues(formData, "timestamp_granularities"),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const languageHints = [
    ...scalarValues(formData, "language"),
    ...scalarValues(formData, "languages[]"),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    stream: parseBoolean(singleScalar(formData, "stream"), "stream"),
    responseFormat,
    timestampGranularities,
    diarizationRequested:
      responseFormat === "diarized_json" ||
      parseBoolean(singleScalar(formData, "diarization"), "diarization"),
    languageHints,
    fileMimeType: file.type || undefined,
    fileSize: file.size,
  };
}

export function transcriptionRequestProfileFromParts(
  parts: MultipartPart[],
): TranscriptionRequestProfile {
  const scalarNames = new Set([
    "model",
    "stream",
    "response_format",
    "timestamp_granularities[]",
    "timestamp_granularities",
    "language",
    "languages[]",
    "diarization",
  ]);
  const typeConfused = parts.find(
    (part) =>
      (part.name === "file" && part.kind !== "file") ||
      (scalarNames.has(part.name) && part.kind !== "field"),
  );
  if (typeConfused) {
    throw new TranscriptionRequestError(
      `${typeConfused.name} must be a ${typeConfused.name === "file" ? "file" : "string"}.`,
      typeConfused.name,
      `invalid_${typeConfused.name.replace(/\[\]$/, "")}`,
    );
  }
  const scalarValues = (name: string) =>
    parts
      .filter((part): part is MultipartScalarPart => part.kind === "field" && part.name === name)
      .map((part) => part.value);
  const single = (name: string) => {
    const values = scalarValues(name);
    if (values.length > 1)
      throw new TranscriptionRequestError(
        `${name} must not be provided more than once.`,
        name,
        `duplicate_${name}`,
      );
    return values[0];
  };
  const files = parts.filter(
    (part): part is MultipartFilePart => part.kind === "file" && part.name === "file",
  );
  if (files.length !== 1)
    throw new TranscriptionRequestError(
      files.length > 1
        ? "file must not be provided more than once."
        : "Missing required file field: file.",
      "file",
      files.length > 1 ? "duplicate_file" : "missing_file",
    );
  const file = files[0] as MultipartFilePart;
  const responseFormat = single("response_format")?.trim() || undefined;
  const timestampGranularities = [
    ...scalarValues("timestamp_granularities[]"),
    ...scalarValues("timestamp_granularities"),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const languageHints = [...scalarValues("language"), ...scalarValues("languages[]")]
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    stream: parseBoolean(single("stream"), "stream"),
    responseFormat,
    timestampGranularities,
    diarizationRequested:
      responseFormat === "diarized_json" || parseBoolean(single("diarization"), "diarization"),
    languageHints,
    fileMimeType: file.mimeType || undefined,
    fileSize: file.size,
  };
}

export function transcriptionCapabilityCompatible({
  capability,
  request,
}: {
  capability: TranscriptionCapabilities | undefined;
  request: TranscriptionRequestProfile;
}): boolean {
  const normalizedLanguages = capability?.languages?.map((value) => value.toLowerCase());
  const normalizedMimeTypes = capability?.acceptedMimeTypes?.map((value) => value.toLowerCase());
  if (capability?.supported !== true) return false;
  if (request.stream && capability.streaming !== true) return false;
  if (
    request.responseFormat &&
    request.responseFormat !== "json" &&
    !capability.responseFormats?.includes(request.responseFormat)
  ) {
    return false;
  }
  if (
    request.timestampGranularities.length > 0 &&
    !request.timestampGranularities.every((item) =>
      capability.timestampGranularities?.includes(item),
    )
  ) {
    return false;
  }
  if (request.diarizationRequested && capability.diarization !== true) return false;
  if (request.languageHints.length > 1 && capability.multipleLanguageHints !== true) return false;
  // Omitting `language` asks the upstream to detect it. An explicit false is a
  // known incompatibility; absence remains unknown and is allowed for an
  // otherwise confirmed basic transcription profile.
  if (request.languageHints.length === 0 && capability.languageDetection === false) return false;
  if (
    request.languageHints.length > 0 &&
    (!normalizedLanguages ||
      !request.languageHints.every((item) => normalizedLanguages.includes(item.toLowerCase())))
  ) {
    return false;
  }
  if (
    request.fileSize !== undefined &&
    capability.maxUploadBytes !== undefined &&
    request.fileSize > capability.maxUploadBytes
  ) {
    return false;
  }
  if (
    request.fileMimeType &&
    normalizedMimeTypes &&
    !normalizedMimeTypes.includes(request.fileMimeType.toLowerCase())
  ) {
    return false;
  }
  return true;
}

/** Unknown fallback is deliberately restricted to the least surprising request shape. */
export function isBasicTranscriptionRequest(request: TranscriptionRequestProfile): boolean {
  return (
    !request.stream &&
    (!request.responseFormat || request.responseFormat === "json") &&
    request.timestampGranularities.length === 0 &&
    !request.diarizationRequested &&
    request.languageHints.length === 0
  );
}
