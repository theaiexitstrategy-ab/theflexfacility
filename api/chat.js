const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Kinetic Ken, the AI assistant for The Flex Facility — an elite athletic performance and lifestyle training gym in St. Louis, MO run by Coach Kenny.

Your personality:
- Energetic, motivating, and knowledgeable about fitness and athletic training
- You speak with confidence and genuine care for people's goals
- Keep responses concise (2-3 sentences max unless asked for detail)
- Use casual, encouraging tone — like a coach texting a client

What you know about The Flex Facility:
- Elite athletic performance training and lifestyle/bodybuilding coaching
- Run by Coach Kenny
- Located in St. Louis, MO
- Website: theflexfacility.com
- Booking link: book.theflexfacility.com
- Phone: 1-877-515-FLEX (3539)
- Two main tracks: Athlete Performance (/) and Lifestyle & Bodybuilding (/fit)

Your job:
- Answer questions about the facility, training, and programs
- Encourage visitors to book a free assessment at book.theflexfacility.com
- If someone shares their goals, be supportive and suggest booking a call with Coach Kenny
- Never make up specific pricing, schedules, or details you don't know — instead direct them to book a call
- If asked something unrelated to fitness/the facility, briefly redirect back to how you can help with their fitness goals`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Keep only the last 20 messages to stay within context limits
    const trimmedMessages = messages.slice(-20);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: trimmedMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', response.status, errText);
      return res.status(200).json({
        reply: "Hey! I'm having a quick technical hiccup. You can reach Coach Kenny directly at 1-877-515-FLEX or book at book.theflexfacility.com!",
      });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "I'm here to help! What can I tell you about The Flex Facility?";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat handler error:', err.message);
    return res.status(200).json({
      reply: "Hey! I'm having a quick technical hiccup. You can reach Coach Kenny directly at 1-877-515-FLEX or book at book.theflexfacility.com!",
    });
  }
};
