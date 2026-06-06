// ============================================================
// EMAIL — outbound SMTP via nodemailer.
//
// Reads SMTP creds from env (mirrors DayTrader's pattern on the same
// box so a single Gmail app password covers both apps):
//   SMTP_HOST   — e.g. smtp.gmail.com
//   SMTP_PORT   — e.g. 587
//   SMTP_USER   — full Gmail address
//   SMTP_PASSWORD — 16-char Gmail app password
//   SMTP_FROM   — From: header, defaults to SMTP_USER
//
// If any required var is missing, sendEmail() logs a warning and
// returns false instead of throwing. That keeps dev/test runs (and
// any deployment that hasn't wired SMTP yet) from blowing up — but
// callers should check the return value and surface an error to the
// user if delivery is critical (e.g. account verification).
// ============================================================

import nodemailer, { type Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;
let _warnedMissingConfig = false;

function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !port || !user || !pass) {
    if (!_warnedMissingConfig) {
      console.warn(
        '[email] SMTP not configured (missing SMTP_HOST/PORT/USER/PASSWORD). ' +
        'Outbound email will be skipped.',
      );
      _warnedMissingConfig = true;
    }
    return null;
  }

  _transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    // 465 is implicit-TLS, everything else (587, 25) is STARTTLS.
    secure: Number(port) === 465,
    auth: { user, pass },
  });
  return _transporter;
}

export interface EmailAttachment {
  filename:    string;
  content:     Buffer;
  contentType?: string;
}

export interface SendEmailParams {
  to:           string;
  subject:      string;
  text:         string;
  html?:        string;
  /** Binary attachments (e.g. the daily-scorecard PDF). Optional —
   *  passing nothing leaves the email plain. */
  attachments?: EmailAttachment[];
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  // From: hierarchy:
  //   1. SMTP_FROM env var (the production setting on .150)
  //   2. Hardcoded admin@golf-czar.com — the project's canonical
  //      outbound address. Pre-2026-05-19 the fallback was SMTP_USER
  //      (a Gmail relay account); falling back to it sent mail FROM a
  //      personal Gmail address on dev/test environments where
  //      SMTP_FROM was unset. Hardcoding the brand address is the
  //      consistent default regardless of which channel SMTP auths
  //      through. DMARC alignment requires SMTP relay to be configured
  //      for golf-czar.com (already in place on prod via Gmail "Send
  //      mail as").
  const from = process.env.SMTP_FROM || 'admin@golf-czar.com';

