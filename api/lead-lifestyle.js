const { supabaseInsert } = require('./utils/supabase');
const { sendSms } = require('./utils/sendSms');
const { triggerVapiCall } = require('./utils/triggerVapiCall');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      primary_goal,
      training_type,
      interests,
      source,
    } = req.body || {};

    const firstName = (first_name || '').trim();
    const lastName = (last_name || '').trim();

    // 1. Save lead to Supabase
    try {
      await supabaseInsert('leads_lifestyle', {
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        phone: phone || null,
        primary_goal: primary_goal || null,
        training_type: training_type || null,
        interests: interests || null,
        source: source || 'funnel-lifestyle',
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Supabase lead insert error:', err.message);
    }

    // 2. Send SMS to the lead
    if (phone) {
      try {
        await sendSms({
          to: phone,
          body: `Hey ${firstName}! 💪🏾 Coach Kenny got your info and will be in touch soon. Ready to see what's possible? theflexfacility.com/fit. Reply STOP to opt out.`,
          eventType: 'lifestyle_lead_confirmation',
        });
      } catch (err) {
        console.error('Lead SMS error:', err.message);
      }
    }

    // 3. Send SMS to Coach Kenny
    if (phone) {
      try {
        await sendSms({
          to: process.env.COACH_KENNY_PHONE,
          body: `New Lifestyle Lead 💥 ${firstName} ${lastName} | Phone: ${phone} | Email: ${email || 'N/A'} | Goal: ${primary_goal || 'N/A'}. Submitted on theflexfacility.com/fit.`,
          eventType: 'lifestyle_lead_coach_alert',
        });
      } catch (err) {
        console.error('Coach SMS error:', err.message);
      }
    }

    // 4. Trigger VAPI outbound call after 10s delay (best-effort)
    if (phone) {
      setTimeout(async () => {
        try {
          await triggerVapiCall({
            toPhone: phone,
            firstName,
            lastName,
            segment: 'lifestyle',
          });
        } catch (err) {
          console.error('VAPI call error:', err.message);
        }
      }, 10_000);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('lead-lifestyle unhandled error:', err.message);
    return res.status(200).json({ success: true });
  }
};
