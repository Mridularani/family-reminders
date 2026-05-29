import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

function getNextDueDate(currentDue, recurrence) {
  const d = new Date(currentDue);
  if (!recurrence) return null;
  if (recurrence.type === 'daily')   d.setDate(d.getDate() + 1);
  if (recurrence.type === 'days')    d.setDate(d.getDate() + (recurrence.every || 2));
  if (recurrence.type === 'weekly')  d.setDate(d.getDate() + 7);
  if (recurrence.type === 'monthly') d.setMonth(d.getMonth() + 1);
  if (recurrence.type === 'yearly')  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail   = process.env.FROM_EMAIL || 'admin@example.com';

  webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPublic, vapidPrivate);

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const { data: subscriptions } = await sb.from('push_subscriptions').select('*');
  if (!subscriptions?.length) return res.status(200).json({ sent: 0, message: 'No subscriptions' });

  // Test mode
  if (req.query?.test === '1') {
    let sent = 0;
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: 'Family Reminders — test notification!',
          body: 'Push notifications are working correctly.',
          tag: 'test', url: '/'
        }));
        sent++;
      } catch(e) { console.error('Test push failed:', e.statusCode, e.message); }
    }
    return res.status(200).json({ sent, message: 'Test notification sent' });
  }

  const { data: reminders } = await sb.from('reminders').select('*');
  if (!reminders?.length) return res.status(200).json({ sent: 0, message: 'No reminders' });

  // Current IST time
  const nowUTC = new Date();
  const nowIST = new Date(nowUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const today  = nowIST.toISOString().split('T')[0];
  const currentHour   = nowIST.getHours();   // 0-23
  const currentMinute = nowIST.getMinutes(); // 0-59

  let sent = 0;

  for (const r of reminders) {
    const pushAlerts = r.push_alerts || [];
    if (!pushAlerts.length) continue;

    // push_time is stored as "HH:MM" e.g. "16:25"
    const pushTimeParts = (r.push_time || '08:00').split(':');
    const pushHour   = parseInt(pushTimeParts[0]);
    const pushMinute = parseInt(pushTimeParts[1] || '0');

    // Only process if current hour AND minute (within 5 min window) matches
    if (currentHour !== pushHour) continue;
    if (Math.abs(currentMinute - pushMinute) > 5) continue;

    const due = new Date(r.due_date); due.setHours(0,0,0,0);
    const todayDate = new Date(today); todayDate.setHours(0,0,0,0);
    const daysLeft = Math.round((due - todayDate) / 86400000);

    for (const offset of pushAlerts) {
      const alertKey = `push_${r.id}_${offset}`;
      if ((r.sent_push_alerts || []).includes(alertKey)) continue;
      if (daysLeft !== offset) continue;

      const title = daysLeft === 0
        ? `Due today: ${r.title}`
        : `${r.title} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left`;
      const body = r.description || `Due ${new Date(r.due_date).toLocaleDateString('en-IN', { day:'numeric', month:'long' })}`;
      const recurNote = r.recurrence ? ' 🔁' : '';

      // Find target subscribers
      let targetSubs = [];
      if (r.visibility === 'private') {
        targetSubs = subscriptions.filter(s => s.user_id === r.user_id);
      } else {
        const { data: members } = await sb.from('family_memberships')
          .select('user_id').eq('family_id', r.family_id).eq('status', 'approved');
        const memberIds = (members || []).map(m => m.user_id);
        targetSubs = subscriptions.filter(s => memberIds.includes(s.user_id));
      }

      for (const sub of targetSubs) {
        try {
          await webpush.sendNotification(sub.subscription, JSON.stringify({
            title: title + recurNote, body, tag: r.id, url: '/'
          }));
          sent++;
        } catch(e) {
          console.error('Push failed:', e.statusCode, e.message);
          if (e.statusCode === 410 || e.statusCode === 404) {
            await sb.from('push_subscriptions').delete().eq('id', sub.id);
          }
        }
      }

      // Mark push alert sent
      const newSentPushAlerts = [...(r.sent_push_alerts || []), alertKey];

      // Advance recurring reminder on day-of push
      if (offset === 0 && r.recurrence) {
        const nextDue = getNextDueDate(r.due_date, r.recurrence);
        await sb.from('reminders').update({
          due_date: nextDue,
          sent_alerts: [],
          sent_push_alerts: []
        }).eq('id', r.id);
      } else {
        await sb.from('reminders').update({ sent_push_alerts: newSentPushAlerts }).eq('id', r.id);
      }
    }
  }

  return res.status(200).json({ sent, hour: currentHour });
}
