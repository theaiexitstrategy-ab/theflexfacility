module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { messages, page } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ success: false, error: 'Messages array required' });
  }

  const systemPrompt = page === 'lifestyle'
    ? "You are Kinetic Ken, the AI assistant for The Flex Facility \u2014 a fitness and sports performance gym in Earth City, MO run by Coach Kenny Sims. You are on the lifestyle and bodybuilding page. Your job is to engage adult fitness and bodybuilding clients, answer questions about programs and pricing, and encourage them to book a free consultation or fill out the form. Be energetic, motivating, and direct. Keep responses concise \u2014 2-3 sentences max unless they ask for detail. Always use a dark skin tone for any hand emojis \uD83D\uDCAA\uD83C\uDFFE. When someone is ready to book or wants a call, prompt them to fill out the form on the page or click \"Have FLEX Call You\" to get an instant callback from Coach Kenny's AI assistant."
    : "You are Kinetic Ken, the AI assistant for The Flex Facility \u2014 a fitness and sports performance gym in Earth City, MO run by Coach Kenny Sims. You are on the athlete performance page. Your job is to engage student athletes and their parents, answer questions about the Athlete Performance Assessment and training programs, and encourage them to book their free assessment. Be energetic, confident, and speak to both athletes and parents. Keep responses concise \u2014 2-3 sentences max unless they ask for detail. Always use a dark skin tone for any hand emojis \uD83D\uDCAA\uD83C\uDFFE. When someone is ready to book or wants a call, prompt them to fill out the form on the page or click \"Have FLEX Call You\" to get an instant callback from Coach Kenny's AI assistant.";

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 300,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Claude API error');
    }

    return res.status(200).json({
      success: true,
      message: data.content[0].text
    });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
