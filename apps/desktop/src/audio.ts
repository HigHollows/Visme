/** Utilitaires d'enregistrement audio dans la webview (MediaRecorder). */
import { tr } from "./i18n";

export function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

export async function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

/** Enregistreur simple (une prise) pour les notes vocales. */
export class SimpleRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  mime = "";

  async start(deviceId?: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true });
    this.mime = pickMime();
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }

  stop(): Promise<{ data: string; mime: string }> {
    return new Promise((resolve, reject) => {
      if (!this.rec) return reject(new Error(tr("Pas d'enregistrement en cours")));
      const rec = this.rec;
      rec.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: rec.mimeType || this.mime });
        try { resolve({ data: await blobToBase64(blob), mime: (rec.mimeType || this.mime).split(";")[0] || "audio/webm" }); } catch (e) { reject(e); }
      };
      rec.stop();
      this.rec = null;
    });
  }

  cancel() {
    try { this.rec?.stop(); } catch { /* déjà arrêté */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
  }
}

/**
 * Enregistreur de réunion : le flux est découpé en segments autonomes (nouveau MediaRecorder toutes les 10 minutes),
 * chacun envoyé et écrit sur disque dès qu'il est fini — un incident ne perd que le segment en cours.
 */
export class MeetingRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idx = 0;
  private segStart = 0;
  private startedAt = 0;
  private uploads: Promise<unknown>[] = [];
  private mime = pickMime();

  constructor(
    private meetingId: string,
    private upload: (seg: { idx: number; offsetMs: number; durationMs: number; mime: string; data: string }) => Promise<unknown>,
    private segmentMs = 10 * 60_000,
  ) {}

  async start(deviceId?: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true });
    this.startedAt = Date.now();
    this.next();
  }

  get elapsedMs() {
    return Date.now() - this.startedAt;
  }

  private next() {
    const old = this.rec;
    const rec = new MediaRecorder(this.stream!, { ...(this.mime && { mimeType: this.mime }), audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    const idx = this.idx++;
    const offsetMs = Date.now() - this.startedAt;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || this.mime });
      const durationMs = Date.now() - this.startedAt - offsetMs;
      if (blob.size > 0)
        this.uploads.push(blobToBase64(blob).then((data) => this.upload({ idx, offsetMs, durationMs, mime: (rec.mimeType || this.mime).split(";")[0] || "audio/webm", data })));
    };
    this.rec = rec;
    rec.start();
    // Le nouveau segment démarre avant l'arrêt de l'ancien : aucun trou audio.
    if (old && old.state !== "inactive") old.stop();
    this.timer = setTimeout(() => this.next(), this.segmentMs);
  }

  /** Arrête, attend l'envoi de tous les segments, renvoie la durée totale. */
  async stop(): Promise<number> {
    if (this.timer) clearTimeout(this.timer);
    const duration = this.elapsedMs;
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    await Promise.all(this.uploads);
    return duration;
  }

  abort() {
    if (this.timer) clearTimeout(this.timer);
    try { this.rec?.stop(); } catch { /* déjà arrêté */ }
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
