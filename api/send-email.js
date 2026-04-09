export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, toName, subject, html } = req.body;

  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
  }

  const apiKey    = process.env.BREVO_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  const fromName  = process.env.FROM_NAME || 'Family Reminders';

  if (!apiKey || !fromEmail) {
    return res.status(500).json({ error: 'Email not configured — check Vercel environment variables' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: to, name: toName || to }],
        subject: subject,
        htmlContent: html
      })
    });

    const data = await response.json();

    if (response.ok && data.messageId) {
      return res.status(200).json({ success: true, messageId: data.messageId });
    } else {
      console.error('Brevo error:', JSON.stringify(data));
      return res.status(400).json({ error: 'Brevo rejected the request', detail: data });
    }
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
}
