const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { stripe_session_id, email, phone, full_name, ...purchaseData } = req.body;

  if (!stripe_session_id || !email) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // Idempotency check
    const { data: existing } = await supabase
      .from('purchases_ebook')
      .select('id')
      .eq('stripe_session_id', stripe_session_id)
      .single();

    if (existing) {
      return res.status(200).json({ success: true, message: 'Already recorded.' });
    }

    // Insert purchase
    const { error: purchaseError } = await supabase
      .from('purchases_ebook')
      .insert({
        stripe_session_id,
        email,
        phone,
        full_name,
        ...purchaseData
      });
    if (purchaseError) throw purchaseError;

    // Add to contacts_master if not already there
    if (phone) {
      const { data: existingContact } = await supabase
        .from('contacts_master')
        .select('id')
        .eq('phone', phone)
        .single();

      if (!existingContact) {
        const nameParts = (full_name || '').split(' ');
        const { error: contactError } = await supabase
          .from('contacts_master')
          .insert({
            first_name: nameParts[0] || '',
            last_name: nameParts.slice(1).join(' ') || '',
            email,
            phone,
            contact_type: 'Lifestyle',
            segment: 'Lifestyle & Bodybuilding',
            source: 'Ebook Purchase'
          });
        if (contactError) throw contactError;
      }
    }

    // Update delivery status to Sent (download page is being shown)
    await supabase
      .from('purchases_ebook')
      .update({ delivery_status: 'Sent' })
      .eq('stripe_session_id', stripe_session_id);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Purchase error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
