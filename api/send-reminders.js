import { createClient } from '@supabase/supabase-js';

function getNextDueDate(currentDue, recurrence) {
  const d = new Date(currentDue);
  const r = recurrence;
  if (!r) return null;
  if (r.type === 'daily')   { d.setDate(d.getDate() + 1); }
  if (r.type === 'days')    { d.setDate(d.getDate() + (r.every || 2)); }
  if (r.type === 'weekly')  { d.setDate(d.getDate() + 7); }
  if (r.type === 'monthly') { d.setMonth(d.getMonth() + 1); }
  if (r.type === 'yearly')  { d.setFullYear(d.getFullYear() + 1); }
  return d.toISOString().split('T')[0];
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const { data: reminders } = await sb.from('reminders').select('*');
  const { data: members }   = await sb.from('members').select('*');

  if (!reminders) return res.status(500).json({ error: 'Failed to load reminders' });

  // Current IST date
  const nowUTC = new Date();
  const nowIST = new Date(nowUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const today  = new Date(nowIST.toISOString().split('T')[0]);

  let sent = 0;
  const toDelete = [];

  for (const r of reminders) {
    const due = new Date(r.due_date); due.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((due - today) / 86400000);

    for (const offset of (r.alerts || [])) {
      const alertKey = `${r.id}_${offset}`;
      if ((r.sent_alerts || []).includes(alertKey)) continue;
      if (daysLeft !== offset) continue;

      // Find recipients
      let targets = [];
      if (r.visibility === 'private') {
        // Private reminders — get user email from profiles
        const { data: profile } = await sb.from('profiles').select('name, email').eq('id', r.user_id).single();
        if (profile?.email) targets = [{ email: profile.email, name: profile.name }];
      } else {
        // Family reminders
        if (r.recipients === 'everyone') {
          const { data: fms } = await sb.from('family_memberships')
            .select('user_id').eq('family_id', r.family_id).eq('status', 'approved');
          const userIds = (fms || []).map(m => m.user_id);
          const { data: profs } = await sb.from('profiles').select('name, email').in('id', userIds);
          targets = profs || [];
        } else {
          try {
            const ids = JSON.parse(r.recipients);
            const { data: profs } = await sb.from('profiles').select('name, email').in('id', ids);
            targets = profs || [];
          } catch { targets = []; }
        }
      }

      const subject = daysLeft === 0
        ? `Reminder: ${r.title} is due today`
        : `Reminder: ${r.title} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left`;
      const html = buildEmailHtml(r, daysLeft);

      for (const m of targets) {
        if (m.email) { await sendEmail(m.email, m.name, subject, html); sent++; }
      }

      // Mark alert sent
      const newSentAlerts = [...(r.sent_alerts || []), alertKey];

      // If this was the last alert (offset 0 = day of) and reminder recurs,
      // advance the due date and reset sent_alerts
      if (offset === 0 && r.recurrence) {
        const nextDue = getNextDueDate(r.due_date, r.recurrence);
        await sb.from('reminders').update({
          due_date: nextDue,
          sent_alerts: [] // reset so alerts fire again for next occurrence
        }).eq('id', r.id);
        console.log(`Recurring reminder "${r.title}" advanced to ${nextDue}`);
      } else {
        await sb.from('reminders').update({ sent_alerts: newSentAlerts }).eq('id', r.id);
      }
    }

    // Auto-delete (only for non-recurring reminders)
    if (r.auto_delete && !r.recurrence) {
      const allSent = (r.alerts || []).length > 0 &&
        (r.alerts || []).every(o => (r.sent_alerts || []).includes(`${r.id}_${o}`));
      if (allSent) toDelete.push(r.id);
    }
  }

  for (const id of toDelete) {
    await sb.from('reminders').delete().eq('id', id);
  }

  return res.status(200).json({ sent, deleted: toDelete.length });
}

async function sendEmail(to, toName, subject, html) {
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: process.env.FROM_EMAIL, name: process.env.FROM_NAME || 'Family Reminders' },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html
      })
    });
  } catch(e) { console.error('Email error for', to, e.message); }
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildEmailHtml(r, daysLeft) {
  const urgency = daysLeft === 0 ? 'Due today!' : daysLeft === 1 ? 'Due tomorrow' : `Due in ${daysLeft} days`;
  const color   = daysLeft === 0 ? '#C2410C' : daysLeft <= 3 ? '#EA580C' : '#15803D';
  const recurNote = r.recurrence ? `<p style="color:#0369A1;font-size:13px;margin:8px 0 0">🔁 This is a recurring reminder</p>` : '';
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
      ${recurNote}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #E7E2DA;font-size:12px;color:#A8A29E;text-align:center">
      Sent by Family Reminders
    </div>
  </div>`;
}
