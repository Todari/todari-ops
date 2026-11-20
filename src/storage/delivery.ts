import { readJsonFile, writeJsonFile } from "./json-file.js";

const RETRY_MS = 60_000;
const RECEIPT_TTL_MS = 7 * 86_400_000;

type State<T> = {
  pending: Record<string, T>;
  delivered: Record<string, number>;
};

/** Persist an accepted request, retry Discord delivery, then retain its receipt. */
export class DeliveryQueue<T> {
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly sent = new Set<string>();
  private draining = false;
  private drainRequested = false;

  constructor(
    private readonly file: string,
    private readonly send: (value: T, id: string) => Promise<void>,
    private readonly group?: (value: T) => string | undefined,
  ) {}

  private read(): State<T> {
    const state = readJsonFile(this.file, { pending: {}, delivered: {} }) as State<T>;
    if (!isRecord(state?.pending) || !isRecord(state.delivered)) {
      throw new Error("Invalid delivery queue");
    }
    return state;
  }

  enqueue(id: string, value: T): void {
    const state = this.read();
    const cutoff = Date.now() - RECEIPT_TTL_MS;
    if (Object.hasOwn(state.pending, id) || state.delivered[id] >= cutoff) return;
    state.delivered = Object.fromEntries(Object.entries(state.delivered).filter(([, at]) => at >= cutoff));
    state.pending[id] = value;
    writeJsonFile(this.file, state);
  }

  attempt(id: string): Promise<boolean> {
    const active = this.inFlight.get(id);
    if (active) return active;
    if ((this.retryAfter.get(id) ?? 0) > Date.now()) return Promise.resolve(false);

    const result = this.deliver(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, result);
    return result;
  }

  private async deliver(id: string): Promise<boolean> {
    try {
      const current = this.read();
      if (!Object.hasOwn(current.pending, id)) return Object.hasOwn(current.delivered, id);
      if (!this.sent.has(id)) {
        await this.send(current.pending[id], id);
        this.sent.add(id);
      }
      const state = this.read();
      delete state.pending[id];
      state.delivered[id] = Date.now();
      writeJsonFile(this.file, state);
      this.sent.delete(id);
      this.retryAfter.delete(id);
      return true;
    } catch (err) {
      this.retryAfter.set(id, Date.now() + RETRY_MS);
      console.warn("[delivery] pending retry", this.file, id, (err as Error).name);
      return false;
    }
  }

  async retry(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        const blocked = new Set<string>();
        for (const [id, item] of Object.entries(this.read().pending)) {
          const group = this.group?.(item);
          if (group && blocked.has(group)) continue;
          if (!(await this.attempt(id)) && group) blocked.add(group);
        }
      } while (this.drainRequested);
    } catch (err) {
      console.warn("[delivery] queue unavailable", this.file, (err as Error).name);
    } finally {
      this.draining = false;
    }
  }

  start(): () => void {
    const timer = setInterval(() => void this.retry(), RETRY_MS);
    timer.unref();
    void this.retry();
    return () => clearInterval(timer);
  }
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
