// Trainer application intake for /trainers.
// POST { full_name, email, phone, specialty, certifications?, years_experience?, why_flex? }
//   → inserts into public.trainer_applications (client_id: 'flex-facility')
//   → SMS to Coach Kenny (COACH_KENNY_PHONE)  (gated by TRAINER_NOTIFY_ENABLED)
//   → confirmation SMS to applicant            (gated by TRAINER_NOTIFY_ENABLED)
// Returns { success: true, id }. SMS failures don't fail the request.

const REQUIRED = ['full_name', 'email', 'phone', 'specialty'];

function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw).trim().startsWith('+')) return '+' + digits;
  return null;
}

module.exports = async function handler(req, res) {
  // Wrap everything so any thrown error surfaces as structured JSON
  // instead of Vercel's opaque FUNCTION_INVOCATION_FAILED.
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, error: 'method_not_allowed' });
    }

    // Vercel parses application/json bodies automatically, but be tolerant
    // of string bodies in case Content-Type was different.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    for (const k of REQUIRED) {
      if (!body[k] || !String(body[k]).trim()) {
        return res.status(400).json({ success: false, error: `missing_${k}` });
      }
    }

    const applicantPhone = toE164(body.phone);
    if (!applicantPhone) {
      return res.status(400).json({ success: false, error: 'invalid_phone' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      const missing = [];
      if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
      if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
      console.error('[trainer-apply] missing env vars:', missing.join(', '));
      return res.status(500).json({ success: false, error: 'supabase_env_missing', missing });
    }

    let createClient;
    try {
      ({ createClient } = require('@supabase/supabase-js'));
    } catch (e) {
      console.error('[trainer-apply] supabase-js require failed:', e.message);
      return res.status(500).json({ success: false, error: 'supabase_module_missing', detail: e.message });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );

    const { data: inserted, error: insertErr } = await supabase
      .from('trainer_applications')
      .insert({
        client_id: 'flex-facility',
        full_name: String(body.full_name).trim(),
        email: String(body.email).trim(),
        phone: applicantPhone,
        specialty: String(body.specialty).trim(),
        certifications: body.certifications ? String(body.certifications).trim() : null,
        years_experience: body.years_experience ? String(body.years_experience).trim() : null,
        why_flex: body.why_flex ? String(body.why_flex).trim() : null,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[trainer-apply] insert failed:', insertErr);
      return res.status(500).json({ success: false, error: 'insert_failed', detail: insertErr.message });
    }

    // SMS sends are gated. Set TRAINER_NOTIFY_ENABLED=true in Vercel env
    // when you're ready to start texting Kenny + applicants.
    if (process.env.TRAINER_NOTIFY_ENABLED === 'true') {
      try {
        const twilio = require('twilio');
        const firstName = String(body.full_name).trim().split(/\s+/)[0];
        const kennyTo = toE164(process.env.COACH_KENNY_PHONE);
        const fromNumber = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
        const sms = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        const sends = [];
        if (kennyTo && fromNumber) {
          sends.push(
            sms.messages.create({
              from: fromNumber,
              to: kennyTo,
              body: `New trainer application from ${body.full_name} — ${body.specialty}. Check the portal.`,
            }).catch((e) => console.error('[trainer-apply] kenny SMS failed:', e.message))
          );
        } else {
          console.warn('[trainer-apply] skipping kenny SMS: missing COACH_KENNY_PHONE or TWILIO_FROM_NUMBER');
        }

        if (fromNumber) {
          sends.push(
            sms.messages.create({
              from: fromNumber,
              to: applicantPhone,
              body: `Hey ${firstName}! Coach Kenny got your application at The Flex Facility. We'll be in touch soon. 💪🏾`,
            }).catch((e) => console.error('[trainer-apply] applicant SMS failed:', e.message))
          );
        }

        await Promise.all(sends);
      } catch (e) {
        // Never fail the request because of SMS — the row is the source of truth.
        console.error('[trainer-apply] SMS block crashed (ignoring):', e.message);
      }
    }

    return res.status(200).json({ success: true, id: inserted.id });
  } catch (e) {
    console.error('[trainer-apply] uncaught:', e);
    return res.status(500).json({
      success: false,
      error: 'unhandled',
      detail: e?.message || String(e),
    });
  }
};
