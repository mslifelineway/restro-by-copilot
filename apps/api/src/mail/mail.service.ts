import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { config } from '../config';

export interface MailMessage { to: string; subject: string; text: string; html?: string }

/**
 * Sends email. `console` transport (dev/test) logs the message and keeps the last 100 in memory so tests and the
 * dev outbox endpoint can read reset links; it is refused in production unless explicitly chosen via MAIL_TRANSPORT.
 */
@Injectable()
export class MailService {
  private log = new Logger('Mail');
  readonly outbox: (MailMessage & { at: Date })[] = [];
  private smtp?: Transporter;

  async send(m: MailMessage): Promise<void> {
    if (config.mailTransport === 'smtp') {
      this.smtp ??= createTransport(config.smtpUrl);
      await this.smtp.sendMail({ from: config.mailFrom, ...m });
      this.log.log(`sent "${m.subject}"`); // never log recipients' secrets or message bodies in smtp mode
      return;
    }
    this.outbox.push({ ...m, at: new Date() });
    if (this.outbox.length > 100) this.outbox.shift();
    this.log.log(`[console transport] to=${m.to} subject="${m.subject}"\n${m.text}`);
  }
}
