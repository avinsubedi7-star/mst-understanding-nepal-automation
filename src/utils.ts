import crypto from "node:crypto";

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function answerLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

export function stableQuestionHash(question: string, options: string[], visualHash = ""): string {
  const normalized = [normalizeText(question), ...options.map(normalizeText), visualHash].join("\u241f");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function bufferHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
