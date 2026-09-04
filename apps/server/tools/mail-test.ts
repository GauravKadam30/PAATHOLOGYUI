/**
 * mail-test.ts — check the SMTP settings without running the app.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: the only other way to find out whether email works is to
 * start the server, open the console, request a password reset, and wait to
 * see if anything arrives. That is a slow loop for something almost everyone
 * gets wrong once or twice — and when nothing arrives it does not tell you
 * WHICH part was wrong.
 *
 * Usage (from apps/server):
 *
 *   npm run mail:test                      # connect and authenticate only
 *   npm run mail:test -- you@example.com   # also send a real message there
 *
 * Sending is opt-in because a test that quietly emails someone every time it
 * runs is a nuisance.
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { isMailConfigured, verifyMailer, explainSmtpError } from '../mailer.ts';

const recipient = process.argv[2];

function show(label: string, value: string | undefined, { secret = false } = {}): void {
  // Never print the password. Its LENGTH is the useful part: Gmail App
  // Passwords are 16 characters, so "12" or "24" immediately explains a
  // rejected login that would otherwise look like a mystery.
  const shown = value === undefined || value === ''
    ? '(not set)'
    : secret ? `(set, ${value.replace(/\s/g, '').length} characters)` : value;
  console.log(`  ${label.padEnd(12)} ${shown}`);
}

console.log('\nSMTP configuration');
show('HOST', process.env.SMTP_HOST);
show('PORT', process.env.SMTP_PORT || '587 (default)');
show('SECURE', process.env.SMTP_SECURE || `${Number(process.env.SMTP_PORT) === 465} (from port)`);
show('USER', process.env.SMTP_USER);
show('PASS', process.env.SMTP_PASS, { secret: true });
show('FROM', process.env.MAIL_FROM || process.env.SMTP_USER);

if (!isMailConfigured) {
  console.error('\nNot configured. SMTP_HOST, SMTP_USER and SMTP_PASS must all be set');
  console.error('in apps/server/.env — see .env.example. Until then, reset codes');
  console.error('print to the server console instead of being emailed.\n');
  process.exit(1);
}

// Step 1: can we reach the server and authenticate at all? This catches the
// overwhelming majority of mistakes without sending anything.
console.log('\nConnecting…');
const result = await verifyMailer();
if (!result.ok) {
  console.error(`\nFAILED\n\n${result.error}\n`);
  process.exit(1);
}
console.log('Connected and authenticated.');

if (!recipient) {
  console.log('\nPass an address to send a real test message:');
  console.log('  npm run mail:test -- you@example.com\n');
  process.exit(0);
}

// Step 2: an actual send. Authentication succeeding does not guarantee
// delivery — the account may still be blocked from sending, or the message
// may be rejected for its content.
console.log(`\nSending a test message to ${recipient}…`);
try {
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: 'Telepathology Console — SMTP test',
    text: 'If you are reading this, password reset codes will reach this inbox.\n',
  });
  console.log(`Sent. Message id: ${info.messageId}`);
  console.log('\nCheck the inbox — and the spam folder. Mail sent from a personal');
  console.log('account through a home connection is often filtered the first time.\n');
} catch (e) {
  console.error(`\nSEND FAILED\n\n${explainSmtpError(e as Error)}\n`);
  process.exit(1);
}
