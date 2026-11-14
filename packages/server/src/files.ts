// File upload (POST /api/files, streamed to `<dataDir>/files/<id>`) and download (GET /api/files/:id).
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { FileRef, TranscriptResponse } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { CORS_HEADERS, HttpError, nonEmptyParam } from "./http";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export async function postFile(ctx: BusContext, req: Request, url: URL): Promise<{ file: FileRef }> {
  const { hub } = ctx;
  const from = nonEmptyParam(url, "from");
  const uploader = from ? hub.knownParticipant(from.toLowerCase()) : undefined;
  if (uploader) ctx.checkWriter(req, uploader);
  if (!from || !hub.knownParticipant(from.toLowerCase())) {
    throw new HttpError(400, `Unknown participant "${from ?? ""}". Known ids: ${hub.knownIds().join(", ")}`);
  }
  const name = nonEmptyParam(url, "name");
  if (!name) throw new HttpError(400, "name query parameter is required");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 200 MB");
  if (!req.body) throw new HttpError(400, "Body is empty");

  const id = `f_${crypto.randomUUID().replaceAll("-", "")}`;
  const finalPath = path.join(ctx.filesDir, id);
  const tempPath = `${finalPath}.part`;
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tempPath).writer();
  let size = 0;
  const reader = req.body.getReader();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 200 MB");
      hasher.update(chunk.value);
      writer.write(chunk.value);
    }
    await writer.end();
  } catch (error) {
    await writer.end();
    rmSync(tempPath, { force: true });
    throw error;
  }
  renameSync(tempPath, finalPath);
  const file: FileRef = {
    id,
    name: path.basename(name),
    size,
    mimeType: req.headers.get("content-type") || "application/octet-stream",
    sha256: hasher.digest("hex"),
  };
  ctx.db.insertFile(file, from.toLowerCase());
  return { file };
}

export function getFile(ctx: BusContext, fileId: string): Response {
  const file = ctx.db.getFile(fileId);
  const blobPath = path.join(ctx.filesDir, fileId);
  if (!file || !existsSync(blobPath)) throw new HttpError(404, `Unknown file "${fileId}"`);
  return new Response(Bun.file(blobPath), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": file.mimeType,
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      // Uploaded files never run as the bus's website (an HTML or SVG upload opened in a tab would otherwise act
      // with the viewer's session): no MIME sniffing, and a sandbox without scripts or same-origin access.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}

/**
 * POST /api/files/:id/transcript: the text of an uploaded voice message, from the speech-to-text service at `sttUrl`
 * (packages/stt). 503 when the bus has none, 502 when it fails or cannot decode the audio.
 */
export async function transcribeFile(ctx: BusContext, fileId: string, sttUrl: string | undefined): Promise<TranscriptResponse> {
  if (!sttUrl) throw new HttpError(503, "This bus has no speech-to-text service (serve --stt-url)");
  const file = ctx.db.getFile(fileId);
  const blobPath = path.join(ctx.filesDir, fileId);
  if (!file || !existsSync(blobPath)) throw new HttpError(404, `Unknown file "${fileId}"`);
  if (!file.mimeType.startsWith("audio/")) throw new HttpError(400, `${file.name} is not audio (${file.mimeType})`);
  let res: Response;
  try {
    // The bus's own names (agents, people), so speech-to-text writes "message-bus" and "compactor", not look-alike words.
    const names = ctx.hub.knownIds().join(" ");
    res = await fetch(`${sttUrl.replace(/\/+$/, "")}/transcribe?${new URLSearchParams({ hotwords: names })}`, { method: "POST", body: Bun.file(blobPath) });
  } catch (error) {
    throw new HttpError(502, `Speech-to-text service unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TranscriptResponse> & { error?: string };
  if (!res.ok || typeof body.text !== "string") throw new HttpError(502, `Speech to text failed: ${body.error ?? `HTTP ${res.status}`}`);
  return { text: body.text, language: body.language ?? "", duration: body.duration ?? 0 };
}
