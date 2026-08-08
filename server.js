require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const {
  createOrder,
  getOrder,
  listOrders,
  markPaid,
  setUtr,
  setFulfillmentStatus,
  setShipping,
  setReturnStatus,
} = require('./lib/store');
const { buildUpiLink, buildQrDataUrl } = require('./lib/upi');
const { sendConfirmationEmail, sendCustomMessage } = require('./lib/email');
const { logMessage, listMessages } = require('./lib/messages');
const { buildDashboardStats, buildCustomers, buildReports, buildFinances } = require('./lib/analytics');

const app = express();
// Render (and most hosts) sit behind a proxy that terminates HTTPS, so
// req.secure is false by default even on a live https:// request. This
// tells Express to trust the X-Forwarded-Proto header from that proxy,
// which the login cookie below needs to know whether to set `Secure`.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PRICE_PER_PACK = 500;
const MERCHANT_VPA = process.env.MERCHANT_VPA;
const MERCHANT_NAME = process.env.MERCHANT_NAME || '91DAB';

// =================================================================
// Storefront API — unchanged contract. public/shop.html calls these
// exact three endpoints; nothing about their request/response shape
// changed when the store moved from in-memory to Supabase.
// =================================================================

// POST /api/orders — create a fresh order + a 5-minute UPI QR for it.
// Amount is computed here from qty, never trusted from the client.
app.post('/api/orders', async (req, res) => {
  try {
    const { qty, orderInfo } = req.body || {};

    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }
    if (!orderInfo?.name || !orderInfo?.email || !orderInfo?.phone || !orderInfo?.address) {
      return res.status(400).json({ error: 'Missing delivery details' });
    }
    if (!MERCHANT_VPA) {
      return res.status(500).json({ error: 'MERCHANT_VPA is not configured on the server' });
    }

    const amount = qty * PRICE_PER_PACK;
    const order = await createOrder({ qty, amount, orderInfo });

    const upiLink = buildUpiLink({
      vpa: MERCHANT_VPA,
      payeeName: MERCHANT_NAME,
      amount,
      orderId: order.id,
    });
    const qrDataUrl = await buildQrDataUrl(upiLink);

    res.json({
      orderId: order.id,
      amount,
      upiLink,
      qrDataUrl,
      expiresAt: order.expiresAt,
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// GET /api/orders/:id/status — the buyer's browser polls this.
app.get('/api/orders/:id/status', async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ status: order.status, expiresAt: order.expiresAt });
  } catch (err) {
    console.error('order-status error:', err);
    res.status(500).json({ error: 'Could not load order' });
  }
});

// POST /api/orders/:id/utr — buyer submits their UPI reference number
// (UTR), which is mandatory, so you have something exact to match in
// your bank/UPI app instead of matching on amount + timing alone.
app.post('/api/orders/:id/utr', async (req, res) => {
  try {
    const utr = String(req.body?.utr || '').trim();
    if (!utr) return res.status(400).json({ error: 'UPI reference number is required.' });
    const order = await setUtr(req.params.id, utr);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('set-utr error:', err);
    res.status(500).json({ error: 'Could not save reference number' });
  }
});

// =================================================================
// Admin — cookie-based session, checked by the dashboard's own styled
// login screen instead of the browser's native Basic Auth popup.
//
// There's no session store (no Redis, no DB table) — the cookie itself
// is the session: a signed, expiring token the server can verify
// statelessly. It's signed with ADMIN_PASSWORD as the HMAC key, so
// there's no separate secret to configure, and changing the admin
// password automatically invalidates every existing session.
//
// The dashboard shell (GET /admin) is served to anyone — it's just
// HTML/CSS/JS with no data in it. Every actual byte of data comes from
// /api/admin/*, and every one of those routes is gated by requireAdmin
// below, which checks the cookie. The login screen calls
// GET /api/admin/session on load to find out which state to show.
// =================================================================

const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function sessionSecret() {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error('ADMIN_PASSWORD is not set — admin login is disabled until it is.');
  return secret;
}

function signPayload(b64) {
  return crypto.createHmac('sha256', sessionSecret()).update(b64).digest('base64url');
}

