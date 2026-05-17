// ============================================================
// EMAIL — outbound SMTP via nodemailer.
//
// Reads SMTP creds from env (mirrors DayTrader's pattern on the same
// box so a single Gmail app password covers both apps):
//   SMTP_HOST   — e.g. smtp.gmail.com
//   SMTP_PORT   — e.g. 587
//   SMTP_USER   — full Gmail address
//   SMTP_PASSWORD — 16-char Gmail app password
//   SMTP_FROM   — From: header, defaults to SMTP_USER
//
// If any required var is missing, sendEmail() logs a warning and
// returns false instead of throwing. That keeps dev/test runs (and
// any deployment that hasn't wired SMTP yet) from blowing up — but
// callers should check the return value and surface an error to the
// user if delivery is critical (e.g. account verification).
// ============================================================

import nodemailer, { type Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;
let _warnedMissingConfig = false;

function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !port || !user || !pass) {
    if (!_warnedMissingConfig) {
      console.warn(
        '[email] SMTP not configured (missing SMTP_HOST/PORT/USER/PASSWORD). ' +
        'Outbound email will be skipped.',
      );
      _warnedMissingConfig = true;
    }
    return null;
  }

  _transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    // 465 is implicit-TLS, everything else (587, 25) is STARTTLS.
    secure: Number(port) === 465,
    auth: { user, pass },
  });
  return _transporter;
}

export interface SendEmailParams {
  to:        string;
  subject:   string;
  text:      string;
  html?:     string;
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;

  try {
    await t.sendMail({
      from,
      to:      params.to,
      subject: params.subject,
      text:    params.text,
      html:    params.html,
    });
    return true;
  } catch (err) {
    console.error('[email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

// ============================================================
// Email-verification template.
// ============================================================

export function verificationEmail(params: {
  displayName: string;
  verifyUrl:   string;
}): { subject: string; text: string; html: string } {
  const { displayName, verifyUrl } = params;

  const subject = 'Verify your Fairway Fantasy account';

  const text = `
Hi ${displayName},

Welcome to Fairway Fantasy! Please verify your email address to start picking foursomes.

Click here to verify:
${verifyUrl}

This link expires in 7 days. If you didn't sign up for Fairway Fantasy, you can ignore this email.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 48px; margin-bottom: 8px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 28px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    Hi ${escapeHtml(displayName)},
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    Welcome to Fairway Fantasy. Please verify your email address to start picking foursomes.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(verifyUrl)}"
       style="display: inline-block; padding: 14px 32px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 16px;">
      Verify Email
    </a>
  </div>

  <p style="font-size: 14px; color: #6a6a6a; line-height: 1.5;">
    Or paste this link into your browser:<br/>
    <a href="${escapeHtml(verifyUrl)}" style="color: #2d6a4f; word-break: break-all;">
      ${escapeHtml(verifyUrl)}
    </a>
  </p>

  <p style="font-size: 13px; color: #999999; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid #e0e0e0;">
    This link expires in 7 days. If you didn't sign up for Fairway Fantasy, you can safely ignore this email.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// League-invitation template.
// ============================================================

export function invitationEmail(params: {
  leagueName:  string;
  inviterName: string;
  inviteUrl:   string;
}): { subject: string; text: string; html: string } {
  const { leagueName, inviterName, inviteUrl } = params;

  const subject = `${inviterName} invited you to ${leagueName} on Fairway Fantasy`;

  const text = `
${inviterName} has invited you to join "${leagueName}" on Fairway Fantasy.

Click here to accept the invite and create your account:
${inviteUrl}

Fairway Fantasy is a fantasy-golf league where you pick 4 PGA Tour
golfers each week and the best 3 scores count. The same league link
works for anyone you forward it to.

If you weren't expecting this invitation, you can safely ignore this
email.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 48px; margin-bottom: 8px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 28px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    <strong>${escapeHtml(inviterName)}</strong> has invited you to join
    <strong>${escapeHtml(leagueName)}</strong>.
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    Fairway Fantasy is a fantasy-golf league where you pick 4 PGA Tour
    golfers each week and the best 3 scores count.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(inviteUrl)}"
       style="display: inline-block; padding: 14px 32px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 16px;">
      Accept Invite
    </a>
  </div>

  <p style="font-size: 14px; color: #6a6a6a; line-height: 1.5;">
    Or paste this link into your browser:<br/>
    <a href="${escapeHtml(inviteUrl)}" style="color: #2d6a4f; word-break: break-all;">
      ${escapeHtml(inviteUrl)}
    </a>
  </p>

  <p style="font-size: 13px; color: #999999; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid #e0e0e0;">
    If you weren't expecting this invitation, you can safely ignore this email.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
