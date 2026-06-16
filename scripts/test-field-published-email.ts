// One-shot smoke test: render + actually send the new field-published
// email to gjdumper@gmail.com (Greg's verification address). Used to
// validate the 2026-06-16 fix that swapped the dead notifier-dispatch
// path for a direct sendEmail call.
//
// Usage (on prod):
//   cd /opt/fairway-fantasy && set -a && source .env.local && set +a \
//     && npx tsx scripts/test-field-published-email.ts

import { fieldPublishedEmail, sendEmail } from '../src/lib/email';

const TO = process.env.TO ?? 'gjdumper@gmail.com';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fairway.golf-czar.com';

async function main() {
  console.log(`Rendering test field-published email to ${TO}…`);
  const { subject, text, html } = fieldPublishedEmail({
    recipientName:  'Test recipient',
    leagueName:     'Royal Duffers',
    leagueSlug:     'royal-duffers',
    tournamentName: 'U.S. Open',
    pickDeadline:   new Date('2026-06-17T18:00:00-05:00'),
    siteUrl:        SITE_URL,
  });
  console.log('Subject:', subject);
  console.log();
  console.log('Sending via sendEmail…');
  const ok = await sendEmail({ to: TO, subject, text, html });
  console.log(`sendEmail returned: ${ok}`);
  if (!ok) {
    console.error('FAIL: sendEmail returned false — check SMTP config (.env.local SMTP_*).');
    process.exit(1);
  }
  console.log('SUCCESS: test email sent to', TO);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('FATAL:', err); process.exit(1); });