function createSessionToken() {
  const b64 = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
  return `${b64}.${signPayload(b64)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [b64, sig] = token.split('.');
  let expectedSig;
  try {
    expectedSig = signPayload(b64);
  } catch {
    return false; // ADMIN_PASSWORD not configured
  }
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return cookies;
}

function setSessionCookie(req, res, token) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
    'SameSite=Lax',
  ];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (verifySessionToken(parseCookies(req)[SESSION_COOKIE])) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// GET /admin — the dashboard shell. Served to everyone; it carries no
// data of its own, and its own JS shows the login screen or the
// dashboard depending on GET /api/admin/session below.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
});

// GET /api/admin/session — lets the dashboard's boot JS check "am I
// logged in?" without pulling real data.
app.get('/api/admin/session', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// POST /admin/login — { user, password } → sets the session cookie.
app.post('/admin/login', (req, res) => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Admin login is not configured on the server yet.' });
  }
  const { user, password } = req.body || {};
  if (safeEqual(user, process.env.ADMIN_USER) && safeEqual(password, process.env.ADMIN_PASSWORD)) {
    setSessionCookie(req, res, createSessionToken());
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

// POST /admin/logout — clears the session cookie.
//
// Note: this is a stateless signed token, not a server-side session, so
// logout only clears the cookie in the browser that calls it — the token
// itself isn't revoked and would still verify if replayed before it
// naturally expires (12h). That's an acceptable tradeoff for a single
// shared admin password with no session database; if that ever stops
// being true, add a `revoked_at` check against a small sessions table.
app.post('/admin/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---- Dashboard / Orders / Customers ----

// GET /api/admin/stats — everything the Dashboard view renders:
// totals, weekly order/sales bars, monthly revenue trend, recent
// orders, and a fulfillment snapshot.
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    res.json(buildDashboardStats(orders));
  } catch (err) {
    console.error('admin-stats error:', err);
    res.status(500).json({ error: err.message || 'Could not load stats' });
  }
});

// GET /api/admin/orders — the full order list. Backs the Orders,
// Returns, and Shipping views, which all filter this client-side.
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    res.json({ orders });
  } catch (err) {
    console.error('admin-orders error:', err);
    res.status(500).json({ error: err.message || 'Could not load orders' });
  }
});

// GET /api/admin/customers — orders rolled up by buyer email, for the
// Customers view (and the Reports view's "top customers" list).
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    res.json({ customers: buildCustomers(orders) });
  } catch (err) {
    console.error('admin-customers error:', err);
    res.status(500).json({ error: err.message || 'Could not load customers' });
  }
});

// GET /api/admin/orders/export.csv — every order as a CSV download.
app.get('/api/admin/orders/export.csv', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    const header = [
      'Order ID', 'Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Pincode',
      'Qty', 'Amount', 'Status', 'Fulfillment', 'UTR', 'Carrier', 'Tracking Number',
      'Return Status', 'Refunded Amount', 'Created At', 'Paid At',
    ];
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    for (const o of orders) {
      lines.push([
        o.id, o.orderInfo.name, o.orderInfo.email, o.orderInfo.phone, o.orderInfo.address,
        o.orderInfo.city, o.orderInfo.state, o.orderInfo.pincode, o.qty, o.amount,
        o.status, o.fulfillmentStatus, o.utr, o.carrier, o.trackingNumber,
        o.returnStatus, o.refundedAmount,
        new Date(o.createdAt).toISOString(),
        o.paidAt ? new Date(o.paidAt).toISOString() : '',
      ].map(escape).join(','));
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="91dab-orders-${Date.now()}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('admin-export error:', err);
    res.status(500).json({ error: err.message || 'Could not export orders' });
  }
});

// POST /api/admin/orders/:id/confirm — marks paid + sends the invoice email.
app.post('/api/admin/orders/:id/confirm', requireAdmin, async (req, res) => {
  try {
    const order = await markPaid(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    try {
      await sendConfirmationEmail(order);
    } catch (err) {
      console.error('Email send failed:', err);
      // Order is still marked paid even if the email fails — don't block
      // fulfilment on email deliverability. Check server logs if this happens.
    }
    res.json({ ok: true, order });
  } catch (err) {
    console.error('admin-confirm error:', err);
    res.status(500).json({ error: err.message || 'Could not confirm order' });
  }
});

// POST /api/admin/orders/:id/fulfillment — update shipping status
// (processing / shipped / delivered / cancelled) for a paid order.
app.post('/api/admin/orders/:id/fulfillment', requireAdmin, async (req, res) => {
  try {
    const order = await setFulfillmentStatus(req.params.id, req.body?.status);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true, order });
  } catch (err) {
    console.error('admin-fulfillment error:', err);
    res.status(400).json({ error: err.message || 'Could not update fulfillment status' });
  }
});

// ---- Shipping ----

// POST /api/admin/orders/:id/shipping — carrier + tracking number, for
// the Shipping view.
app.post('/api/admin/orders/:id/shipping', requireAdmin, async (req, res) => {
  try {
    const { trackingNumber, carrier } = req.body || {};
    const order = await setShipping(req.params.id, { trackingNumber, carrier });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true, order });
  } catch (err) {
    console.error('admin-shipping error:', err);
    res.status(400).json({ error: err.message || 'Could not update shipping info' });
  }
});

// ---- Returns ----

// POST /api/admin/orders/:id/return — start or progress a return
// (none → requested → approved/rejected → refunded). Marking `refunded`
// records the order's full amount automatically — see lib/store.js.
app.post('/api/admin/orders/:id/return', requireAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    const order = await setReturnStatus(req.params.id, { status, reason });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true, order });
  } catch (err) {
    console.error('admin-return error:', err);
    res.status(400).json({ error: err.message || 'Could not update return status' });
  }
});

// ---- Messages ----

// GET /api/admin/messages — every admin-sent email, most recent first.
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  try {
    const messages = await listMessages();
    res.json({ messages });
  } catch (err) {
    console.error('admin-list-messages error:', err);
    res.status(500).json({ error: err.message || 'Could not load messages' });
  }
});

// POST /api/admin/messages — send a free-form email to a customer
// (via Resend) and log it.
app.post('/api/admin/messages', requireAdmin, async (req, res) => {
  try {
    const { orderId, to, subject, body } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }
    await sendCustomMessage({ to, subject, body });
    const message = await logMessage({ orderId, to, subject, body });
    res.json({ ok: true, message });
  } catch (err) {
    console.error('admin-send-message error:', err);
    res.status(500).json({ error: err.message || 'Could not send message' });
  }
});

// ---- Reports & Finances ----

// GET /api/admin/reports — confirmation/return rates, repeat customers,
// top customers, and an order-status breakdown.
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    const customers = buildCustomers(orders);
    res.json(buildReports(orders, customers));
  } catch (err) {
    console.error('admin-reports error:', err);
    res.status(500).json({ error: err.message || 'Could not load reports' });
  }
});

// GET /api/admin/finances — gross/net revenue, refunds, monthly trend.
app.get('/api/admin/finances', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    res.json(buildFinances(orders));
  } catch (err) {
    console.error('admin-finances error:', err);
    res.status(500).json({ error: err.message || 'Could not load finances' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`91DAB store running on port ${PORT}`));
