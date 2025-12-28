import type { PromptRequest } from "@agentclientprotocol/sdk";
import { normalizeBase64DataUrl } from "../text.ts";

export type DroidUserMessageImage = { type: "base64"; data: string; mediaType: string };

export function convertAcpPromptToDroidMessage(prompt: PromptRequest["prompt"]): {
  text: string;
  images: DroidUserMessageImage[];
} {
  const textParts: string[] = [];
  const images: DroidUserMessageImage[] = [];

  for (const chunk of prompt) {
    switch (chunk.type) {
      case "text":
        textParts.push(chunk.text);
        break;

      case "image": {
        const mimeType = chunk.mimeType || "application/octet-stream";
        if (chunk.data) {
          const normalized = normalizeBase64DataUrl(chunk.data, mimeType);
          images.push({
            type: "base64",
            data: normalized.base64,
            mediaType: normalized.mimeType,
          });
        } else if (chunk.uri) {
          textParts.push(`(image: ${chunk.uri})`);
        }
        break;
      }

      case "resource":
        if ("text" in chunk.resource) {
          const contextText = `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`;
          textParts.push(contextText);
        } else if ("blob" in chunk.resource) {
          const mimeType =
            (chunk.resource as { mimeType?: string | null }).mimeType || "application/octet-stream";
          const uri = (chunk.resource as { uri?: string }).uri;
          if (mimeType.startsWith("image/")) {
            const data = (chunk.resource as { blob?: unknown }).blob;
            if (typeof data === "string" && data.length > 0) {
              const normalized = normalizeBase64DataUrl(data, mimeType);
              images.push({
                type: "base64",
                data: normalized.base64,
                mediaType: normalized.mimeType,
              });
            }
          } else {
            const note = uri
              ? `\n<context ref="${uri}">\n(binary resource: ${mimeType})\n</context>`
              : `\n(binary resource: ${mimeType})`;
            textParts.push(note);
          }
        }
        break;

      case "resource_link":
        textParts.push(`@${chunk.uri}`);
        break;

      default:
        break;
    }
  }

  let text = textParts.join("\n").trim();
  if (text.length === 0 && images.length > 0) {
    text = "Please see the attached image(s).";
  }

  return { text, images };
}
