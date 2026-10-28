/**
 * Minimal ESC/POS command builder. Pure (no I/O, no Node APIs) so it can run in the React Native
 * POS app as well as on the server. Produces raw bytes; transports deliver them.
 *
 * Text is limited to what thermal printers print by default (ASCII + CP437 extras are NOT assumed).
 * The rupee sign has no code point in common code pages, so it is printed as "Rs." — real glyph
 * support (image/raster or CP858 variants) needs per-printer-model testing in the hardware spike.
 */
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

export type Align = 'left' | 'center' | 'right';

export function toPrinterText(s: string): string {
  return s
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

export class EscPosBuilder {
  private bytes: number[] = [];

  /** @param columns characters per line for the paper (58 mm ≈ 32, 80 mm ≈ 48) */
  constructor(readonly columns = 48) {}

  private push(...b: number[]) { this.bytes.push(...b); return this; }

  /** ESC @ — reset printer state. Always start a job with this. */
  init() { return this.push(ESC, 0x40); }

  text(s: string) { for (const ch of toPrinterText(s)) this.bytes.push(ch.charCodeAt(0)); return this; }
  line(s = '') { return this.text(s).push(LF); }
  feed(n = 1) { return this.push(ESC, 0x64, Math.min(Math.max(n, 0), 255)); }

  align(a: Align) { return this.push(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
  bold(on = true) { return this.push(ESC, 0x45, on ? 1 : 0); }
  underline(on = true) { return this.push(ESC, 0x2d, on ? 1 : 0); }
  /** GS ! n — character size multiplier 1..8 (width, height). */
  size(width = 1, height = 1) {
    const w = Math.min(Math.max(width, 1), 8) - 1, h = Math.min(Math.max(height, 1), 8) - 1;
    return this.push(GS, 0x21, (w << 4) | h);
  }

  /** "Left ........ Right" on one line, truncating the left part if needed. Money values should be pre-formatted. */
  row(left: string, right: string) {
    const l = toPrinterText(left), r = toPrinterText(right);
    const room = Math.max(this.columns - r.length - 1, 0);
    return this.line(l.slice(0, room).padEnd(this.columns - r.length, ' ') + r);
  }
  rule(ch = '-') { return this.line(ch.repeat(this.columns)); }

  /** GS ( k — QR code, model 2. size = module size 1..16. */
  qr(data: string, size = 6, ecc: 'L' | 'M' | 'Q' | 'H' = 'M') {
    const d = Buffer.from(toPrinterText(data), 'ascii');
    const len = d.length + 3;
    return this
      .push(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0) // model 2
      .push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(Math.max(size, 1), 16))
      .push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, { L: 48, M: 49, Q: 50, H: 51 }[ecc])
      .push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...d)
      .push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
  }

  /** GS V — cut. Feeds a few lines first so the text clears the blade. */
  cut(partial = true) { return this.feed(3).push(GS, 0x56, partial ? 0x42 : 0x41, 0); }

  /** ESC p — pulse the cash drawer (pin 0 or 1). */
  openDrawer(pin: 0 | 1 = 0) { return this.push(ESC, 0x70, pin, 50, 250); }

  build(): Uint8Array { return Uint8Array.from(this.bytes); }
}
