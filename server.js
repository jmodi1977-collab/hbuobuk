/**
 * SafeEndo Rewards — Backend Server
 * ─────────────────────────────────
 * Handles:
 *   1. WhatsApp incoming messages  (Twilio webhook)
 *   2. /verify   — checks Google Sheet before spin
 *   3. /record-spin — marks Has_Spun = Yes after win
 *
 * Deploy on Render.com (free tier) or Railway.
 * Set environment variables listed in .env.example
 */

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const twilio     = require('twilio');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));   // required for Twilio webhooks

// ─── Google Sheets Auth ───────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Registrations';   // the tab name

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ─── Helpers ──────────────────────────────────

/** Normalise: strip spaces / dashes, ensure leading + */
function normalise(num) {
  return num.replace(/[\s\-\(\)]/g, '');
}

/** Find a row by mobile number. Returns { rowIndex, data } or null */
async function findRow(mobile) {
  const sheets = await getSheets();
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:C`,   // Mobile_Number | Is_Registered | Has_Spun
  });
  const rows = res.data.values || [];
  // Row 0 = header
  for (let i = 1; i < rows.length; i++) {
    if (normalise(rows[i][0] || '') === normalise(mobile)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

/** Append a new registered row */
async function appendRow(mobile) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:C`,
    valueInputOption: 'RAW',
    requestBody: { values: [[normalise(mobile), 'Yes', 'No']] },
  });
}

/** Update Has_Spun to Yes for a specific row */
async function markSpun(rowIndex) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Yes']] },
  });
}

// ─────────────────────────────────────────────
//  1. WhatsApp Bot  (Twilio Webhook)
//  POST /whatsapp
// ─────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const twiml     = new twilio.twiml.MessagingResponse();
  const incoming  = (req.body.Body || '').trim();
  const fromNum   = req.body.From || '';          // e.g. "whatsapp:+919876543210"
  const mobile    = fromNum.replace('whatsapp:', '');

  // First message from a number — treat ANY message as "I want to register"
  const existing = await findRow(mobile);

  if (!existing) {
    // New user — register them
    await appendRow(mobile);
    twiml.message(
      `✅ Hi! You're now registered with SafeEndo Rewards.\n\n` +
      `🎡 Visit this link to spin your lucky wheel and win a SafeEndo product:\n\n` +
      `👉 https://safeendo-rewards.com\n\n` +
      `Enter your number *${mobile}* on the site to unlock your spin. Good luck! 🍀`
    );
  } else if (existing.data[2] === 'Yes') {
    // Already spun
    twiml.message(
      `🎯 Hi! You've already used your spin.\n\n` +
      `Each registered number gets exactly one spin. ` +
      `Contact your SafeEndo representative for more information.`
    );
  } else {
    // Registered but hasn't spun yet
    twiml.message(
      `👋 You're already registered!\n\n` +
      `🎡 Head to https://safeendo-rewards.com and enter your number *${mobile}* to spin. Good luck!`
    );
  }

  res.type('text/xml').send(twiml.toString());
});

// ─────────────────────────────────────────────
//  2. Verify  (called by spin wheel website)
//  POST /verify   { "mobile": "+919876543210" }
// ─────────────────────────────────────────────
app.post('/verify', async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.json({ success: false, message: 'Mobile number is required.' });

  try {
    const row = await findRow(mobile);

    if (!row) {
      return res.json({
        success: false,
        message: '❌ This number is not registered. Please message us on WhatsApp first to register.',
      });
    }

    const isRegistered = row.data[1] === 'Yes';
    const hasSpun      = row.data[2] === 'Yes';

    if (!isRegistered) {
      return res.json({ success: false, message: '⚠️ Registration not confirmed. Please contact support.' });
    }
    if (hasSpun) {
      return res.json({ success: false, message: '🎯 You\'ve already used your one free spin! Each number gets one spin only.' });
    }

    return res.json({ success: true, message: 'Verified! Good luck! 🍀' });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again shortly.' });
  }
});

// ─────────────────────────────────────────────
//  3. Record Spin  (called after wheel stops)
//  POST /record-spin   { "mobile": "...", "prize": "ProTaper Gold" }
// ─────────────────────────────────────────────
app.post('/record-spin', async (req, res) => {
  const { mobile, prize } = req.body;
  if (!mobile) return res.json({ success: false });

  try {
    const row = await findRow(mobile);
    if (!row) return res.json({ success: false, message: 'Row not found.' });

    await markSpun(row.rowIndex);
    console.log(`✅ Spin recorded for ${mobile} — won: ${prize}`);
    return res.json({ success: true });

  } catch (err) {
    console.error('Record-spin error:', err);
    return res.status(500).json({ success: false });
  }
});

// ─────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'SafeEndo Rewards API running ✅' }));

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
