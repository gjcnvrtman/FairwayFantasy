// ============================================================
// Daily-scorecard PDF generator.
//
// Builds the landscape scorecard attached to the post-round-complete
// daily email (sync.ts:detectAndSendDailyScorecards, 2026-06-04).
// Layout per Greg's spec:
//   - One combined card per user, 4 golfer rows on the same 18-hole
//     grid (not 4 separate cards).
//   - Header: tournament name + round + league + user.
//   - Body: hole header row (1..18 + OUT + IN + TOT), then 4 golfer
//     rows showing per-hole strokes + the same totals.
//
// pdfkit drives drawing. The result is a single-page Buffer ready
// to attach via nodemailer. No external font assets — Helvetica
// ships with pdfkit.
// ============================================================

import PDFDocument from 'pdfkit';

export interface ScorecardGolfer {
  name:    string;
  /** Per-hole strokes, length 0..18. Missing holes render as "". */
  strokes: number[];
  /** Slot label ("Top 1", "DH 1") for the leftmost column subline. */
  slotLabel?: string;
}

export interface ScorecardInput {
  tournamentName: string;
  /** Round number (1..4) printed in the header. */
  roundNum:       number;
  leagueName:     string;
  userName:       string;
  /** Played-on date (e.g. "Thursday, June 4 2026") for the header. */
  dateLabel?:     string;
  golfers:        ScorecardGolfer[];  // expected length 4; we render whatever's given
  /**
   * Course par per hole, length 0..18. When provided, a PAR row
   * renders above the player rows and each stroke cell is color-
   * coded vs par (under = green, over = red, par = neutral). Pass
   * `null` (or omit) to fall back to the v1 layout without par.
   */
  parByHole?:     Array<number | null> | null;
}

/**
 * Resolve the buffer of a built PDFDocument. pdfkit's `Buffer`
 * mode requires us to listen to 'data' + 'end' events because the
 * doc is a stream. Promise wraps the typical boilerplate.
 */
function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data',  (chunk: Buffer) => chunks.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * Sum the first `n` slots of an array. Treats `undefined`/non-numeric
 * as zero so a partial round (e.g. thru 12) still produces a sensible
 * OUT total once the front nine is complete.
 */
function sumRange(arr: number[], start: number, end: number): number {
  let t = 0;
  for (let i = start; i < end && i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) t += v;
  }
  return t;
}

/**
 * `count` is how many of [start..end) have a real numeric value. Used
 * to decide whether to print the cumulative total cell ("don't show
 * OUT until all 9 front-nine holes are scored").
 */
function countScored(arr: number[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end && i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) n += 1;
  }
  return n;
}

