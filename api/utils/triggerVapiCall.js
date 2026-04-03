const { supabaseInsert } = require('./supabase');
const { toE164 } = require('./sendSms');

/**
 * Trigger an outbound VAPI phone call.
 * Best-effort — never throws; logs failures to console + Supabase.
 */
async function triggerVapiCall({ toPhone, firstName, lastName, segment }) {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  const toFormatted = toE164(toPhone);

  let vapiCallId = null;
  let status = 'initiated';

  try {
    const res = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: {
          number: toFormatted,
          name: `${firstName} ${lastName}`.trim(),
        },
        assistantOverrides: {
          variableValues: {
            firstName,
            segment,
          },
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      vapiCallId = data.id || null;
      status = 'success';
    } else {
      const text = await res.text();
      console.error('VAPI call error:', res.status, text);
      status = 'failed';
    }
  } catch (err) {
    console.error('VAPI call network error:', err.message);
    status = 'failed';
  }

  // Log to Supabase vapi_call_log (best-effort)
  try {
    await supabaseInsert('vapi_call_log', {
      to_number: toFormatted,
      contact_name: `${firstName} ${lastName}`.trim(),
      segment,
      vapi_call_id: vapiCallId,
      status,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('vapi_call_log insert error:', err.message);
  }

  return { status, vapiCallId };
}

module.exports = { triggerVapiCall };
