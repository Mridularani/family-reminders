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

  const apiKey    = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  const fromName  = process.env.FROM_NAME || 'Family Reminders';

  if (!apiKey || !secretKey || !fromEmail) {
    return res.status(500).json({ error: 'Email not configured — check Vercel environment variables' });
  }

  try {
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64')
      },
      body: JSON.stringify({
        Messages: [{
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: to, Name: toName || to }],
          Subject: subject,
          HTMLPart: html
        }]
      })
    });

    const data = await response.json();

    if (data.Messages?.[0]?.Status === 'success') {
      return res.status(200).json({ success: true });
    } else {
      console.error('Mailjet error:', JSON.stringify(data));
      return res.status(400).json({ error: 'Mailjet rejected the request', detail: data });
    }
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
}
