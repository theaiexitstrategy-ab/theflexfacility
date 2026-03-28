// Requires STRIPE_SECRET_KEY environment variable set in the Vercel dashboard
const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ valid: false });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const isComplete = session.status === 'complete';
    const createdAt = session.created * 1000;
    const isRecent = Date.now() - createdAt < 24 * 60 * 60 * 1000;

    if (isComplete && isRecent) {
      return res.status(200).json({
        valid: true,
        email: session.customer_details?.email || null,
      });
    }

    return res.status(200).json({ valid: false });
  } catch (error) {
    return res.status(200).json({ valid: false });
  }
};
