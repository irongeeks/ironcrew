/**
 * IronCrew — Email NotificationChannel.
 *
 * Sends over real SMTP via nodemailer — no placeholder, no console.log
 * stand-in. `createTransport` is injectable so tests never open a real
 * socket, same posture as VaultwardenSecretProvider's injectable CliRunner.
 */

import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { ChannelConnectionStatus, ChannelMessage, NotificationChannel } from "./notification-channel.ts";

export interface EmailChannelOptions {
  host: string;
  port: number;
  /** Defaults to true for port 465, false otherwise (STARTTLS is negotiated automatically on other ports). */
  secure?: boolean;
  user?: string;
  pass?: string;
  /** Envelope From address. */
  from: string;
  /** Where notifications are delivered. */
  to: string;
  /** Injectable for tests — defaults to nodemailer.createTransport. */
  createTransport?: (opts: SMTPTransport.Options) => Transporter<SMTPTransport.SentMessageInfo>;
}

export class EmailChannel implements NotificationChannel {
  readonly kind = "email" as const;

  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;
  private readonly from: string;
  private readonly to: string;
  private readonly host: string;
  private readonly port: number;

  constructor(opts: EmailChannelOptions) {
    this.from = opts.from;
    this.to = opts.to;
    this.host = opts.host;
    this.port = opts.port;
    const factory = opts.createTransport ?? nodemailer.createTransport;
    this.transporter = factory({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }

  async send(message: ChannelMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: this.to,
      subject: `[IronCrew] ${message.title}`,
      text: message.body,
    });
  }

  async testConnection(): Promise<ChannelConnectionStatus> {
    try {
      await this.transporter.verify();
      return { ok: true, message: `SMTP erreichbar unter ${this.host}:${this.port}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