export async function generateDailyScorecardPdf(input: ScorecardInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size:    'LETTER',
    layout:  'landscape',
    margin:  36,           // 0.5 inch
    info: {
      Title:   `Fairway Fantasy Scorecard — ${input.tournamentName} R${input.roundNum} — ${input.userName}`,
      Author:  'Fairway Fantasy',
      Subject: `Round ${input.roundNum} daily scorecard`,
    },
  });

  // Margins → drawable area inside Letter landscape (792x612).
  const PAGE_W = 792, PAGE_H = 612, MARGIN = 36;
  const drawW  = PAGE_W - 2 * MARGIN;       // 720

  // ── Header band ────────────────────────────────────────────
  const headerY = MARGIN;
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1d3a2a')
     .text('FAIRWAY FANTASY', MARGIN, headerY, { width: drawW, align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor('#555')
     .text('Daily Scorecard', MARGIN, headerY + 26, { width: drawW, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#222')
     .text(input.tournamentName, MARGIN, headerY + 50, { width: drawW, align: 'center' });

  const subline =
    `Round ${input.roundNum}` +
    (input.dateLabel ? ` · ${input.dateLabel}` : '') +
    ` · League: ${input.leagueName}` +
    ` · Player: ${input.userName}`;
  doc.font('Helvetica').fontSize(10).fillColor('#666')
     .text(subline, MARGIN, headerY + 70, { width: drawW, align: 'center' });

  // ── Layout the grid ────────────────────────────────────────
  // Player column then 18 holes then OUT, IN, TOT. Compute widths
  // proportionally so it auto-adjusts if drawW changes.
  const tableY     = headerY + 100;
  const playerW    = 140;
  const totalsW    = 36;         // OUT, IN cell width
  const grandW     = 50;         // TOT cell width
  const remaining  = drawW - playerW - 2 * totalsW - grandW;
  const holeW      = Math.floor(remaining / 18);
  const tableW     = playerW + 18 * holeW + 2 * totalsW + grandW;
  const tableX     = MARGIN + Math.floor((drawW - tableW) / 2);  // center

  const headRowH   = 22;
  const parRowH    = 22;
  const bodyRowH   = 26;
  const hasPar     = Array.isArray(input.parByHole) && input.parByHole.length > 0;

  // Vertical line offsets — accumulated x positions of column edges.
  const cols: number[] = [];
  let cx = tableX;
  cols.push(cx);                     // start
  cx += playerW; cols.push(cx);      // after player
  for (let i = 0; i < 18; i++) { cx += holeW; cols.push(cx); }   // after each hole
  cx += totalsW; cols.push(cx);      // after OUT
  cx += totalsW; cols.push(cx);      // after IN
  cx += grandW;  cols.push(cx);      // after TOT
  const tableRightX = cx;

  const numBodyRows = input.golfers.length;
  const parBlockH   = hasPar ? parRowH : 0;
  const tableBottomY = tableY + headRowH + parBlockH + numBodyRows * bodyRowH;

  // ── Header row background ──────────────────────────────────
  doc.save();
  doc.rect(tableX, tableY, tableW, headRowH).fill('#2d6a4f');
  doc.restore();

  // Header text — Player + 1..18 + OUT + IN + TOT
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  const headerLabel = (label: string, x: number, w: number) => {
    doc.text(label, x, tableY + 7, { width: w, align: 'center' });
  };
  headerLabel('PLAYER', cols[0], playerW);
  for (let h = 1; h <= 18; h++) {
    headerLabel(String(h), cols[h], holeW);
  }
  headerLabel('OUT', cols[19], totalsW);
  headerLabel('IN',  cols[20], totalsW);
  headerLabel('TOT', cols[21], grandW);

  // ── PAR row (between header and body) ──────────────────────
  // Course par per hole + course-total OUT/IN/TOT. Rendered with a
  // soft tint so it visually anchors as "the reference line."
  let bodyTop = tableY + headRowH;
  if (hasPar) {
    const parArr = (input.parByHole as Array<number | null>).slice(0, 18);
    doc.save();
    doc.rect(tableX, bodyTop, tableW, parRowH).fill('#e7f0ea');
    doc.restore();

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1d3a2a');
    doc.text('PAR', cols[0] + 6, bodyTop + 6, { width: playerW - 8 });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d3a2a');
    for (let h = 0; h < 18; h++) {
      const p = parArr[h];
      const txt = (typeof p === 'number' && Number.isFinite(p)) ? String(p) : '';
      doc.text(txt, cols[h + 1], bodyTop + 6, { width: holeW, align: 'center' });
    }
    const parFront = sumRange(parArr.map(p => p ?? NaN).filter(n => !isNaN(n) as boolean) as number[], 0, 9);
    const parBack  = sumRange(parArr.map(p => p ?? NaN).filter(n => !isNaN(n) as boolean) as number[], 9, 18);
    // Tighter: sum only when all 9 of that side have par
    const parFrontReady = parArr.slice(0, 9).every(p => typeof p === 'number');
    const parBackReady  = parArr.slice(9, 18).every(p => typeof p === 'number');
    const parTotalReady = parFrontReady && parBackReady;
    doc.text(parFrontReady ? String(parFront) : '', cols[19], bodyTop + 6, { width: totalsW, align: 'center' });
    doc.text(parBackReady  ? String(parBack)  : '', cols[20], bodyTop + 6, { width: totalsW, align: 'center' });
    doc.text(parTotalReady ? String(parFront + parBack) : '', cols[21], bodyTop + 6, { width: grandW, align: 'center' });

    bodyTop += parRowH;
  }

  // ── Body rows ──────────────────────────────────────────────
  doc.font('Helvetica').fontSize(11).fillColor('#222');
  for (let r = 0; r < numBodyRows; r++) {
    const rowY = bodyTop + r * bodyRowH;
    // Zebra background for legibility.
    if (r % 2 === 0) {
      doc.save();
      doc.rect(tableX, rowY, tableW, bodyRowH).fill('#f7faf6');
      doc.restore();
    }

    // Player cell — name on top, optional slot label below.
    const g = input.golfers[r];
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d3a2a');
    const nameClipped = g.name.length > 28 ? g.name.slice(0, 25) + '…' : g.name;
    doc.text(nameClipped, cols[0] + 6, rowY + 5, { width: playerW - 8 });
    if (g.slotLabel) {
      doc.font('Helvetica').fontSize(8).fillColor('#8a8a8a');
      doc.text(g.slotLabel, cols[0] + 6, rowY + 17, { width: playerW - 8 });
    }

    // Per-hole strokes — color-coded vs par when we have par data:
    //   < par   → green (birdie / eagle)
    //   = par   → neutral dark
    //   > par   → red (bogey or worse)
    const parArr = hasPar ? (input.parByHole as Array<number | null>) : null;
    doc.font('Helvetica').fontSize(11);
    for (let h = 0; h < 18; h++) {
      const v = g.strokes[h];
      const txt = (typeof v === 'number' && Number.isFinite(v) && v > 0) ? String(v) : '';
      let color = '#222';
      if (parArr && typeof v === 'number' && typeof parArr[h] === 'number') {
        const par = parArr[h] as number;
        if      (v <  par) color = '#2d6a4f';   // under par — green
        else if (v >  par) color = '#b53e3e';   // over par — red
        else               color = '#222';      // par      — neutral
      }
      doc.fillColor(color)
         .text(txt, cols[h + 1], rowY + 7, { width: holeW, align: 'center' });
    }

    // OUT (1-9), IN (10-18), TOT
    const front = countScored(g.strokes, 0, 9)  === 9 ? sumRange(g.strokes, 0, 9)  : null;
    const back  = countScored(g.strokes, 9, 18) === 9 ? sumRange(g.strokes, 9, 18) : null;
    const tot   = (front != null && back != null) ? front + back : null;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d3a2a');
    doc.text(front != null ? String(front) : '', cols[19], rowY + 7, { width: totalsW, align: 'center' });
    doc.text(back  != null ? String(back)  : '', cols[20], rowY + 7, { width: totalsW, align: 'center' });
    doc.text(tot   != null ? String(tot)   : '', cols[21], rowY + 7, { width: grandW,  align: 'center' });
  }

  // ── Grid lines ─────────────────────────────────────────────
  // Outer rectangle + vertical column edges + horizontal row dividers.
  doc.save();
  doc.lineWidth(0.6).strokeColor('#cbd5d0');
  // Outer
  doc.rect(tableX, tableY, tableW, tableBottomY - tableY).stroke();
  // Verticals
  for (let i = 1; i < cols.length - 1; i++) {
    doc.moveTo(cols[i], tableY).lineTo(cols[i], tableBottomY).stroke();
  }
  // Header row divider (heavier)
  doc.lineWidth(1.0).strokeColor('#1d3a2a');
  doc.moveTo(tableX, tableY + headRowH).lineTo(tableRightX, tableY + headRowH).stroke();
  // PAR row divider (slightly heavier than body dividers so PAR
  // visually separates from the player block).
  if (hasPar) {
    doc.lineWidth(0.8).strokeColor('#92aa9c');
    doc.moveTo(tableX, bodyTop).lineTo(tableRightX, bodyTop).stroke();
  }
  // Body row dividers
  doc.lineWidth(0.4).strokeColor('#d8e2dc');
  for (let r = 1; r < numBodyRows; r++) {
    const y = bodyTop + r * bodyRowH;
    doc.moveTo(tableX, y).lineTo(tableRightX, y).stroke();
  }
  doc.restore();

  // ── Footer band ────────────────────────────────────────────
  const footerY = tableBottomY + 30;
  doc.font('Helvetica').fontSize(8).fillColor('#9a9a9a');
  doc.text(
    'Fairway Fantasy — Daily Scorecard. ' +
    'Strokes per hole are sourced from ESPN\'s live PGA Tour feed. ' +
    'Blank cells indicate ESPN had not posted that hole at the moment of generation.',
    MARGIN, footerY, { width: drawW, align: 'center' },
  );

  return await toBuffer(doc);
}
