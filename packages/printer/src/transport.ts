/** Delivers raw bytes to a printer. Implementations: TcpTransport (LAN), Bluetooth/USB (React Native app). */
export interface PrinterTransport {
  send(data: Uint8Array): Promise<void>;
}

export class PrintError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}
