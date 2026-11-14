// POST /api/speech {text}: a message read aloud, as WAV, by a text-to-speech server (serve --tts-url): LFM3-Audio run by
// llama-server, whose /tts takes {input, voice, lang, response_format}. On bariton that is Hilde's speech server.
import { CORS_HEADERS, HttpError, readJsonObject } from "./http";

/** Longer text is cut here: the website reads one message at a time, and a reader waits for the whole file. */
export const MAX_SPEECH_CHARS = 4000;

/** Turkish when the text has Turkish letters, else English. */
function language(text: string): "tr" | "en" {
  return /[çğışöüÇĞİŞÖÜ]/.test(text) ? "tr" : "en";
}

/** What a listener should hear: no markdown signs, code or link addresses. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/https?:\/\/\S+/g, " (link) ")
    .replace(/@\{([^}]*)\}/g, "$1")
    .replace(/[*_`#>|@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function postSpeech(req: Request, ttsUrl: string | undefined): Promise<Response> {
  if (!ttsUrl) throw new HttpError(503, "This bus has no text-to-speech server (serve --tts-url)");
  const body = await readJsonObject(req);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text must be a non-empty string");
  const text = plain(body.text).slice(0, MAX_SPEECH_CHARS);
  let res: Response;
  try {
    res = await fetch(`${ttsUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, voice: "female", lang: language(text), response_format: "wav" }),
    });
  } catch (error) {
    throw new HttpError(502, `Text-to-speech server unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new HttpError(502, `Text to speech failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return new Response(res.body, { headers: { ...CORS_HEADERS, "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
}
