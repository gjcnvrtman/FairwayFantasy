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
  /** When true, this email is a CORRECTION re-send. The subject gets a
   *  "[Corrected]" prefix, the body opens with a banner explaining the
   *  re-send, and every score / rank value is rendered in **bold** so
   *  recipients can see at a glance what changed since the original. */
  corrected?:      boolean;
}): { subject: string; text: string; html: string } {
  const {
    displayName, leagueName, leagueSlug, tournamentName,
    leaderboard, bestRound, seasonStandings, siteUrl,
    corrected = false,
  } = params;

  const leagueUrl = `${siteUrl}/league/${leagueSlug}`;

  const fmtNum = (n: number | null) => (n == null ? '—' : (n > 0 ? `+${n}` : String(n)));
  // Plain-text bold marker — Markdown-style **x**. Renders fine in
  // text-only clients (the asterisks stay literal); HTML clients use
  // the <strong> wrapping below.
  const tb = (s: string) => corrected ? `**${s}**` : s;

  // ── plain text ────────────────────────────────────────────
  const lbText = leaderboard
    .map(r => `  ${tb(String(r.rank).padStart(2))}.  ${r.displayName.padEnd(20)}  ${tb(fmtNum(r.totalScore))}${r.isMe ? '  ← you' : ''}`)
    .join('\n');

  const bestRoundText = bestRound
    ? `Your best round: R${bestRound.roundNum} — ${bestRound.golfer} at ${tb(fmtNum(bestRound.score))}.\n\n`
    : '';

  const seasonText = (seasonStandings && seasonStandings.length > 0)
    ? `SEASON STANDINGS (${leagueName}):\n` +
      seasonStandings
        .map(r => `  ${tb(r.rank == null ? '—' : String(r.rank).padStart(2))}.  ` +
                  `${r.displayName.padEnd(20)}  ` +
                  `${tb(String(r.totalScore).padStart(5))}  ` +
                  `(${r.tournamentsPlayed} played)${r.isMe ? '  ← you' : ''}`)
        .join('\n') + '\n\n'
    : '';

  const correctionBannerText = corrected
    ? `*** CORRECTED ***\n` +
      `Sunday's recap email contained inaccurate Round 4 scores due to a sync\n` +
      `issue (the tournament was prematurely marked complete before R4 had\n` +
      `actually been played). The corrected final standings are below. Figures\n` +
      `that have been updated since the original email are shown in **bold**.\n\n`
    : '';

  const subject = (corrected ? '[Corrected] ' : '') +
    `[Fairway Fantasy] ${tournamentName} — tournament recap for ${leagueName}`;

  const text = `
Hi ${displayName},

${correctionBannerText}${tournamentName} is in the books. Here's how ${leagueName} finished.

FINAL STANDINGS:
${lbText}

${bestRoundText}${seasonText}See the full leaderboard at:
${leagueUrl}

— Fairway Fantasy
`.trim();

  // ── HTML ──────────────────────────────────────────────────
  // HTML bold marker — wraps the value in <strong> with a subtle
  // background tint when this is a correction re-send. Both visual
  // cues so the change is obvious even at a glance.
  const hb = (s: string) => corrected
    ? `<strong style="background:#fff3cd; padding:1px 4px; border-radius:3px;">${s}</strong>`
    : s;

  const lbHtml = leaderboard
    .map(r => `<tr style="${r.isMe ? 'background:#fff9e6;' : ''}">
      <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${hb(String(r.rank))}</td>
      <td style="padding:4px 8px;">${escapeHtml(r.displayName)}${r.isMe ? ' <span style="color:#a47148; font-size:11px;">← you</span>' : ''}</td>
      <td style="padding:4px 8px; text-align:right; font-family:monospace; font-weight:600;">${hb(fmtNum(r.totalScore))}</td>
    </tr>`)
    .join('');

  const bestRoundHtml = bestRound
    ? `<p style="font-size:15px; line-height:1.5; margin-top:24px;
                background:#e7f0ea; padding:10px 14px; border-radius:6px;">
         <strong>Your best round:</strong>
         R${bestRound.roundNum} — ${escapeHtml(bestRound.golfer)}
         at ${hb(fmtNum(bestRound.score))}.
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
             <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#555;">${hb(String(r.rank ?? '—'))}</td>
             <td style="padding:4px 8px;">${escapeHtml(r.displayName)}${r.isMe ? ' <span style="color:#a47148; font-size:11px;">← you</span>' : ''}</td>
             <td style="padding:4px 8px; text-align:right; font-family:monospace; font-weight:600;">${hb(String(r.totalScore))}</td>
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

  ${corrected ? `<div style="border:2px solid #d4a73a; background:#fffaeb; padding:14px 18px; border-radius:8px; margin:18px 0; font-size:14px; line-height:1.55; color:#5a4416;">
    <div style="font-weight:700; font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#a47148; margin-bottom:6px;">⚠ Corrected recap</div>
    Sunday's recap email contained inaccurate Round 4 scores due to a sync
    issue — the tournament was prematurely marked complete before R4 had
    actually been played. The corrected final standings are below. Figures
    that have been updated since the original email are highlighted in
    <strong style="background:#fff3cd; padding:1px 4px; border-radius:3px;">bold</strong>.
  </div>` : ''}

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

// ============================================================
// FIELD-PUBLISHED — "ESPN set the lineup, go make your picks"
// ============================================================
//
// Replaces the old dispatch-via-notifier path (which never actually
// sent anything — it routed through the placeholder console driver
// that's still the only registered ChannelDriver as of 2026-06-16).
// Sends directly via sendEmail/msmtp like the other player-facing
// emails.

export function fieldPublishedEmail(params: {
  recipientName:  string;
  leagueName:     string;
  leagueSlug:     string;
  tournamentName: string;
  /** Best available pick deadline (override > computed). May be null
   *  if neither is set; the section just won't render. */
  pickDeadline:   Date | null;
  siteUrl:        string;
}): { subject: string; text: string; html: string } {
  const { recipientName, leagueName, leagueSlug, tournamentName, pickDeadline, siteUrl } = params;
  const picksUrl = `${siteUrl}/league/${leagueSlug}/picks`;

  const dlPretty = pickDeadline
    ? pickDeadline.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
        timeZoneName: 'short',
      })
    : null;

  const subject = `[${leagueName}] Field set — make your picks for ${tournamentName}`;

  const text = `
Hi ${recipientName},

The field is set for ${tournamentName}.

ESPN just published the player list, so you can now build your foursome.${dlPretty ? `\n\nPick deadline: ${dlPretty}.` : ''}

Make your picks:
${picksUrl}

— Fairway Fantasy

(You're receiving this because the "Field set" alert is on in your account. Toggle it off at ${siteUrl}/account if you'd rather not get these.)
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#2c2c2c;">
  <div style="text-align:center; margin-bottom:20px;">
    <div style="font-size:36px;">⛳</div>
    <h1 style="font-family:Georgia, serif; font-weight:700; font-size:22px; margin:6px 0 0;">Fairway Fantasy</h1>
    <p style="color:#777; font-size:13px; margin:4px 0 0;">Field is set</p>
  </div>

  <p style="font-size:15px; line-height:1.5;">
    Hi ${escapeHtml(recipientName)},<br>
    The field is set for <strong>${escapeHtml(tournamentName)}</strong>.
    ESPN just published the player list, so you can now build your foursome in
    <strong>${escapeHtml(leagueName)}</strong>.
  </p>

  ${dlPretty ? `<p style="font-size:15px; line-height:1.5; margin-top:16px;
                          background:#e7f0ea; padding:10px 14px; border-radius:6px;">
    <strong>Pick deadline:</strong> ${escapeHtml(dlPretty)}
  </p>` : ''}

  <div style="text-align:center; margin:28px 0 8px;">
    <a href="${escapeHtml(picksUrl)}" style="display:inline-block; padding:12px 22px; background:#2d6a4f; color:#fff; text-decoration:none; border-radius:6px; font-weight:700; font-size:14px;">
      Make your picks
    </a>
  </div>

  <p style="font-size:11px; color:#aaa; margin-top:24px; padding-top:14px; border-top:1px solid #e6e6e6; text-align:center;">
    You're receiving this because the "Field set" alert is on in your account.
    Toggle it off at <a href="${escapeHtml(siteUrl)}/account" style="color:#888;">your account</a>
    if you'd rather not get these.
  </p>
</body>
</html>
`.trim();

  return { subject, text, html };
}

// ============================================================
// LEAGUE BROADCAST — commissioner-authored email to every league member
// ============================================================

export function leagueBroadcastEmail(params: {
  /** Display name of the recipient (per-recipient personalization). */
  recipientName:  string;
  leagueName:     string;
  leagueSlug:     string;
  /** Display name of the commissioner / co-commissioner who sent it. */
  fromName:       string;
  subject:        string;
  /** Plain-text message body authored by the commissioner. Rendered
   *  as paragraphs split on blank lines; line breaks inside a paragraph
   *  are preserved with <br>. No HTML / markdown supported — we
   *  escape and present what they typed. */
  body:           string;
  siteUrl:        string;
}): { subject: string; text: string; html: string } {
  const {
    recipientName, leagueName, leagueSlug, fromName, subject, body, siteUrl,
  } = params;

  const leagueUrl = `${siteUrl}/league/${leagueSlug}`;
  const fullSubject = `[${leagueName}] ${subject}`;

  // Plain-text version: untouched body, prefixed greeting + signed off.
  const text = `
Hi ${recipientName},

${body}

— ${fromName}, commissioner of ${leagueName}

(View the league: ${leagueUrl})
`.trim();

  // HTML body: escape user input, split on \n\n into <p>, single
  // newlines into <br>. Keeps it readable without trusting any
  // HTML the commissioner might paste in.
  const bodyHtml = body
    .split(/\n{2,}/)
    .map(para => `<p style="margin:0 0 1em; font-size:15px; line-height:1.55;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#2c2c2c;">
  <div style="text-align:center; margin-bottom:20px;">
    <div style="font-size:36px;">⛳</div>
    <h1 style="font-family:Georgia, serif; font-weight:700; font-size:22px; margin:6px 0 0;">${escapeHtml(leagueName)}</h1>
    <p style="color:#777; font-size:13px; margin:4px 0 0;">A note from your commissioner</p>
  </div>

  <p style="font-size:15px; line-height:1.5; margin:0 0 1.2em;">
    Hi ${escapeHtml(recipientName)},
  </p>

  ${bodyHtml}

  <p style="font-size:14px; line-height:1.5; margin-top:1.6em; color:#555;">
    — <strong>${escapeHtml(fromName)}</strong><br>
    <span style="color:#888;">Commissioner, ${escapeHtml(leagueName)}</span>
  </p>

  <div style="text-align:center; margin:28px 0 8px;">
    <a href="${escapeHtml(leagueUrl)}" style="display:inline-block; padding:12px 22px; background:#2d6a4f; color:#fff; text-decoration:none; border-radius:6px; font-weight:700; font-size:14px;">
      View the league
    </a>
  </div>

  <p style="font-size:11px; color:#aaa; margin-top:24px; padding-top:14px; border-top:1px solid #e6e6e6; text-align:center;">
    You're getting this because you're a member of ${escapeHtml(leagueName)}.
    Replies to this email go to ${escapeHtml(fromName)}'s personal address — not Fairway Fantasy.
  </p>
</body>
</html>
`.trim();

  return { subject: fullSubject, text, html };
}

// ── Course-fit prediction emails ──────────────────────────────

export interface PredictionsEmailFoursome {
  rank:           number;
  topTier1Name:   string;
  topTier2Name:   string;
  darkHorse1Name: string;
  darkHorse2Name: string;
  projectedScore: number;
  confidence:     number;       // 0..1
  riskLevel:      'conservative' | 'balanced' | 'aggressive';
  ownership:      number | null; // 0..100 percentage
  explanation:    string | null;
  keyStrengths:   string[];
  keyConcerns:    string[];
}

/** Fired after a prediction run completes successfully — sends the
 *  top-5 foursomes to the platform admins. */
export function predictionsReadyEmail(params: {
  recipientName:    string;
  tournamentName:   string;
  courseName:       string | null;
  asOfDate:         string;
  foursomes:        PredictionsEmailFoursome[];
  fieldSize:        number;
  golfersWithMissingStats: number;
  missingInputsByField:    Record<string, number>;
  siteUrl:          string;
  runId:            string;
}): { subject: string; text: string; html: string } {
  const { recipientName, tournamentName, courseName, asOfDate, foursomes,
          fieldSize, golfersWithMissingStats, missingInputsByField, siteUrl, runId } = params;
  const runUrl = `${siteUrl}/predictions/current`;
  const subject = `Top 5 predicted foursomes — ${tournamentName}`;

  const fmtFoursomeText = (f: PredictionsEmailFoursome): string => {
    const own = f.ownership != null ? ` · ${f.ownership.toFixed(1)}% ownership` : '';
    const strengths = f.keyStrengths.length ? `\n   ✓ ${f.keyStrengths.join(' · ')}` : '';
    const concerns  = f.keyConcerns.length  ? `\n   ⚠ ${f.keyConcerns.join(' · ')}`  : '';
    return `#${f.rank}  Projected: ${f.projectedScore.toFixed(1)} vs par  ·  Conf: ${(f.confidence * 100).toFixed(0)}%  ·  ${f.riskLevel.toUpperCase()}${own}
   Top-tier:   ${f.topTier1Name}, ${f.topTier2Name}
   Dark horse: ${f.darkHorse1Name}, ${f.darkHorse2Name}${f.explanation ? `\n   ${f.explanation}` : ''}${strengths}${concerns}`;
  };

  const missingNote = Object.keys(missingInputsByField).length > 0
    ? `\nData notes: ${golfersWithMissingStats} of ${fieldSize} golfers running on partial data. Missing fields: ${
        Object.entries(missingInputsByField).map(([k, v]) => `${k}=${v}`).join(', ')
      }.`
    : '';

  const text = `
Hi ${recipientName},

Course-fit predictions for ${tournamentName}${courseName ? ` at ${courseName}` : ''} are ready.

Run as-of: ${asOfDate}   ·   Field: ${fieldSize} golfers${missingNote}

TOP 5 FOURSOMES (lower projected score = better)
============================================================
${foursomes.map(fmtFoursomeText).join('\n\n')}

View on site:
${runUrl}

These are model predictions, not guarantees.

— FairwayFantasy predictor
`.trim();

  const fmtFoursomeHtml = (f: PredictionsEmailFoursome): string => {
    const own = f.ownership != null
      ? `<span style="color:#666; margin-left:8px;">${f.ownership.toFixed(1)}% own</span>` : '';
    const riskColor = f.riskLevel === 'conservative' ? '#3a8e5b'
                    : f.riskLevel === 'aggressive'   ? '#cc7a3a' : '#3a6ea5';
    return `
      <div style="border:1px solid #ddd; border-radius:8px; padding:14px; margin-bottom:12px;">
        <div>
          <span style="font-size:24px; font-weight:800; color:#888;">#${f.rank}</span>
          <strong style="margin-left:8px;">${escapeHtml(f.topTier1Name)}</strong>,
          <strong>${escapeHtml(f.topTier2Name)}</strong>
          &nbsp;·&nbsp; ${escapeHtml(f.darkHorse1Name)}, ${escapeHtml(f.darkHorse2Name)}
        </div>
        <div style="margin-top:8px; font-size:13px; color:#444;">
          Proj <strong>${f.projectedScore.toFixed(1)}</strong> vs par
          &nbsp;·&nbsp; Conf <strong>${(f.confidence * 100).toFixed(0)}%</strong>
          &nbsp;·&nbsp; <span style="color:${riskColor}; font-weight:600;">${f.riskLevel.toUpperCase()}</span>
          ${own}
        </div>
        ${f.explanation ? `<p style="margin:8px 0 0; font-size:13px; color:#555;">${escapeHtml(f.explanation)}</p>` : ''}
        ${f.keyStrengths.length ? `<p style="margin:4px 0 0; font-size:12px; color:#3a8e5b;">✓ ${f.keyStrengths.map(escapeHtml).join(' · ')}</p>` : ''}
        ${f.keyConcerns.length  ? `<p style="margin:4px 0 0; font-size:12px; color:#c66;">⚠ ${f.keyConcerns.map(escapeHtml).join(' · ')}</p>`  : ''}
      </div>`;
  };

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif; max-width:680px; margin:0 auto; padding:24px;">
  <h2 style="margin:0 0 4px;">Top 5 predicted foursomes</h2>
  <p style="margin:0 0 4px; color:#666;">${escapeHtml(tournamentName)}${courseName ? ` · ${escapeHtml(courseName)}` : ''}</p>
  <p style="margin:0 0 16px; color:#888; font-size:13px;">
    Run as-of ${escapeHtml(asOfDate)} · Field ${fieldSize} golfers · Lower projected score is better.
  </p>
  ${foursomes.map(fmtFoursomeHtml).join('')}
  ${Object.keys(missingInputsByField).length > 0 ? `
    <p style="margin-top:16px; padding:10px 12px; background:#fff8e1; border:1px solid #f0c060; border-radius:4px; font-size:12px;">
      ${golfersWithMissingStats} of ${fieldSize} golfers on partial data.
      Missing field counts: ${Object.entries(missingInputsByField).map(([k, v]) => `${escapeHtml(k)}=${v}`).join(', ')}.
    </p>` : ''}
  <p style="margin-top:20px; font-size:13px;">
    <a href="${runUrl}" style="color:#1a3a2e;">View on site</a>
  </p>
  <p style="margin-top:20px; font-size:11px; color:#999;">
    Model predictions, not guarantees. Run id ${runId}.
  </p>
</body></html>`;

  return { subject, text, html };
}

