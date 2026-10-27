// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Fuel Agent emails, sent through ForwardEmail.net from the tenant's
// address (same REST call as /api/bootcamp). No SMS anywhere in Fuel.
//
//   sendWelcomeEmail  — on join (and on "email me my link"): the private
//                       My Challenge link.
//   sendRewardEmail   — when the coach issues a reward from the portal
//                       (api/fuel-challenge?action=admin-issue-reward).

const { TENANT } = require('./tenant');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function send({ to, subject, text, html }) {
  const apiKey = process.env.FORWARDEMAIL_API_KEY;
  if (!apiKey) {
    console.warn('[fuel-agent] FORWARDEMAIL_API_KEY not set — skipping email:', subject);
    return { skipped: true };
  }
  const r = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ from: `${TENANT.fromName} <${TENANT.fromEmail}>`, to, subject, text, html }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`forwardemail ${r.status}: ${detail.slice(0, 200)}`);
  }
  return { sent: true };
}

function shell({ eyebrow, heading, bodyHtml, cta }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141720;border:1px solid rgba(200,168,75,0.3);border-radius:16px;overflow:hidden;">
        <tr><td style="background:#c8a84b;padding:20px 28px;">
          <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#0d0d0d;font-weight:bold;">${escapeHtml(eyebrow)}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:24px;color:#c8a84b;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
          ${cta ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#c8a84b;color:#0d0d0d;font-weight:bold;text-decoration:none;padding:14px 22px;border-radius:10px;">${escapeHtml(cta.label)}</a></p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#777;">
          ${escapeHtml(TENANT.fromName)} · Powered by ⚡ Go Elev8.AI
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const p = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#ccc;">${html}</p>`;

async function sendWelcomeEmail({ participant, challenge, link }) {
  const copy = challenge.hero_copy || {};
  const agent = copy.agent_name || 'Fuel Agent';
  const first = participant.first_name;
  const text = [
    `You're in, ${first}! 💪🏾`,
    '',
    `${challenge.title}: ${challenge.subtitle || ''}`.trim(),
    '',
    'Your private My Challenge link (keep it to yourself, it signs you in):',
    link,
    '',
    'After every workout, open the link and upload proof of your TOTAL steps: a photo of the stair machine with the display switched to total steps, or a screenshot of today’s Steps in your watch or phone health app. Steps per minute or a workout summary (time, distance, pace) won’t count.',
    copy.reward_line ? '' : null,
    copy.reward_line || null,
    '',
    `— ${agent}`,
  ].filter((l) => l !== null).join('\n');
  const html = shell({
    eyebrow: challenge.title,
    heading: `You're in, ${first}! 💪🏾`,
    bodyHtml:
      p(escapeHtml(challenge.subtitle || '')) +
      p('This is your private <strong style="color:#f5f5f5;">My Challenge</strong> link. It signs you in, so keep it to yourself.') +
      p('After every workout, upload proof of your <strong style="color:#f5f5f5;">total steps</strong>: a photo of the stair machine with the display switched to total steps, or a screenshot of today’s Steps in your watch or phone health app. Steps per minute or a workout summary won’t count. Show the full screen, no crops, no filters.') +
      (copy.reward_line ? p(`<strong style="color:#c8a84b;">${escapeHtml(copy.reward_line)}</strong>`) : ''),
    cta: { href: link, label: 'Open My Challenge' },
  });
  return send({ to: participant.email, subject: `You're in: ${challenge.title}`, text, html });
}

async function sendRewardEmail({ participant, challenge, reward, totals }) {
  const copy = challenge.hero_copy || {};
  const coach = copy.coach_name || 'the coach';
  const first = participant.first_name;
  const steps = (n) => Number(n || 0).toLocaleString('en-US');
  const subject = copy.reward_email_subject || `You beat ${coach}! 🙌🏾`;
  const text = [
    `${first}, you did it! 🙌🏾`,
    '',
    `You finished ${challenge.title} with ${steps(totals?.total)} steps. ${coach} finished with ${steps(totals?.coach_total)}.`,
    '',
    `Your reward: ${challenge.reward_title}`,
    `Redemption code: ${reward.redemption_code}`,
    '',
    'Show this code (or this email) when you arrive. Questions? Just reply.',
  ].join('\n');
  const html = shell({
    eyebrow: 'Reward unlocked',
    heading: `${first}, you beat ${coach}! 🙌🏾`,
    bodyHtml:
      p(`You finished <strong style="color:#f5f5f5;">${escapeHtml(challenge.title)}</strong> with <strong style="color:#c8a84b;">${steps(totals?.total)} steps</strong>. ${escapeHtml(coach)} finished with ${steps(totals?.coach_total)}.`) +
      p(`Your reward: <strong style="color:#f5f5f5;">${escapeHtml(challenge.reward_title)}</strong>`) +
      `<div style="margin:18px 0;padding:16px;border:1px dashed #c8a84b;border-radius:12px;text-align:center;font-size:22px;letter-spacing:4px;color:#c8a84b;font-weight:bold;">${escapeHtml(reward.redemption_code)}</div>` +
      p('Show this code (or this email) when you arrive. Questions? Just reply to this email.'),
  });
  return send({ to: participant.email, subject, text, html });
}

module.exports = { sendWelcomeEmail, sendRewardEmail };
