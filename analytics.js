// Turns the flat list of orders from lib/store.js into the numbers the
// admin dashboard displays. Deliberately pure — no I/O, just arrays in,
// objects out — so it's easy to reason about and cheap to recompute on
// every request. If order volume ever gets large enough for this to
// matter, this is the piece you'd move into a SQL aggregate/RPC; nothing
// else in the app would need to change.

const WEEKS_TO_SHOW = 12;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FULFILLMENT_PERCENT = {
  processing: 25,
  shipped: 65,
  delivered: 100,
  cancelled: 0,
};

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // back to Monday
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + diff);
  return d;
}

function buildWeeklySeries(orders, weeks = WEEKS_TO_SHOW) {
  const thisWeekStart = startOfWeek(new Date());
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(thisWeekStart);
    start.setDate(start.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    buckets.push({ start, end, orders: 0, sales: 0 });
  }

  for (const o of orders) {
    const t = new Date(o.createdAt);
    const bucket = buckets.find((b) => t >= b.start && t < b.end);
    if (!bucket) continue;
    bucket.orders += 1;
    if (o.status === 'paid') bucket.sales += o.amount;
  }

  return buckets.map((b, i) => ({
    label: `W${i + 1}`,
    isCurrent: i === buckets.length - 1,
    orders: b.orders,
    sales: Math.round(b.sales),
  }));
}

function buildMonthlySeries(orders) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const lastYear = thisYear - 1;
  const thisYearRevenue = Array(12).fill(0);
  const lastYearRevenue = Array(12).fill(0);

  for (const o of orders) {
    if (o.status !== 'paid') continue;
    const d = new Date(o.paidAt || o.createdAt);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (y === thisYear) thisYearRevenue[m] += o.amount;
    else if (y === lastYear) lastYearRevenue[m] += o.amount;
  }

  return MONTH_LABELS.map((label, i) => ({
    label,
    revenue: Math.round(thisYearRevenue[i]),
    revenuePrevYear: Math.round(lastYearRevenue[i]),
  }));
}

function buildTotals(orders) {
  const paid = orders.filter((o) => o.status === 'paid');
  const pending = orders.filter((o) => o.status === 'pending');
  const expired = orders.filter((o) => o.status === 'expired');
  const totalRevenue = paid.reduce((sum, o) => sum + o.amount, 0);

  return {
    totalOrders: orders.length,
    paidOrders: paid.length,
    pendingOrders: pending.length,
    expiredOrders: expired.length,
    totalRevenue: Math.round(totalRevenue),
    avgOrderValue: paid.length ? Math.round(totalRevenue / paid.length) : 0,
  };
}

function buildFulfillment(orders, limit = 8) {
  return orders
    .filter((o) => o.status === 'paid')
    .slice(0, limit)
    .map((o) => ({
      id: o.id,
      buyer: o.orderInfo?.name || '—',
      fulfillmentStatus: o.fulfillmentStatus || 'processing',
      percent: FULFILLMENT_PERCENT[o.fulfillmentStatus] ?? 25,
    }));
}

function buildRecentOrders(orders, limit = 8) {
  return orders.slice(0, limit).map((o) => ({
    id: o.id,
    buyer: o.orderInfo?.name || '—',
    email: o.orderInfo?.email || '',
    qty: o.qty,
    total: o.amount,
    status: o.status,
    fulfillmentStatus: o.fulfillmentStatus || 'processing',
    createdAt: o.createdAt,
  }));
}

function buildCustomers(orders) {
  const byEmail = new Map();
  for (const o of orders) {
    const email = o.orderInfo?.email;
    if (!email) continue;
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        name: o.orderInfo.name,
        phone: o.orderInfo.phone,
        city: o.orderInfo.city,
        state: o.orderInfo.state,
        orders: 0,
        totalSpent: 0,
        lastOrderAt: o.createdAt,
      });
    }
    const c = byEmail.get(email);
    c.orders += 1;
    if (o.status === 'paid') c.totalSpent += o.amount;
    if (o.createdAt > c.lastOrderAt) c.lastOrderAt = o.createdAt;
  }
  return [...byEmail.values()]
    .map((c) => ({ ...c, totalSpent: Math.round(c.totalSpent) }))
    .sort((a, b) => b.lastOrderAt - a.lastOrderAt);
}

function buildDashboardStats(orders) {
  return {
    totals: buildTotals(orders),
    weekly: buildWeeklySeries(orders),
    monthly: buildMonthlySeries(orders),
    recentOrders: buildRecentOrders(orders),
    fulfillment: buildFulfillment(orders),
  };
}

// ---- Reports view ----

function buildStatusBreakdown(orders) {
  const total = orders.length || 1;
  const counts = { paid: 0, pending: 0, expired: 0 };
  orders.forEach((o) => {
    if (counts[o.status] !== undefined) counts[o.status] += 1;
  });
  return Object.keys(counts).map((status) => ({
    status,
    count: counts[status],
    percent: Math.round((counts[status] / total) * 100),
  }));
}

function buildReports(orders, customers) {
  const paid = orders.filter((o) => o.status === 'paid');
  const confirmationRate = orders.length ? Math.round((paid.length / orders.length) * 100) : 0;
  const avgOrderValue = paid.length
    ? Math.round(paid.reduce((sum, o) => sum + o.amount, 0) / paid.length)
    : 0;
  const repeatCustomers = customers.filter((c) => c.orders > 1).length;
  const returned = orders.filter((o) => o.returnStatus && o.returnStatus !== 'none');
  const returnRate = paid.length ? Math.round((returned.length / paid.length) * 100) : 0;
  const topCustomers = [...customers].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 8);

  return {
    confirmationRate,
    avgOrderValue,
    repeatCustomers,
    returnRate,
    topCustomers,
    statusBreakdown: buildStatusBreakdown(orders),
  };
}

// ---- Finances view ----

function buildFinances(orders) {
  const paid = orders.filter((o) => o.status === 'paid');
  const grossRevenue = paid.reduce((sum, o) => sum + o.amount, 0);
  const refunded = orders
    .filter((o) => o.returnStatus === 'refunded')
    .reduce((sum, o) => sum + (o.refundedAmount || 0), 0);

  return {
    grossRevenue: Math.round(grossRevenue),
    refunded: Math.round(refunded),
    netRevenue: Math.round(grossRevenue - refunded),
    ordersPaid: paid.length,
    monthly: buildMonthlySeries(orders),
  };
}

module.exports = { buildDashboardStats, buildCustomers, buildReports, buildFinances };
