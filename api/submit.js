const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { type, phone, ...formData } = req.body;

  if (!type || !['athlete', 'lifestyle'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Invalid type. Must be "athlete" or "lifestyle".' });
  }

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Missing phone' });
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const table = type === 'athlete' ? 'leads_athlete' : 'leads_lifestyle';
  const contactType = type === 'athlete' ? 'Athlete' : 'Lifestyle';
  const segment = type === 'athlete' ? 'Athlete & Parent' : 'Lifestyle & Bodybuilding';

  try {
    const { data: existing } = await supabase
      .from(table)
      .select('id')
      .eq('phone', cleanPhone)
      .single();

    if (existing) {
      const { error } = await supabase
        .from(table)
        .update({ ...formData, updated_at: new Date().toISOString() })
        .eq('phone', cleanPhone);
      if (error) throw error;
    } else {
      const { error: leadError } = await supabase
        .from(table)
        .insert({ phone: cleanPhone, ...formData, lead_status: 'New' });
      if (leadError) throw leadError;

      const { data: existingContact } = await supabase
        .from('contacts_master')
        .select('id')
        .eq('phone', cleanPhone)
        .single();

      if (!existingContact) {
        const { error: contactError } = await supabase
          .from('contacts_master')
          .insert({
            phone: cleanPhone,
            first_name: formData.first_name,
            last_name: formData.last_name,
            email: formData.email,
            contact_type: contactType,
            segment,
            source: formData.source
          });
        if (contactError) throw contactError;
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
