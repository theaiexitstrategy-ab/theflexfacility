const { supabaseInsert } = require('./supabase');

/**
 * Format a phone number to E.164 (+1XXXXXXXXXX).
 * Handles formats like (314) 555-1234, 314-555-1234, 3145551234, +13145551234.
 */
function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.startsWith('+')) return phone.replace(/[^\d+]/g, '');
  return `+${digits}`;
}

/**
 * Send an SMS via the Twilio REST API (no SDK).
 * Logs every attempt to the Supabase sms_log table.
 */
async function sendSms({ to, body, eventType }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  const toFormatted = toE164(to);

  const params = new URLSearchParams();
  params.append('To', toFormatted);
  params.append('From', from);
  params.append('Body', body);

  let status = 'sent';
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error('Twilio SMS error:', text);
      status = 'failed';
    }
  } catch (err) {
    console.error('Twilio SMS network error:', err.message);
    status = 'failed';
  }

  // Log to Supabase sms_log (best-effort)
  try {
    await supabaseInsert('sms_log', {
      to_number: toFormatted,
      message_body: body,
      event_type: eventType || 'lead_sms',
      status,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('sms_log insert error:', err.message);
  }

  return { status };
}

module.exports = { sendSms, toE164 };
