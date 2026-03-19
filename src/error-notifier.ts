export function formatErrorMessage(source: string, error: Error): string {
  return `⚠️ Feil i ${source}: ${error.message}\n\nTidspunkt: ${new Date().toISOString()}`;
}

export class ErrorNotifier {
  private sendFn: (message: string) => Promise<void> | void;
  private cooldownMs: number;
  private lastNotified: Map<string, number> = new Map();

  constructor(sendFn: (message: string) => Promise<void> | void, cooldownMs: number = 300000) {
    this.sendFn = sendFn;
    this.cooldownMs = cooldownMs;
  }

  async notify(source: string, error: Error): Promise<void> {
    const key = `${source}:${error.message}`;
    const now = Date.now();
    const last = this.lastNotified.get(key) || 0;

    if (now - last < this.cooldownMs) return;

    this.lastNotified.set(key, now);
    const message = formatErrorMessage(source, error);
    await this.sendFn(message);
  }
}
