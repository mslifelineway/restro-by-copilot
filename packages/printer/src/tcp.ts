import { Socket } from 'node:net';
import { PrintError, PrinterTransport } from './transport';

/** Raw socket printing (port 9100) used by LAN/Ethernet and most Wi-Fi thermal printers. Node/Electron only. */
export class TcpTransport implements PrinterTransport {
  constructor(private host: string, private port = 9100, private timeoutMs = 5000) {}

  send(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        err ? reject(new PrintError(`${this.host}:${this.port} ${err.message}`)) : resolve();
      };
      sock.setTimeout(this.timeoutMs, () => done(new Error('timed out')));
      sock.once('error', done);
      sock.connect(this.port, this.host, () => {
        // end() flushes and half-closes; resolve once the printer side has received everything
        sock.end(Buffer.from(data), () => done());
      });
    });
  }
}
