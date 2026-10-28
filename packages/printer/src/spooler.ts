import { PrintError, PrinterTransport } from './transport';

export interface PrintJob {
  id: string;
  /** e.g. 'kot' | 'receipt' | 'invoice'. Informational; used in events and reports. */
  kind: string;
  data: Uint8Array;
}

export type JobStatus = 'queued' | 'printing' | 'done' | 'failed';
export interface SpoolEvent { job: PrintJob; status: JobStatus; attempt: number; error?: string }

export interface SpoolerOptions {
  /** total attempts per job, including the first (default 5) */
  maxAttempts?: number;
  /** first retry delay in ms, doubled each attempt up to maxDelayMs (default 500 / 8000) */
  baseDelayMs?: number;
  maxDelayMs?: number;
  onEvent?: (e: SpoolEvent) => void;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * FIFO print queue for ONE printer: jobs print strictly in order (a KOT must never overtake the one
 * before it), failures retry with exponential backoff, and jobs that exhaust their attempts land in
 * `deadLetters` for the UI to show "reprint" / "mark done". The queue is in-memory; the POS app persists
 * pending jobs itself (SQLite outbox) and re-enqueues on start.
 */
export class PrintSpooler {
  private queue: { job: PrintJob; resolve: () => void; reject: (e: Error) => void }[] = [];
  private running = false;
  readonly deadLetters: PrintJob[] = [];
  private o: Required<Omit<SpoolerOptions, 'onEvent'>> & Pick<SpoolerOptions, 'onEvent'>;

  constructor(private transport: PrinterTransport, opts: SpoolerOptions = {}) {
    this.o = {
      maxAttempts: opts.maxAttempts ?? 5,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 8000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onEvent: opts.onEvent,
    };
  }

  get pending() { return this.queue.length; }

  /** Resolves when the job has printed; rejects (and dead-letters it) after the last failed attempt. */
  enqueue(job: PrintJob): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.o.onEvent?.({ job, status: 'queued', attempt: 0 });
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let item = this.queue[0]; item; item = this.queue[0]) {
        await this.run(item);
        this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async run({ job, resolve, reject }: { job: PrintJob; resolve: () => void; reject: (e: Error) => void }) {
    let lastError = '';
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      this.o.onEvent?.({ job, status: 'printing', attempt });
      try {
        await this.transport.send(job.data);
        this.o.onEvent?.({ job, status: 'done', attempt });
        return resolve();
      } catch (e) {
        lastError = (e as Error).message;
        const retryable = !(e instanceof PrintError) || e.retryable;
        if (!retryable || attempt === this.o.maxAttempts) break;
        await this.o.sleep(Math.min(this.o.baseDelayMs * 2 ** (attempt - 1), this.o.maxDelayMs));
      }
    }
    this.deadLetters.push(job);
    this.o.onEvent?.({ job, status: 'failed', attempt: this.o.maxAttempts, error: lastError });
    reject(new PrintError(`Job ${job.id} failed: ${lastError}`, false));
  }
}
