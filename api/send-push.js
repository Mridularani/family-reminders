import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail   = process.env.FROM_EMAIL || 'admin@example.com';

  webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPublic, vapidPrivate);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const { data: subscriptions } = await sb.from('push_subscriptions').select('*');
  if (!subscriptions?.length) return res.status(200).json({ sent: 0, message: 'No subscriptions' });

  const { data: reminders } = await sb.from('reminders').select('*');
  if (!reminders?.length) return res.status(200).json({ sent: 0, message: 'No reminders' });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let sent = 0;

  for (const r of reminders) {
    const due = new Date(r.due_date); due.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((due - today) / 86400000);

    for (const offset of (r.alerts || [])) {
      const alertKey = `push_${r.id}_${offset}`;
      if ((r.sent_alerts || []).includes(alertKey)) continue;
      if (daysLeft !== offset) continue;

      const title = daysLeft === 0
        ? `Due today: ${r.title}`
        : `${r.title} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left`;
      const body = r.description || `Due ${new Date(r.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`;

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
          await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, tag: r.id, url: '/' }));
          sent++;
        } catch (e) {
          console.error('Push failed:', e.statusCode, e.message);
          if (e.statusCode === 410 || e.statusCode === 404) {
            await sb.from('push_subscriptions').delete().eq('id', sub.id);
          }
        }
      }

      const newSentAlerts = [...(r.sent_alerts || []), alertKey];
      await sb.from('reminders').update({ sent_alerts: newSentAlerts }).eq('id', r.id);
    }
  }

  return res.status(200).json({ sent });
}
