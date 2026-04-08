import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { data: reminders, error: re } = await sb.from('reminders').select('*');
  const { data: members,   error: me } = await sb.from('members').select('*');

  if (re || me) {
    console.error('Supabase error:', re || me);
    return res.status(500).json({ error: 'Failed to load data from Supabase' });
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let sent = 0;
  const toDelete = [];

  for (const r of reminders) {
    const due = new Date(r.due_date); due.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((due - today) / 86400000);

    for (const offset of (r.alerts || [])) {
      const alertKey = `${r.id}_${offset}`;
      if ((r.sent_alerts || []).includes(alertKey)) continue;
      if (daysLeft !== offset) continue;

      let targets = [];
      if (r.recipients === 'everyone') {
        targets = members;
      } else {
        try {
          const ids = JSON.parse(r.recipients);
          targets = members.filter(m => ids.includes(m.id));
        } catch { targets = []; }
      }

      const subject = daysLeft === 0
        ? `Reminder: ${r.title} is due today`
        : `Reminder: ${r.title} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left`;

      const html = buildEmailHtml(r, daysLeft);

      for (const m of targets) {
        await sendEmail(m.email, m.name, subject, html);
        sent++;
      }

      const newSentAlerts = [...(r.sent_alerts || []), alertKey];
      await sb.from('reminders').update({ sent_alerts: newSentAlerts }).eq('id', r.id);
    }

    if (r.auto_delete) {
      const allSent = (r.alerts || []).length > 0 &&
        (r.alerts || []).every(o => (r.sent_alerts || []).includes(`${r.id}_${o}`));
      if (allSent) toDelete.push(r.id);
    }
  }

  for (const id of toDelete) {
    await sb.from('reminders').delete().eq('id', id);
  }

  console.log(`Sent ${sent} emails, deleted ${toDelete.length} reminders`);
  return res.status(200).json({ sent, deleted: toDelete.length });
}

async function sendEmail(to, toName, subject, html) {
  const apiKey    = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  const fromName  = process.env.FROM_NAME || 'Family Reminders';

  try {
    await fetch('https://api.mailjet.com/v3.1/send', {
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
  } catch(e) {
    console.error('Email error for', to, e.message);
  }
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmailHtml(r, daysLeft) {
  const urgency = daysLeft === 0 ? 'Today!' : daysLeft === 1 ? 'Tomorrow' : `In ${daysLeft} days`;
  const color   = daysLeft === 0 ? '#C2410C' : daysLeft <= 3 ? '#EA580C' : '#15803D';
  return `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:480px;margin:0 auto;background:#FFFEF9;border:1px solid #E7E2DA;border-radius:12px;overflow:hidden">
    <div style="background:#1C1917;padding:20px 28px">
      <span style="font-family:Georgia,serif;font-size:18px;color:#FAF7F2">family <em style="color:#EA580C">reminders</em></span>
    </div>
    <div style="padding:28px">
      <div style="background:${color}18;border-left:3px solid ${color};border-radius:4px;padding:10px 14px;margin-bottom:20px">
        <span style="color:${color};font-weight:600;font-size:15px">${urgency}</span>
      </div>
      <h2 style="font-family:Georgia,serif;font-size:22px;color:#1C1917;margin:0 0 8px">${esc(r.title)}</h2>
      ${r.description ? `<p style="color:#57534E;font-size:14px;line-height:1.6;margin:0 0 16px">${esc(r.description)}</p>` : ''}
      <div style="background:#FAF7F2;border-radius:8px;padding:12px 16px;font-size:14px;color:#57534E">
        <strong style="color:#1C1917">Due date:</strong>
        ${new Date(r.due_date).toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
      </div>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #E7E2DA;font-size:12px;color:#A8A29E;text-align:center">
      Sent by Family Reminders
    </div>
  </div>`;
}
