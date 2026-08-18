/**
 * mailer.js — sends the password-reset code by real email.
 * ---------------------------------------------------------------------------
 * Configuration is entirely via environment variables (see .env.example),
 * which keeps this file provider-agnostic: Gmail, Outlook, a company mail
 * server, or a transactional API like Resend/SendGrid/Mailgun all speak SMTP,
 * so the SAME code sends through any of them — only the .env values change.
 *
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
 *
 * If those aren't set, `isMailConfigured` is false and the caller (server.js)
 * falls back to printing the code to the console instead — the behaviour this
 * project had before real email existed. That fallback is what makes local
 * development work with zero setup, and it's why nothing here throws just
 * because email isn't configured; it's a supported, deliberate state.
 */
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;

export const isMailConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

// Built once, lazily, so importing this module never touches the network —
// only actually sending (or verifying) a message does.
let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!isMailConfigured) return null;
  if (!transporter) {
    const port = Number(SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      // Port 465 is "implicit TLS" (secure from the first byte); 587/25 start
      // plain and upgrade via STARTTLS. Defaulting secure off unless the port
      // says otherwise, or SMTP_SECURE overrides it, matches what every major
      // provider expects without the operator having to know the distinction.
      secure: SMTP_SECURE ? SMTP_SECURE === 'true' : port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

// Called once at startup (see server.js) purely to log whether the configured
// credentials actually work — SMTP failures are otherwise silent until the
// first real reset request, which is a bad time to discover a typo'd password.
export async function verifyMailer() {
  if (!isMailConfigured) return { ok: false, configured: false };
  try {
    await getTransporter()!.verify();
    return { ok: true, configured: true };
  } catch (e) {
    return { ok: false, configured: true, error: (e as Error).message };
  }
}

// Sends the reset code. Callers should check `isMailConfigured` first — this
// throws rather than silently no-op'ing, so a mistake (calling it when
// unconfigured) is loud in a log rather than a support ticket about a code
// that "never arrived".
export interface ResetCodeEmail {
  /** Recipient address. */
  to: string;
  /** The six-digit code the user must type back in. */
  code: string;
  /** How long the code stays valid, stated in the message body. */
  expiresInMinutes: number;
  /** "CHC Intake" or "Telepathology Console" — names the portal in the subject. */
  portalName: string;
}

export async function sendResetCodeEmail({ to, code, expiresInMinutes, portalName }: ResetCodeEmail) {
  if (!isMailConfigured) throw new Error('sendResetCodeEmail called but SMTP is not configured');

  const subject = `Your ${portalName} password reset code`;
  const text =
    `Your password reset code is: ${code}\n\n` +
    `This code expires in ${expiresInMinutes} minutes and can only be used once.\n\n` +
    `If you didn't request this, you can safely ignore this email — your password hasn't changed.`;

  // Kept deliberately plain (no images, no external links) so it can't be
  // mistaken for a phishing attempt and doesn't depend on remote assets.
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;color:#1e293b">
      <p style="font-size:13px;color:#64748b;margin:0 0 4px">${portalName}</p>
      <h2 style="margin:0 0 16px;font-size:18px">Password reset code</h2>
      <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:0.3em;
                  background:#f1f5f9;border-radius:10px;padding:16px;text-align:center;margin:0 0 16px">
        ${code}
      </div>
      <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0">
        Expires in ${expiresInMinutes} minutes and works once. If you didn't request this,
        no action is needed — your password is unchanged.
      </p>
    </div>`;

  const info = await getTransporter()!.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject,
    text,
    html,
  });

  // `getTestMessageUrl` is harmless to call unconditionally: it only returns
  // a URL when the message actually went through Ethereal's test SMTP
  // service, and `false` for every real provider — so this is a no-op in
  // normal use, but useful when testing this integration itself.
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log(`Email: (Ethereal test account) preview at ${preview}`);

  return info;
}
