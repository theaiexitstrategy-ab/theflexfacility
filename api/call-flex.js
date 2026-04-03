const { supabaseInsert } = require('./utils/supabase');
const { sendSms } = require('./utils/sendSms');
const { triggerVapiCall } = require('./utils/triggerVapiCall');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, phone, source } = req.body || {};

    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Save to leads_athlete as a call request
    try {
      await supabaseInsert('leads_athlete', {
        name,
        first_name: firstName,
        last_name: lastName,
        phone,
        source: source || 'flex_call_button',
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Supabase insert error:', err.message);
    }

    // Trigger VAPI outbound call immediately
    try {
      const result = await triggerVapiCall({
        toPhone: phone,
        firstName,
        lastName,
        segment: 'athlete',
      });
      console.log('VAPI call triggered:', result.status, result.vapiCallId);
    } catch (err) {
      console.error('VAPI call error:', err.message);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('call-flex unhandled error:', err.message);
    return res.status(200).json({ success: true });
  }
};
