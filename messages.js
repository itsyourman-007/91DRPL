// Log of admin-sent customer emails — what the dashboard's Messages view
// reads and writes. Kept in its own table (admin_messages) since it's a
// different kind of record than an order, even though each one is
// usually tied to one via order_id.

const { getClient } = require('./supabaseClient');

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    to: row.to_email,
    subject: row.subject,
    body: row.body,
    sentAt: new Date(row.sent_at).getTime(),
  };
}

async function logMessage({ orderId, to, subject, body }) {
  const { data, error } = await getClient()
    .from('admin_messages')
    .insert({
      order_id: orderId || null,
      to_email: to,
      subject,
      body,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToMessage(data);
}

async function listMessages(limit = 50) {
  const { data, error } = await getClient()
    .from('admin_messages')
    .select('*')
    .order('sent_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToMessage);
}

module.exports = { logMessage, listMessages };
