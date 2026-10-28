import { createServer, Server } from 'node:net';
import { AddressInfo } from 'node:net';
import { EscPosBuilder, PrintSpooler, PrintError, PrinterTransport, toPrinterText } from '../src';
import { TcpTransport } from '../src/tcp';

describe('EscPosBuilder', () => {
  it('emits init, text, alignment, bold and a partial cut', () => {
    const b = new EscPosBuilder(32).init().align('center').bold().line('CAFE').bold(false).cut().build();
    expect([...b]).toEqual([
      0x1b, 0x40,              // init
      0x1b, 0x61, 1,           // center
      0x1b, 0x45, 1,           // bold on
      0x43, 0x41, 0x46, 0x45, 0x0a, // "CAFE\n"
      0x1b, 0x45, 0,           // bold off
      0x1b, 0x64, 3,           // feed 3
      0x1d, 0x56, 0x42, 0,     // partial cut
    ]);
  });

  it('formats a two-column row to the paper width and truncates long left text', () => {
    const text = (s: string) => Buffer.from(new EscPosBuilder(20).row(s, 'Rs.100.00').build()).toString('ascii');
    expect(text('Paneer')).toBe('Paneer     Rs.100.00\n');
    expect(text('Very long item name here')).toHaveLength(21);
    expect(text('Very long item name here').endsWith('Rs.100.00\n')).toBe(true);
  });

  it('maps unprintable characters safely', () => {
    expect(toPrinterText('₹250 – “ok” café')).toBe('Rs.250 - "ok" caf?');
  });

  it('builds QR and cash-drawer commands', () => {
    const qr = [...new EscPosBuilder().qr('upi://pay?pa=x', 6).build()];
    expect(qr.slice(0, 4)).toEqual([0x1d, 0x28, 0x6b, 4]);
    expect(qr.slice(-8)).toEqual([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]);
    expect([...new EscPosBuilder().openDrawer().build()]).toEqual([0x1b, 0x70, 0, 50, 250]);
  });
});

describe('PrintSpooler', () => {
  const job = (id: string) => ({ id, kind: 'kot', data: Uint8Array.from([1, 2, 3]) });
  const noSleep = () => Promise.resolve();

  it('prints jobs strictly in order', async () => {
    const sent: string[] = [];
    const t: PrinterTransport = { send: async (d) => { await new Promise((r) => setTimeout(r, d[0] === 1 ? 20 : 0)); sent.push(String(d[0])); } };
    const s = new PrintSpooler(t, { sleep: noSleep });
    await Promise.all([
      s.enqueue({ id: 'a', kind: 'kot', data: Uint8Array.from([1]) }),
      s.enqueue({ id: 'b', kind: 'kot', data: Uint8Array.from([2]) }),
    ]);
    expect(sent).toEqual(['1', '2']);
  });

  it('retries with exponential backoff and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const t: PrinterTransport = { send: async () => { if (++calls < 3) throw new PrintError('offline'); } };
    const s = new PrintSpooler(t, { baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
    await s.enqueue(job('x'));
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(s.deadLetters).toHaveLength(0);
  });

  it('dead-letters after max attempts without blocking later jobs', async () => {
    const events: string[] = [];
    const t: PrinterTransport = { send: async (d) => { if (d[0] === 9) throw new PrintError('paper out'); } };
    const s = new PrintSpooler(t, { maxAttempts: 2, sleep: noSleep, onEvent: (e) => events.push(`${e.job.id}:${e.status}`) });
    const bad = s.enqueue({ id: 'bad', kind: 'kot', data: Uint8Array.from([9]) });
    const good = s.enqueue({ id: 'good', kind: 'kot', data: Uint8Array.from([1]) });
    await expect(bad).rejects.toThrow(/paper out/);
    await expect(good).resolves.toBeUndefined();
    expect(s.deadLetters.map((j) => j.id)).toEqual(['bad']);
    expect(events).toContain('bad:failed');
    expect(events).toContain('good:done');
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const s = new PrintSpooler({ send: async () => { calls++; throw new PrintError('bad data', false); } }, { sleep: noSleep });
    await expect(s.enqueue(job('x'))).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('TcpTransport (fake LAN printer)', () => {
  let server: Server;
  let received: Buffer[] = [];
  const listen = () => new Promise<number>((res) => {
    server = createServer((sock) => { const chunks: Buffer[] = []; sock.on('data', (c) => chunks.push(c)); sock.on('end', () => received.push(Buffer.concat(chunks))); });
    server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port));
  });
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('delivers the exact bytes to a printer on port N', async () => {
    received = [];
    const port = await listen();
    const bytes = new EscPosBuilder().init().line('HELLO').cut().build();
    await new TcpTransport('127.0.0.1', port).send(bytes);
    await new Promise((r) => setTimeout(r, 30));
    expect([...received[0]]).toEqual([...bytes]);
  });

  it('fails with a retryable PrintError when the printer is unreachable', async () => {
    const port = await listen();
    await new Promise<void>((r) => server.close(() => r())); // port now closed
    const err = await new TcpTransport('127.0.0.1', port, 500).send(Uint8Array.from([1])).catch((e) => e);
    expect(err).toBeInstanceOf(PrintError);
    expect(err.retryable).toBe(true);
  });

  it('spooler + TCP: printer comes back online mid-retry and the job still prints', async () => {
    received = [];
    // reserve a port, close it (printer "off"), then start listening again after the first failed attempt
    const first = await listen();
    await new Promise<void>((r) => server.close(() => r()));
    let restarted = false;
    const spooler = new PrintSpooler(new TcpTransport('127.0.0.1', first, 300), {
      baseDelayMs: 10,
      sleep: async (ms) => {
        if (!restarted) {
          restarted = true;
          await new Promise<void>((r) => { server = createServer((sock) => { const c: Buffer[] = []; sock.on('data', (d) => c.push(d)); sock.on('end', () => received.push(Buffer.concat(c))); }); server.listen(first, '127.0.0.1', r); });
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    await spooler.enqueue({ id: 'k1', kind: 'kot', data: new EscPosBuilder().line('TABLE 4').build() });
    await new Promise((r) => setTimeout(r, 30));
    expect(Buffer.concat(received).toString('ascii')).toContain('TABLE 4');
  });
});
