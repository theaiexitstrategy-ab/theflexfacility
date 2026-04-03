const { supabaseInsert } = require('./utils/supabase');
const { sendSms } = require('./utils/sendSms');
const { triggerVapiCall } = require('./utils/triggerVapiCall');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('lead-athlete called, body:', JSON.stringify(req.body));

    const {
      name,
      athlete_age,
      parent_name,
      phone,
      email,
      instagram,
      program_interest,
      primary_goal,
      source,
    } = req.body || {};

    // Derive first/last name from the single "name" field
    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // 1. Save lead to Supabase
    try {
      await supabaseInsert('leads_athlete', {
        name,
        first_name: firstName,
        last_name: lastName,
        athlete_age: athlete_age || null,
        parent_name: parent_name || null,
        phone: phone || null,
        email: email || null,
        instagram: instagram || null,
        program_interest: program_interest || null,
        primary_goal: primary_goal || null,
        source: source || 'funnel-athlete',
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
          body: `Hey ${firstName}! 👋🏾 Coach Kenny got your info and will be reaching out shortly. In the meantime, check your options at theflexfacility.com. Reply STOP to opt out.`,
          eventType: 'athlete_lead_confirmation',
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
          body: `New Athlete Lead 🔥 ${firstName} ${lastName} | Phone: ${phone} | Email: ${email || 'N/A'} | Sport: ${primary_goal || 'N/A'}. They just submitted on theflexfacility.com.`,
          eventType: 'athlete_lead_coach_alert',
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
            segment: 'athlete',
          });
        } catch (err) {
          console.error('VAPI call error:', err.message);
        }
      }, 10_000);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('lead-athlete unhandled error:', err.message);
    return res.status(200).json({ success: true });
  }
};
