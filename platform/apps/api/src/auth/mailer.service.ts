import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@browser-monitor/shared';
import nodemailer, { type Transporter } from 'nodemailer';

import { API_CONFIG } from '../infrastructure/tokens.js';

@Injectable()
export class MailerService {
  private readonly transporter: Transporter;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
        : {}),
    });
  }

  async sendVerification(email: string, token: string): Promise<void> {
    const url = new URL('/verify-email', this.config.PUBLIC_BASE_URL);
    url.searchParams.set('token', token);
    await this.send(email, 'Verify your Browser Monitor account', `Verify your email: ${url}`);
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    const url = new URL('/reset-password', this.config.PUBLIC_BASE_URL);
    url.searchParams.set('token', token);
    await this.send(email, 'Reset your Browser Monitor password', `Reset your password: ${url}`);
  }

  async sendInvitation(email: string, token: string, projectName: string): Promise<void> {
    const url = new URL('/accept-invitation', this.config.PUBLIC_BASE_URL);
    url.searchParams.set('token', token);
    await this.send(email, `Join ${projectName} on Browser Monitor`, `Accept the invitation: ${url}`);
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.transporter.sendMail({ from: this.config.SMTP_FROM, to, subject, text });
  }
}