  try {
    await t.sendMail({
      from,
      to:          params.to,
      subject:     params.subject,
      text:        params.text,
      html:        params.html,
      attachments: params.attachments?.map(a => ({
        filename:    a.filename,
        content:     a.content,
        contentType: a.contentType ?? 'application/octet-stream',
      })),
    });
    return true;
  } catch (err) {
    console.error('[email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

// ============================================================
// Email-verification template.
// ============================================================

export function verificationEmail(params: {
  displayName: string;
  verifyUrl:   string;
}): { subject: string; text: string; html: string } {
  const { displayName, verifyUrl } = params;

  const subject = 'Verify your Fairway Fantasy account';

  const text = `
Hi ${displayName},

Welcome to Fairway Fantasy! Please verify your email address to start picking foursomes.

Click here to verify:
${verifyUrl}

This link expires in 7 days. If you didn't sign up for Fairway Fantasy, you can ignore this email.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 48px; margin-bottom: 8px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 28px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    Hi ${escapeHtml(displayName)},
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    Welcome to Fairway Fantasy. Please verify your email address to start picking foursomes.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(verifyUrl)}"
       style="display: inline-block; padding: 14px 32px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 16px;">
      Verify Email
    </a>
  </div>

  <p style="font-size: 14px; color: #6a6a6a; line-height: 1.5;">
    Or paste this link into your browser:<br/>
    <a href="${escapeHtml(verifyUrl)}" style="color: #2d6a4f; word-break: break-all;">
      ${escapeHtml(verifyUrl)}
    </a>
  </p>

  <p style="font-size: 13px; color: #999999; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid #e0e0e0;">
    This link expires in 7 days. If you didn't sign up for Fairway Fantasy, you can safely ignore this email.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// League-invitation template.
// ============================================================

export function invitationEmail(params: {
  leagueName:  string;
  inviterName: string;
  inviteUrl:   string;
}): { subject: string; text: string; html: string } {
  const { leagueName, inviterName, inviteUrl } = params;

  const subject = `${inviterName} invited you to ${leagueName} on Fairway Fantasy`;

  const text = `
${inviterName} has invited you to join "${leagueName}" on Fairway Fantasy.

Click here to accept the invite and create your account:
${inviteUrl}

Fairway Fantasy is a fantasy-golf league where you pick 4 PGA Tour
golfers each week and the best 3 scores count. The same league link
works for anyone you forward it to.

If you weren't expecting this invitation, you can safely ignore this
email.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 48px; margin-bottom: 8px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 28px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    <strong>${escapeHtml(inviterName)}</strong> has invited you to join
    <strong>${escapeHtml(leagueName)}</strong>.
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    Fairway Fantasy is a fantasy-golf league where you pick 4 PGA Tour
    golfers each week and the best 3 scores count.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(inviteUrl)}"
       style="display: inline-block; padding: 14px 32px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 16px;">
      Accept Invite
    </a>
  </div>

  <p style="font-size: 14px; color: #6a6a6a; line-height: 1.5;">
    Or paste this link into your browser:<br/>
    <a href="${escapeHtml(inviteUrl)}" style="color: #2d6a4f; word-break: break-all;">
      ${escapeHtml(inviteUrl)}
    </a>
  </p>

  <p style="font-size: 13px; color: #999999; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid #e0e0e0;">
    If you weren't expecting this invitation, you can safely ignore this email.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// Password-reset template.
// ============================================================

export function passwordResetEmail(params: {
  displayName: string;
  resetUrl:    string;
}): { subject: string; text: string; html: string } {
  const { displayName, resetUrl } = params;

  const subject = 'Reset your Fairway Fantasy password';

  const text = `
Hi ${displayName},

We received a request to reset the password on your Fairway Fantasy account.

Click here to choose a new password:
${resetUrl}

This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will not change.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 48px; margin-bottom: 8px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 28px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    Hi ${escapeHtml(displayName)},
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    We received a request to reset the password on your Fairway Fantasy
    account. Click below to choose a new password.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(resetUrl)}"
       style="display: inline-block; padding: 14px 32px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 16px;">
      Reset Password
    </a>
  </div>

  <p style="font-size: 14px; color: #6a6a6a; line-height: 1.5;">
    Or paste this link into your browser:<br/>
    <a href="${escapeHtml(resetUrl)}" style="color: #2d6a4f; word-break: break-all;">
      ${escapeHtml(resetUrl)}
    </a>
  </p>

  <p style="font-size: 13px; color: #999999; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid #e0e0e0;">
    This link expires in 1 hour. If you didn't request a password reset,
    you can safely ignore this email — your password will not change.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// Roster-set admin-notification template.
//
// Fired once per tournament, on the NULL → field_published_at flip
// in the hourly ESPN sync (sync.ts:checkAndPublishField). Recipients
// are the commissioners + co-commissioners of every league whose date
// window includes the tournament.
//
// Each recipient gets ONE email listing all their relevant leagues —
// not N emails for N leagues. That dedup happens in the caller
// (notifyAdminsRosterSet in sync.ts), this template just renders
// whatever list it's given.
// ============================================================

export function rosterSetAdminEmail(params: {
  displayName:     string;
  tournamentName:  string;
  golferCount:     number;
  leagues:         Array<{ name: string; slug: string }>;
  siteUrl:         string;
}): { subject: string; text: string; html: string } {
  const { displayName, tournamentName, golferCount, leagues, siteUrl } = params;

  const sourceText =
    'ESPN published the field and the hourly sync seeded it just now.';

  // One line per league: "• <name> — <picks link>"
  const leagueListText = leagues
    .map(l => `  • ${l.name} — ${siteUrl}/league/${l.slug}/picks`)
    .join('\n');
  const leagueListHtml = leagues
    .map(l => {
      const url = `${siteUrl}/league/${l.slug}/picks`;
      return `<li style="margin-bottom: 6px;">
        <strong>${escapeHtml(l.name)}</strong> —
        <a href="${escapeHtml(url)}" style="color: #2d6a4f;">view picks page</a>
      </li>`;
    })
    .join('\n');

  const subject = `[Fairway Fantasy] Roster set: ${tournamentName}`;

  const text = `
Hi ${displayName},

The roster has been set for ${tournamentName} (${golferCount} golfers).

${sourceText}

You're receiving this because you're a commissioner of:
${leagueListText}

Picks are now unblocked for these leagues. No action required — this
is an FYI so you know the field is locked in for the week.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="font-size: 40px; margin-bottom: 4px;">🏌️</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 24px; margin: 0;">
      Fairway Fantasy — Admin Notice
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    Hi ${escapeHtml(displayName)},
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    The roster has been set for
    <strong>${escapeHtml(tournamentName)}</strong>
    (${golferCount} golfers).
  </p>

  <p style="font-size: 14px; color: #555555; line-height: 1.5;">
    ${escapeHtml(sourceText)}
  </p>

  <p style="font-size: 16px; line-height: 1.5; margin-top: 24px;">
    You're receiving this because you're a commissioner of:
  </p>
  <ul style="font-size: 15px; line-height: 1.5; padding-left: 20px;">
    ${leagueListHtml}
  </ul>

  <p style="font-size: 13px; color: #777777; margin-top: 24px; padding-top: 16px;
            border-top: 1px solid #e0e0e0; line-height: 1.5;">
    Picks are now unblocked for these leagues. No action required —
    this is an FYI so you know the field is locked in for the week.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// Missed-deadline auto-assign template.
//
// Fired once per (user, league, tournament) by the missed-deadline
// sweep in sync.ts:sweepMissedPicks() when:
//   - the tournament's pick_deadline (or commissioner override) has
//     passed,
//   - the user belongs to a league whose window includes the
//     tournament,
//   - they didn't submit a pick before the deadline.
//
// The sweep builds a random unique lineup excluding the top-4 of
// each tier by OWGR (see buildAutoLineup in scoring.ts), inserts it
// with penalty_strokes=2 + is_locked=true, then calls this template
// to tell the user what happened and what they got.
// ============================================================

export function missedDeadlineEmail(params: {
  displayName:    string;
  leagueName:     string;
  leagueSlug:     string;
  tournamentName: string;
  golfers:        Array<{ slot: number; name: string }>;
  penaltyStrokes: number;
  siteUrl:        string;
}): { subject: string; text: string; html: string } {
  const {
    displayName, leagueName, leagueSlug, tournamentName,
    golfers, penaltyStrokes, siteUrl,
  } = params;

  const picksUrl = `${siteUrl}/league/${leagueSlug}/picks`;

  // Plain-text bullet list with slot label.
  const golfersTextList = golfers
    .map(g => {
      const tierLabel = g.slot <= 2 ? 'Top tier' : 'Dark horse';
      return `  ${g.slot}. ${g.name}  (${tierLabel})`;
    })
    .join('\n');

  // HTML rows for the same. Slot column + tier badge.
  const golfersHtmlList = golfers
    .map(g => {
      const tierLabel = g.slot <= 2 ? 'Top tier' : 'Dark horse';
      const tierBg    = g.slot <= 2 ? '#2d6a4f' : '#a47148';
      return `<li style="margin-bottom: 6px;">
        <strong>${escapeHtml(g.name)}</strong>
        <span style="display: inline-block; margin-left: 8px;
                     padding: 1px 8px; font-size: 11px; font-weight: 600;
                     color: white; background: ${tierBg}; border-radius: 999px;">
          ${tierLabel}
        </span>
      </li>`;
    })
    .join('\n');

  const subject = `[Fairway Fantasy] Auto-assigned lineup for ${tournamentName}`;

  const text = `
Hi ${displayName},

You didn't submit a pick before the deadline for ${tournamentName}
in your league "${leagueName}", so a random lineup has been assigned
on your behalf with a ${penaltyStrokes}-stroke penalty.

Your assigned lineup:
${golfersTextList}

The penalty is applied to your best-3-of-4 total at scoring time —
your total will be ${penaltyStrokes} strokes higher than it otherwise
would be.

The lineup is locked. You can still watch it run alongside everyone
else's at:
${picksUrl}

Next week, submit before the deadline to choose your own foursome.

— Fairway Fantasy
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2c2c2c;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="font-size: 40px; margin-bottom: 4px;">⛳</div>
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 24px; margin: 0;">
      Fairway Fantasy
    </h1>
  </div>

  <p style="font-size: 16px; line-height: 1.5;">
    Hi ${escapeHtml(displayName)},
  </p>

  <p style="font-size: 16px; line-height: 1.5;">
    You didn't submit a pick before the deadline for
    <strong>${escapeHtml(tournamentName)}</strong>
    in your league <strong>${escapeHtml(leagueName)}</strong>,
    so a random lineup has been assigned on your behalf with a
    <strong>${penaltyStrokes}-stroke penalty</strong>.
  </p>

  <p style="font-size: 16px; line-height: 1.5; margin-top: 24px; margin-bottom: 8px;">
    Your assigned lineup:
  </p>
  <ol style="font-size: 15px; line-height: 1.5; padding-left: 24px;">
    ${golfersHtmlList}
  </ol>

  <p style="font-size: 14px; color: #555555; line-height: 1.5;">
    The penalty is applied to your best-3-of-4 total at scoring time —
    your total will be ${penaltyStrokes} strokes higher than it
    otherwise would be.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(picksUrl)}"
       style="display: inline-block; padding: 14px 28px; background: #2d6a4f; color: #ffffff;
              text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 15px;">
      View Picks Page
    </a>
  </div>

  <p style="font-size: 13px; color: #777777; margin-top: 24px; padding-top: 16px;
            border-top: 1px solid #e0e0e0; line-height: 1.5;">
    The lineup is locked for this tournament. Next week, submit before
    the deadline to choose your own foursome.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// Daily-scorecard email template (post-round-complete).
//
// Sent by sweep in sync.ts:detectAndSendDailyScorecards once every
// cut-survivor in the field reports thru=18 for the current round.
// One email per (user, league). The body lists the league
// standings + the recipient's own foursome breakdown; the PDF
// scorecard is attached.
// ============================================================

export interface DailyScorecardLeaderboardRow {
  rank:             number;
  displayName:      string;
  totalScore:       number | null;  // rounded
  isMe:             boolean;
}

export interface DailyScorecardMyGolfer {
  slot:         number;            // 1..4
  name:         string;
  roundScore:   number | null;     // this round's strokes total (or null)
  cumulative:   number | null;     // fantasy_score (score-to-par)
  countedSlot:  boolean;           // whether this golfer is in the top-3 this round
  statusBadge:  string | null;     // 'MC' / 'WD' / 'DQ' or null
}

export function dailyScorecardEmail(params: {
  displayName:    string;
  leagueName:     string;
  leagueSlug:     string;
  tournamentName: string;
  roundNum:       number;
  dateLabel:      string;
  /** League standings as of end-of-round, ordered by rank ascending. */
  leaderboard:    DailyScorecardLeaderboardRow[];
  /** Recipient's own 4 golfers for the round breakdown table. */
  myFoursome:     DailyScorecardMyGolfer[];
  siteUrl:        string;
}): { subject: string; text: string; html: string } {
  const {
    displayName, leagueName, leagueSlug, tournamentName, roundNum,
    dateLabel, leaderboard, myFoursome, siteUrl,
  } = params;

  const leagueUrl = `${siteUrl}/league/${leagueSlug}`;

  // ── plain text ────────────────────────────────────────────
  const fmtNum = (n: number | null) => (n == null ? '—' : (n > 0 ? `+${n}` : String(n)));
  const lbText = leaderboard
    .map(r => `  ${String(r.rank).padStart(2)}.  ${r.displayName.padEnd(20)}  ${fmtNum(r.totalScore)}${r.isMe ? '  ← you' : ''}`)
    .join('\n');
  const foursomeText = myFoursome
    .map(g => {
      const tier = g.slot <= 2 ? 'Top' : 'DH';
      const badge = g.statusBadge ? `  [${g.statusBadge}]` : '';
      const counted = g.countedSlot ? '  ✓ counted' : '';
      return `  ${g.slot}. ${tier}  ${g.name.padEnd(24)}  ` +
             `R${roundNum}: ${fmtNum(g.roundScore)}  ` +
             `Total: ${fmtNum(g.cumulative)}${badge}${counted}`;
    })
    .join('\n');

  const subject = `[Fairway Fantasy] ${tournamentName} R${roundNum} — daily scorecard for ${leagueName}`;

  const text = `
Hi ${displayName},

Round ${roundNum} of the ${tournamentName} is done. Here's where
${leagueName} stands and how your foursome played.

LEAGUE STANDINGS (after R${roundNum}):
${lbText}

YOUR FOURSOME (this round):
${foursomeText}

A full 18-hole scorecard PDF is attached.

See the live leaderboard at:
${leagueUrl}

— Fairway Fantasy
`.trim();

  // ── HTML ──────────────────────────────────────────────────
  const lbHtml = leaderboard
    .map(r => `<tr style="${r.isMe ? 'background:#fff9e6;' : ''}">
      <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${r.rank}</td>
      <td style="padding:4px 8px;">${escapeHtml(r.displayName)}${r.isMe ? ' <span style="color:#a47148; font-size:11px;">← you</span>' : ''}</td>
      <td style="padding:4px 8px; text-align:right; font-family:monospace; font-weight:600;">${fmtNum(r.totalScore)}</td>
    </tr>`)
    .join('');

  const foursomeHtml = myFoursome
    .map(g => {
      const tier = g.slot <= 2 ? 'Top' : 'DH';
      const tierBg = g.slot <= 2 ? '#2d6a4f' : '#a47148';
      const badge = g.statusBadge
        ? `<span style="display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; color:#92400e; background:#fef3c7; border-radius:3px;">${g.statusBadge}</span>`
        : '';
      const checkmark = g.countedSlot
        ? '<span style="color:#2d6a4f; font-weight:700;">✓</span>'
        : '<span style="color:#bbb;">·</span>';
      return `<tr>
        <td style="padding:6px 8px; width:18px; text-align:center;">${checkmark}</td>
        <td style="padding:6px 8px; width:36px;">
          <span style="display:inline-block; padding:1px 6px; font-size:10px; color:#fff; background:${tierBg}; border-radius:3px;">${tier}</span>
        </td>
        <td style="padding:6px 8px;">${escapeHtml(g.name)}${badge}</td>
        <td style="padding:6px 8px; text-align:right; font-family:monospace;">${fmtNum(g.roundScore)}</td>
        <td style="padding:6px 8px; text-align:right; font-family:monospace; font-weight:600;">${fmtNum(g.cumulative)}</td>
      </tr>`;
    })
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#2c2c2c;">
  <div style="text-align:center; margin-bottom:20px;">
    <div style="font-size:36px;">⛳</div>
    <h1 style="font-family:Georgia, serif; font-weight:700; font-size:22px; margin:6px 0 0;">Fairway Fantasy</h1>
    <p style="color:#777; font-size:13px; margin:4px 0 0;">Daily Scorecard</p>
  </div>

  <p style="font-size:15px; line-height:1.5;">
    Hi ${escapeHtml(displayName)},<br>
    Round ${roundNum} of <strong>${escapeHtml(tournamentName)}</strong> is done.
    Here's where <strong>${escapeHtml(leagueName)}</strong> stands and how
    your foursome played on ${escapeHtml(dateLabel)}.
  </p>

  <h3 style="font-family:Georgia, serif; font-size:15px; margin-top:24px; margin-bottom:8px; color:#1d3a2a;">
    League standings after R${roundNum}
  </h3>
  <table style="width:100%; border-collapse:collapse; border:1px solid #e6e6e6;">
    <thead>
      <tr style="background:#2d6a4f; color:#fff;">
        <th style="padding:6px 8px; text-align:right; font-size:11px;">RANK</th>
        <th style="padding:6px 8px; text-align:left;  font-size:11px;">PLAYER</th>
        <th style="padding:6px 8px; text-align:right; font-size:11px;">TOTAL</th>
      </tr>
    </thead>
    <tbody>${lbHtml}</tbody>
  </table>

  <h3 style="font-family:Georgia, serif; font-size:15px; margin-top:24px; margin-bottom:8px; color:#1d3a2a;">
    Your foursome this round
  </h3>
  <table style="width:100%; border-collapse:collapse; border:1px solid #e6e6e6;">
    <thead>
      <tr style="background:#f5f5f5; color:#555;">
        <th style="padding:6px 8px; text-align:center; font-size:11px;">CT</th>
        <th style="padding:6px 8px; text-align:left;   font-size:11px;">TIER</th>
        <th style="padding:6px 8px; text-align:left;   font-size:11px;">GOLFER</th>
        <th style="padding:6px 8px; text-align:right;  font-size:11px;">R${roundNum}</th>
        <th style="padding:6px 8px; text-align:right;  font-size:11px;">TOT</th>
      </tr>
    </thead>
    <tbody>${foursomeHtml}</tbody>
  </table>
  <p style="font-size:11px; color:#888; margin-top:6px;">
    <strong>CT</strong> column marks the 3 golfers counting toward your fantasy total.
    R${roundNum} is each golfer's strokes-to-par this round; TOT is the tournament total.
  </p>

  <p style="font-size:13px; color:#555; line-height:1.5; margin-top:24px;">
    📎 A full 18-hole scorecard for your foursome is attached as a PDF.
  </p>

  <div style="text-align:center; margin:28px 0 8px;">
    <a href="${escapeHtml(leagueUrl)}" style="display:inline-block; padding:12px 22px; background:#2d6a4f; color:#fff; text-decoration:none; border-radius:6px; font-weight:700; font-size:14px;">
      View live leaderboard
    </a>
  </div>

  <p style="font-size:11px; color:#aaa; margin-top:24px; padding-top:14px; border-top:1px solid #e6e6e6; text-align:center;">
    You're getting this because you're a member of ${escapeHtml(leagueName)}.
    Next round: keep an eye on your foursome at the link above.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// Tournament-recap email template (post-tournament-complete).
//
// Sent by sync.ts:detectAndSendTournamentRecaps once a tournament's
// status flips to 'complete'. One email per (user, league). The body
// shows final league standings + the recipient's best round + a
// season-standings snapshot. Dedup is via tournament_recap_log
// (migration 009). Per-user opt-out is tournament_recap_enabled on
// reminder_preferences.
// ============================================================

export interface TournamentRecapLeaderboardRow {
  rank:             number;
  displayName:      string;
  totalScore:       number | null;  // rounded; lower = better
  isMe:             boolean;
}

export interface TournamentRecapBestRound {
  roundNum:   number;            // 1..4
  score:      number;            // strokes-to-par for that round
  golfer:     string;            // golfer name driving the best round
}

export interface TournamentRecapSeasonRow {
  rank:               number | null;
  displayName:        string;
  totalScore:         number;
  tournamentsPlayed:  number;
  isMe:               boolean;
}

export function tournamentRecapEmail(params: {
  displayName:     string;
  leagueName:      string;
  leagueSlug:      string;
  tournamentName:  string;
  /** Final league standings for this tournament. */
  leaderboard:     TournamentRecapLeaderboardRow[];
  /** Recipient's best round, if any of their golfers' rounds posted. */
  bestRound:       TournamentRecapBestRound | null;
  /** Optional season-standings snapshot. Omit entirely for single-
   *  tournament leagues; the section just won't render. */
  seasonStandings: TournamentRecapSeasonRow[] | null;
  siteUrl:         string;
}): { subject: string; text: string; html: string } {
  const {
    displayName, leagueName, leagueSlug, tournamentName,
    leaderboard, bestRound, seasonStandings, siteUrl,
  } = params;

  const leagueUrl = `${siteUrl}/league/${leagueSlug}`;

  const fmtNum = (n: number | null) => (n == null ? '—' : (n > 0 ? `+${n}` : String(n)));

  // ── plain text ────────────────────────────────────────────
  const lbText = leaderboard
    .map(r => `  ${String(r.rank).padStart(2)}.  ${r.displayName.padEnd(20)}  ${fmtNum(r.totalScore)}${r.isMe ? '  ← you' : ''}`)
    .join('\n');

  const bestRoundText = bestRound
    ? `Your best round: R${bestRound.roundNum} — ${bestRound.golfer} at ${fmtNum(bestRound.score)}.\n\n`
    : '';

  const seasonText = (seasonStandings && seasonStandings.length > 0)
    ? `SEASON STANDINGS (${leagueName}):\n` +
      seasonStandings
        .map(r => `  ${r.rank == null ? '—' : String(r.rank).padStart(2)}.  ` +
                  `${r.displayName.padEnd(20)}  ` +
                  `${String(r.totalScore).padStart(5)}  ` +
                  `(${r.tournamentsPlayed} played)${r.isMe ? '  ← you' : ''}`)
        .join('\n') + '\n\n'
    : '';

  const subject = `[Fairway Fantasy] ${tournamentName} — tournament recap for ${leagueName}`;

  const text = `
Hi ${displayName},

${tournamentName} is in the books. Here's how ${leagueName} finished.

FINAL STANDINGS:
${lbText}

${bestRoundText}${seasonText}See the full leaderboard at:
${leagueUrl}

— Fairway Fantasy
`.trim();

  // ── HTML ──────────────────────────────────────────────────
  const lbHtml = leaderboard
    .map(r => `<tr style="${r.isMe ? 'background:#fff9e6;' : ''}">
      <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${r.rank}</td>
      <td style="padding:4px 8px;">${escapeHtml(r.displayName)}${r.isMe ? ' <span style="color:#a47148; font-size:11px;">← you</span>' : ''}</td>
      <td style="padding:4px 8px; text-align:right; font-family:monospace; font-weight:600;">${fmtNum(r.totalScore)}</td>
    </tr>`)
    .join('');

  const bestRoundHtml = bestRound
    ? `<p style="font-size:15px; line-height:1.5; margin-top:24px;
                background:#e7f0ea; padding:10px 14px; border-radius:6px;">
         <strong>Your best round:</strong>
         R${bestRound.roundNum} — ${escapeHtml(bestRound.golfer)}
         at <strong>${fmtNum(bestRound.score)}</strong>.
       </p>`
    : '';

  const seasonHtml = (seasonStandings && seasonStandings.length > 0)
    ? `<h3 style="font-family:Georgia, serif; font-size:15px; margin-top:24px; margin-bottom:8px; color:#1d3a2a;">
         Season standings — ${escapeHtml(leagueName)}
       </h3>
       <table style="width:100%; border-collapse:collapse; border:1px solid #e6e6e6;">
         <thead>
           <tr style="background:#2d6a4f; color:#fff;">
             <th style="padding:6px 8px; text-align:right; font-size:11px;">RANK</th>
             <th style="padding:6px 8px; text-align:left;  font-size:11px;">PLAYER</th>
             <th style="padding:6px 8px; text-align:right; font-size:11px;">TOTAL</th>
             <th style="padding:6px 8px; text-align:right; font-size:11px;">PLAYED</th>
           </tr>
         </thead>
         <tbody>
           ${seasonStandings.map(r => `<tr style="${r.isMe ? 'background:#fff9e6;' : ''}">
             <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${r.rank ?? '—'}</td>
             <td style="padding:4px 8px;">${escapeHtml(r.displayName)}${r.isMe ? ' <span style="color:#a47148; font-size:11px;">← you</span>' : ''}</td>
             <td style="padding:4px 8px; text-align:right; font-family:monospace; font-weight:600;">${r.totalScore}</td>
             <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${r.tournamentsPlayed}</td>
           </tr>`).join('')}
         </tbody>
       </table>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#2c2c2c;">
  <div style="text-align:center; margin-bottom:20px;">
    <div style="font-size:36px;">🏆</div>
    <h1 style="font-family:Georgia, serif; font-weight:700; font-size:22px; margin:6px 0 0;">Fairway Fantasy</h1>
    <p style="color:#777; font-size:13px; margin:4px 0 0;">Tournament Recap</p>
  </div>

  <p style="font-size:15px; line-height:1.5;">
    Hi ${escapeHtml(displayName)},<br>
    <strong>${escapeHtml(tournamentName)}</strong> is in the books.
    Here's how <strong>${escapeHtml(leagueName)}</strong> finished.
  </p>

  <h3 style="font-family:Georgia, serif; font-size:15px; margin-top:24px; margin-bottom:8px; color:#1d3a2a;">
    Final standings
  </h3>
  <table style="width:100%; border-collapse:collapse; border:1px solid #e6e6e6;">
    <thead>
      <tr style="background:#2d6a4f; color:#fff;">
        <th style="padding:6px 8px; text-align:right; font-size:11px;">RANK</th>
        <th style="padding:6px 8px; text-align:left;  font-size:11px;">PLAYER</th>
        <th style="padding:6px 8px; text-align:right; font-size:11px;">TOTAL</th>
      </tr>
    </thead>
    <tbody>${lbHtml}</tbody>
  </table>

  ${bestRoundHtml}
  ${seasonHtml}

  <div style="text-align:center; margin:28px 0 8px;">
    <a href="${escapeHtml(leagueUrl)}" style="display:inline-block; padding:12px 22px; background:#2d6a4f; color:#fff; text-decoration:none; border-radius:6px; font-weight:700; font-size:14px;">
      View full leaderboard
    </a>
  </div>

  <p style="font-size:11px; color:#aaa; margin-top:24px; padding-top:14px; border-top:1px solid #e6e6e6; text-align:center;">
    You're getting this because you're a member of ${escapeHtml(leagueName)}.
    Toggle the tournament-recap email off in your account if you'd rather not get it.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
