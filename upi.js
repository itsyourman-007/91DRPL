const QRCode = require('qrcode');

// Builds a standard UPI "intent" deep link. Any UPI app (GPay, PhonePe,
// Paytm, a bank's own app, etc.) knows how to open this. `tr` (transaction
// reference) carries your order ID into the payer's app and usually shows
// up in both parties' transaction history/statement — that's what makes
// manually matching a bank credit back to an order possible.
function buildUpiLink({ vpa, payeeName, amount, orderId }) {
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `91DAB Order ${orderId}`,
    tr: orderId,
  });
  return `upi://pay?${params.toString()}`;
}

async function buildQrDataUrl(upiLink) {
  return QRCode.toDataURL(upiLink, {
    margin: 1,
    width: 320,
    color: { dark: '#0F2325', light: '#FFFFFF' },
  });
}

module.exports = { buildUpiLink, buildQrDataUrl };
