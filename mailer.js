'use strict';

// Sends Bindr's emails (verification and password-reset codes).
//
// Pick ONE of these in the environment:
//   GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET – free: sends from your own Gmail through a
//                     Google Apps Script (tools/gmail-sender.gs); about 100 emails a day
//   RESEND_API_KEY  – https://resend.com (HTTP API; works on every Railway plan)
//   BREVO_API_KEY   – https://brevo.com  (HTTP API; can send from a single verified address, no domain needed)
//   SMTP_URL        – e.g. smtps://user:pass@smtp.example.com:465 (Railway only allows SMTP on Pro plans)
// plus EMAIL_FROM, e.g. "Bindr <bindr@yourdomain.com>".
//
// With none set, emails aren't sent: the code is written to the server log instead,
// so only whoever runs the server can read it.

const FROM = process.env.EMAIL_FROM || 'Bindr <onboarding@resend.dev>';

function parseFrom(from) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, '') || 'Bindr', email: m[2] } : { name: 'Bindr', email: from.trim() };
}

let smtp = null;
function smtpTransport() {
  if (!smtp) smtp = require('nodemailer').createTransport(process.env.SMTP_URL);
  return smtp;
}

const provider = process.env.GMAIL_SCRIPT_URL ? 'gmail'
  : process.env.RESEND_API_KEY ? 'resend'
  : process.env.BREVO_API_KEY ? 'brevo'
  : process.env.SMTP_URL ? 'smtp'
  : null;

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
}

/** Sends an email. Returns 'sent' or 'logged' (no email service set up). Throws on failure. */
async function sendMail({ to, subject, text, html }) {
  if (provider === 'gmail') {
    // Apps Script answers a POST with a redirect to the result, which fetch follows.
    const res = await fetch(process.env.GMAIL_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.GMAIL_SCRIPT_SECRET || '', to, subject, text, html, name: parseFrom(FROM).name }),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.text().catch(() => '')).trim();
    if (!res.ok || body !== 'ok') throw new Error(`Gmail script: ${res.status} ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  } else if (provider === 'resend') {
    await post('https://api.resend.com/emails', { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      { from: FROM, to: [to], subject, text, html });
  } else if (provider === 'brevo') {
    await post('https://api.brevo.com/v3/smtp/email', { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' },
      { sender: parseFrom(FROM), to: [{ email: to }], subject, textContent: text, htmlContent: html });
  } else if (provider === 'smtp') {
    await smtpTransport().sendMail({ from: FROM, to, subject, text, html });
  } else {
    console.log(`[email] No email service is set up, so this wasn't sent. To ${to}: ${subject}\n${text}`);
    return 'logged';
  }
  return 'sent';
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A short email carrying a one-time code. */
function codeEmail({ intro, code, minutes }) {
  const text = `${intro}\n\nYour code: ${code}\n\nIt expires in ${minutes} minutes. If you didn't ask for this, you can ignore this email.\n\n— Bindr`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px">Bindr</h2>
  <p style="margin:0 0 16px">${escHtml(intro)}</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:0 0 16px;font-family:ui-monospace,Menlo,monospace">${escHtml(code)}</p>
  <p style="color:#555;margin:0">It expires in ${minutes} minutes. If you didn't ask for this, you can ignore this email.</p>
</div>`;
  return { text, html };
}

module.exports = { sendMail, codeEmail, emailProvider: provider };
