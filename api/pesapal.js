const PESAPAL_BASE = 'https://pay.pesapal.com/v3/api';
const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const SITE_URL = 'https://ritzmotelnamusera.com';

async function getToken() {
  const res = await fetch(`${PESAPAL_BASE}/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ consumer_key: CONSUMER_KEY, consumer_secret: CONSUMER_SECRET })
  });
  const data = await res.json();
  if (!data.token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.token;
}

async function getOrRegisterIPN(token) {
  // Check existing IPNs first
  const listRes = await fetch(`${PESAPAL_BASE}/URLSetup/GetIpnList`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  const list = await listRes.json();
  if (Array.isArray(list) && list.length > 0) return list[0].ipn_id;

  // Register new IPN
  const regRes = await fetch(`${PESAPAL_BASE}/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ url: `${SITE_URL}/api/ipn`, ipn_notification_type: 'POST' })
  });
  const reg = await regRes.json();
  return reg.ipn_id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  try {
    const token = await getToken();

    // ── IPN callback from Pesapal ──
    if (action === 'ipn') {
      const { OrderTrackingId, OrderMerchantReference } = req.body;
      // Verify transaction status
      const statusRes = await fetch(
        `${PESAPAL_BASE}/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
      );
      const status = await statusRes.json();
      console.log('IPN received:', { OrderTrackingId, OrderMerchantReference, status: status.payment_status_description });
      return res.status(200).json({ orderNotificationType: 'IPNCHANGE', orderTrackingId: OrderTrackingId, orderMerchantReference: OrderMerchantReference, status: 200 });
    }

    // ── Initiate payment ──
    if (action === 'pay') {
      const { name, phone, room, checkin, checkout, nights, amount, email } = req.body;

      const ipn_id = await getOrRegisterIPN(token);
      const merchant_reference = `RITZ-${Date.now()}`;

      const orderRes = await fetch(`${PESAPAL_BASE}/Transactions/SubmitOrderRequest`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          id: merchant_reference,
          currency: 'UGX',
          amount: Number(amount),
          description: `Ritz Motel: ${room} | ${checkin} to ${checkout} (${nights} night${nights > 1 ? 's' : ''})`,
          callback_url: `${SITE_URL}/booking-confirmed.html`,
          notification_id: ipn_id,
          branch: 'Ritz Motel Namusera',
          billing_address: {
            phone_number: phone.replace(/\s/g, ''),
            email_address: email || 'guest@ritzmotelnamusera.com',
            first_name: name.split(' ')[0],
            last_name: name.split(' ').slice(1).join(' ') || 'Guest',
            country_code: 'UG',
          }
        })
      });

      const order = await orderRes.json();
      if (!order.redirect_url) throw new Error('No redirect URL: ' + JSON.stringify(order));

      return res.status(200).json({
        redirect_url: order.redirect_url,
        merchant_reference,
        order_tracking_id: order.order_tracking_id
      });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Pesapal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
