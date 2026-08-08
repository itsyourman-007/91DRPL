// Order store — backed by Supabase (Postgres).
//
// This used to be an in-memory Map that reset on every restart. It's now
// real persistent storage: orders survive redeploys, restarts, and
// Render's free-tier spin-down. See supabase/schema.sql for the tables
// this expects, and README.md > "Supabase setup" for how to create them.
//
// Every other file in the app only ever calls the functions exported
// here — never Supabase directly — so if you ever swap databases again,
// this is the only file that has to change.

const { getClient } = require('./supabaseClient');

const FULFILLMENT_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];
const RETURN_STATUSES = ['none', 'requested', 'approved', 'rejected', 'refunded'];

function generateOrderId() {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DAB${time}${rand}`;
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    qty: row.qty,
    amount: Number(row.amount),
    orderInfo: {
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      address: row.customer_address,
      city: row.customer_city,
      state: row.customer_state,
      pincode: row.customer_pincode,
    },
    status: row.status, // pending | paid | expired
    fulfillmentStatus: row.fulfillment_status, // processing | shipped | delivered | cancelled
    utr: row.utr,
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    returnStatus: row.return_status, // none | requested | approved | rejected | refunded
    returnReason: row.return_reason,
    refundedAmount: row.refunded_amount != null ? Number(row.refunded_amount) : null,
    refundedAt: row.refunded_at ? new Date(row.refunded_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    paidAt: row.paid_at ? new Date(row.paid_at).getTime() : null,
  };
}

// A pending order past its expiry is treated as expired the moment it's
// read. We also persist that flip in the background (fire-and-forget —
// the caller already has the right answer and shouldn't wait on it) so
// it's correct everywhere else too, including if you look at the table
// directly in Supabase.
function applyExpiry(order) {
  if (order && order.status === 'pending' && Date.now() > order.expiresAt) {
    order.status = 'expired';
    getClient()
      .from('orders')
      .update({ status: 'expired' })
      .eq('id', order.id)
      .then(null, (err) => console.error('expiry persist failed:', err));
  }
  return order;
}

async function createOrder({ qty, amount, orderInfo }) {
  const id = generateOrderId();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { data, error } = await getClient()
    .from('orders')
    .insert({
      id,
      qty,
      amount,
      customer_name: orderInfo.name,
      customer_email: orderInfo.email,
      customer_phone: orderInfo.phone,
      customer_address: orderInfo.address,
      customer_city: orderInfo.city || null,
      customer_state: orderInfo.state || null,
      customer_pincode: orderInfo.pincode || null,
      status: 'pending',
      fulfillment_status: 'processing',
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw error;
  return rowToOrder(data);
}

async function getOrder(id) {
  const { data, error } = await getClient().from('orders').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return applyExpiry(rowToOrder(data));
}

async function listOrders() {
  const { data, error } = await getClient()
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToOrder).map(applyExpiry);
}

async function markPaid(id) {
  const { data, error } = await getClient()
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return rowToOrder(data);
}

async function setUtr(id, utr) {
  const { data, error } = await getClient()
    .from('orders')
    .update({ utr: String(utr).slice(0, 60) })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return rowToOrder(data);
}

// Ships/delivered/cancelled — separate from payment `status`, so the
// dashboard can track fulfilment for orders that are already paid.
async function setFulfillmentStatus(id, fulfillmentStatus) {
  if (!FULFILLMENT_STATUSES.includes(fulfillmentStatus)) {
    throw new Error(`Invalid fulfillment status: ${fulfillmentStatus}`);
  }
  const { data, error } = await getClient()
    .from('orders')
    .update({ fulfillment_status: fulfillmentStatus })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return rowToOrder(data);
}

// Carrier + tracking number for the Shipping view. Either can be cleared
// by passing an empty string.
async function setShipping(id, { trackingNumber, carrier }) {
  const { data, error } = await getClient()
    .from('orders')
    .update({
      tracking_number: trackingNumber || null,
      carrier: carrier || null,
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return rowToOrder(data);
}

// Return / refund workflow for the Returns view. Marking `refunded`
// automatically records the order's full amount and a timestamp — this
// store only ever does full refunds, never partial ones.
async function setReturnStatus(id, { status, reason }) {
  if (!RETURN_STATUSES.includes(status)) {
    throw new Error(`Invalid return status: ${status}`);
  }

  const patch = { return_status: status };
  if (reason !== undefined) patch.return_reason = reason || null;

  if (status === 'refunded') {
    const order = await getOrder(id);
    if (!order) return null;
    patch.refunded_amount = order.amount;
    patch.refunded_at = new Date().toISOString();
  }

  const { data, error } = await getClient()
    .from('orders')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return rowToOrder(data);
}

module.exports = {
  createOrder,
  getOrder,
  listOrders,
  markPaid,
  setUtr,
  setFulfillmentStatus,
  setShipping,
  setReturnStatus,
  FULFILLMENT_STATUSES,
  RETURN_STATUSES,
};