/** Fired when ESPN publishes a field but the course profile hasn't
 *  been curated yet — predictor can't run. Tells the admin what to do. */
export function fieldPublishedNoProfileEmail(params: {
  recipientName:  string;
  tournamentName: string;
  startDate:      string;
  tournamentId:   string;
  defaultCourseName: string | null;
  siteUrl:        string;
}): { subject: string; text: string; html: string } {
  const { recipientName, tournamentName, startDate, tournamentId,
          defaultCourseName, siteUrl } = params;
  const courseQuery = defaultCourseName
    ? `&course_name=${encodeURIComponent(defaultCourseName)}`
    : '';
  const profileUrl = `${siteUrl}/predictions/courses/new?tournament_id=${tournamentId}${courseQuery}`;
  const subject = `[Predictions] ${tournamentName} field is set — curate a course profile`;
  const text = `
Hi ${recipientName},

ESPN just published the field for ${tournamentName} (starts ${startDate}).
To get predictions, curate a course profile first — search the venue,
fill in importance weights, save. Then click Run predictions.

Curate profile:
${profileUrl}

— FairwayFantasy predictor
`.trim();
  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif; max-width:600px; margin:0 auto; padding:24px;">
  <h2 style="margin:0 0 8px;">${escapeHtml(tournamentName)} — field is set</h2>
  <p>ESPN published the field (event starts ${escapeHtml(startDate)}).
    To get predictions, curate a course profile first.</p>
  <p>
    <a href="${profileUrl}" style="display:inline-block; background:#1a3a2e; color:#fff;
       padding:10px 18px; border-radius:4px; text-decoration:none; font-weight:600;">
      Curate course profile
    </a>
  </p>
  <p style="font-size:11px; color:#999; margin-top:24px;">— FairwayFantasy predictor</p>
</body></html>`;
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
