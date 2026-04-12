import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Manual VAPID implementation (no external dependencies)
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function b64urlDecode(str) {
  const pad = str.length % 4;
  if (pad) str += '='.repeat(4 - pad);
  return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}

async function buildVapidHeader(audience, subject, publicKey, privateKey) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ aud: audience, exp: now + 86400, sub: subject }));
  const data = `${header}.${payload}`;

  const privKeyBytes = b64urlDecode(privateKey);
  const pubKeyBytes = b64urlDecode(publicKey);

  const privKey = await crypto.webcrypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    Buffer.from(data)
  );

  return `vapid t=${data}.${b64url(Buffer.from(sig))},k=${publicKey}`;
}

async function sendPushNotification(subscription, payload, vapidPublic, vapidPrivate, vapidEmail) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const vapidHeader = await buildVapidHeader(audience, `mailto:${vapidEmail}`, vapidPublic, vapidPrivate);

  // Encrypt the payload
  const serverKeys = await crypto.webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );

  const clientPublicKey = await crypto.webcrypto.subtle.importKey(
    'raw', b64urlDecode(subscription.keys.p256dh),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  const sharedSecret = await crypto.webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeys.privateKey, 256
  );

  const serverPublicKeyRaw = await crypto.webcrypto.subtle.exportKey('raw', serverKeys.publicKey);
  const salt = crypto.randomBytes(16);
  const authBytes = b64urlDecode(subscription.keys.auth);

  // HKDF
  async function hkdf(salt, ikm, info, length) {
    const key = await crypto.webcrypto.subtle.importKey('raw', ikm, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const prk = await crypto.webcrypto.subtle.sign('HMAC', key, salt);
    const prkKey = await crypto.webcrypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const infoBuffer = Buffer.concat([Buffer.from(info), Buffer.from([1])]);
    const okm = await crypto.webcrypto.subtle.sign('HMAC', prkKey, infoBuffer);
    return Buffer.from(okm).slice(0, length);
  }

  const prk = await hkdf(authBytes, Buffer.from(sharedSecret), Buffer.concat([
    Buffer.from('Content-Encoding: auth\0'),
    Buffer.from('')
  ]), 32);

  const serverPubBuf = Buffer.from(serverPublicKeyRaw);
  const clientPubBuf = b64urlDecode(subscription.keys.p256dh);

  const context = Buffer.concat([
    Buffer.from('P-256\0'),
    Buffer.from([0, clientPubBuf.length]), clientPubBuf,
    Buffer.from([0, serverPubBuf.length]), serverPubBuf
  ]);

  const cek = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: aesgcm\0'), context]), 16);
  const nonce = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), context]), 12);

  const aesKey = await crypto.webcrypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = Buffer.concat([Buffer.from([0, 0]), Buffer.from(JSON.stringify(payload))]);
  const encrypted = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapidHeader,
      'Content-Encoding': 'aesgcm',
      'Content-Type': 'application/octet-stream',
      'Crypto-Key': `dh=${b64url(serverPubBuf)}`,
      'Encryption': `salt=${b64url(salt)}`,
      'TTL': '86400'
    },
    body: Buffer.from(encrypted)
  });

  return response.status;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail   = process.env.FROM_EMAIL || 'admin@familyreminders.app';

  const { data: reminders } = await sb.from('reminders').select('*');
  const { data: subscriptions } = await sb.from('push_subscriptions').select('*');

  if (!reminders || !subscriptions?.length) {
    return res.status(200).json({ sent: 0, message: 'No subscriptions' });
  }

  const today = new Date(); today.setHours(0,0,0,0);
  let sent = 0;

  for (const r of reminders) {
    const due = new Date(r.due_date); due.setHours(0,0,0,0);
    const daysLeft = Math.round((due - today) / 86400000);

    for (const offset of (r.alerts || [])) {
      const alertKey = `push_${r.id}_${offset}`;
      if ((r.sent_alerts || []).includes(alertKey)) continue;
      if (daysLeft !== offset) continue;

      const title = daysLeft === 0 ? `Due today: ${r.title}` : `${r.title} — ${daysLeft} day${daysLeft>1?'s':''} left`;
      const body  = r.description || `Due ${new Date(r.due_date).toLocaleDateString('en-IN', {day:'numeric',month:'long'})}`;

      // Find relevant subscribers
      let targetSubs = [];
      if (r.visibility === 'private') {
        targetSubs = subscriptions.filter(s => s.user_id === r.user_id);
      } else {
        const { data: members } = await sb.from('family_memberships')
          .select('user_id').eq('family_id', r.family_id).eq('status', 'approved');
        const memberIds = (members||[]).map(m => m.user_id);
        targetSubs = subscriptions.filter(s => memberIds.includes(s.user_id));
      }

      for (const sub of targetSubs) {
        try {
          await sendPushNotification(
            sub.subscription,
            { title, body, tag: r.id, url: '/' },
            vapidPublic, vapidPrivate, vapidEmail
          );
          sent++;
        } catch(e) {
          console.error('Push failed for', sub.user_id, e.message);
        }
      }

      // Mark push alert sent
      const newSentAlerts = [...(r.sent_alerts || []), alertKey];
      await sb.from('reminders').update({ sent_alerts: newSentAlerts }).eq('id', r.id);
    }
  }

  return res.status(200).json({ sent });
}
