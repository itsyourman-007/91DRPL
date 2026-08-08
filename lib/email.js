const { Resend } = require('resend');

// Built lazily (on first send, not at import time) — mirrors
// lib/supabaseClient.js. If we constructed this at the top of the file,
// a missing/invalid RESEND_API_KEY would throw the moment server.js
// requires this module, which crashes the *entire* process before
// Express even starts listening — taking down checkout, the QR
// endpoint, and the admin dashboard along with it, even though none of
// those actually need email to work.
let resend = null;

function getResendClient() {
  if (resend) return resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured — cannot send email.');
  }
  resend = new Resend(apiKey);
  return resend;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function invoiceHtml(order) {
  const { id, qty, amount, orderInfo } = order;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0F2325;">
    <h2 style="color:#146B70;margin-bottom:4px;">Order confirmed — 91DAB</h2>
    <p>Hi ${orderInfo.name}, thanks for your order — we've received your payment and your DAB pack is being prepared for shipping.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #DCE6E7;">Order ID</td>
        <td style="padding:8px 0;border-bottom:1px solid #DCE6E7;text-align:right;font-family:monospace;">${id}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #DCE6E7;">DAB — Dental Aerosol Blocker × ${qty} pack(s)</td>
        <td style="padding:8px 0;border-bottom:1px solid #DCE6E7;text-align:right;">₹${amount}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-weight:bold;">Total paid</td>
        <td style="padding:8px 0;text-align:right;font-weight:bold;">₹${amount}</td>
      </tr>
    </table>
    <p style="margin-bottom:4px;"><strong>Shipping to</strong></p>
    <p style="margin-top:0;color:#3A5254;">
      ${orderInfo.address}<br>
      ${orderInfo.city}, ${orderInfo.state} - ${orderInfo.pincode}<br>
      ${orderInfo.phone}
    </p>
    <p style="color:#557;font-size:13px;">Expect delivery in 3–5 business days. Reply to this email or write to dantaresearch@gmail.com if you have any questions.</p>
  </div>`;
}

async function sendConfirmationEmail(order) {
  const { error } = await getResendClient().emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: order.orderInfo.email,
    subject: `Order confirmed — 91DAB (${order.id})`,
    html: invoiceHtml(order),
  });
  if (error) throw new Error(error.message || 'Resend failed to send the confirmation email');
}

// Free-form email to a customer — used by the admin dashboard's Messages
// view for anything outside the automatic order-confirmation email above
// (a shipping update, answering a question, a return follow-up, etc).
async function sendCustomMessage({ to, subject, body }) {
  const paragraphs = String(body)
    .split('\n')
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 12px;">${escapeHtml(line)}</p>`)
    .join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0F2325;">
    <h2 style="color:#146B70;margin-bottom:16px;">91DAB</h2>
    ${paragraphs}
    <p style="color:#557;font-size:13px;margin-top:20px;">Reply to this email or write to dantaresearch@gmail.com if you have any questions.</p>
  </div>`;

  const { error } = await getResendClient().emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  });
  if (error) throw new Error(error.message || 'Resend failed to send the message');
}

module.exports = { sendConfirmationEmail, sendCustomMessage };
