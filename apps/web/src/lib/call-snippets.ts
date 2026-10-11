/** Copyable examples of calling a callable ID (Models page, Pool · Overview). */

type CallType = "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
export type SnippetKind = "curl" | "openai" | "anthropic";

const TYPE_ENDPOINT: Record<CallType, string> = {
  LLM: "chat/completions",
  EMBEDDINGS: "embeddings",
  TRANSCRIPTION: "audio/transcriptions",
};

/** The Anthropic Messages API serves chat only. */
export function snippetKinds(type: CallType): SnippetKind[] {
  return type === "LLM" ? ["curl", "openai", "anthropic"] : ["curl", "openai"];
}

/** `baseUrl` is the OpenAI-style base (`…/v1`). */
export function curlSnippet(baseUrl: string, callableId: string, type: CallType): string {
  const endpoint = `${baseUrl}/${TYPE_ENDPOINT[type]}`;
  if (type === "TRANSCRIPTION")
    return `curl ${endpoint} \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -F model=${callableId} \\\n  -F file=@audio.wav`;
  const body =
    type === "EMBEDDINGS"
      ? `{"model":"${callableId}","input":"hello"}`
      : `{"model":"${callableId}","messages":[{"role":"user","content":"hello"}]}`;
  return `curl ${endpoint} \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

function openAiSnippet(baseUrl: string, callableId: string, type: CallType): string {
  const head = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}", api_key=os.environ["WSMP_API_KEY"])\n`;
  if (type === "EMBEDDINGS")
    return `${head}result = client.embeddings.create(model="${callableId}", input="hello")\nprint(len(result.data[0].embedding))`;
  if (type === "TRANSCRIPTION")
    return `${head}with open("audio.wav", "rb") as audio:\n    result = client.audio.transcriptions.create(model="${callableId}", file=audio)\nprint(result.text)`;
  return `${head}result = client.chat.completions.create(\n    model="${callableId}",\n    messages=[{"role": "user", "content": "hello"}],\n)\nprint(result.choices[0].message.content)`;
}

function anthropicSnippet(baseUrl: string, callableId: string): string {
  // The Anthropic SDK adds `/v1/messages` itself.
  const root = baseUrl.replace(/\/v1\/?$/, "");
  return `import os\nfrom anthropic import Anthropic\n\nclient = Anthropic(base_url="${root}", api_key=os.environ["WSMP_API_KEY"])\nresult = client.messages.create(\n    model="${callableId}",\n    max_tokens=256,\n    messages=[{"role": "user", "content": "hello"}],\n)\nprint(result.content[0].text)`;
}

export function callSnippet(
  kind: SnippetKind,
  baseUrl: string,
  callableId: string,
  type: CallType,
): string {
  if (kind === "openai") return openAiSnippet(baseUrl, callableId, type);
  if (kind === "anthropic" && type === "LLM") return anthropicSnippet(baseUrl, callableId);
  return curlSnippet(baseUrl, callableId, type);
}
