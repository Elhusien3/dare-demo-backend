// ─────────────────────────────────────────────────────────────
//  Project D.A.R.E. — Twilio Call Trigger Backend
//  Deploy to Render.com (free tier) in 5 minutes
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Twilio credentials (set as env vars on Render) ──────────
const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;  // e.g. +14155552671
const BASE_URL      = process.env.BASE_URL;             // e.g. https://dare-demo.onrender.com

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Project D.A.R.E. — Exeed AI Lead Qualification Demo',
    version: '1.0.0'
  });
});

// ── TRIGGER CALL endpoint ────────────────────────────────────
// POST /call  { name, phone, model, city, timeline }
app.post('/call', async (req, res) => {
  const { name, phone, model, city, timeline } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  // Store lead data temporarily so the TwiML voice endpoint can read it
  const leadId = Date.now().toString();
  leads[leadId] = { name, phone, model, city, timeline };

  try {
    const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

    const call = await client.calls.create({
      url:  `${BASE_URL}/voice/${leadId}`,   // TwiML instructions
      to:    phone,
      from:  TWILIO_NUMBER,
      statusCallback: `${BASE_URL}/call-status/${leadId}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    console.log(`[${new Date().toISOString()}] Call initiated: ${call.sid} → ${phone} (${name})`);

    res.json({
      success: true,
      callSid: call.sid,
      status:  call.status,
      leadId,
      message: `Call initiated to ${phone}`
    });

  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Temporary in-memory store (fine for demo) ────────────────
const leads = {};

// ── TWIML VOICE endpoint ─────────────────────────────────────
// Twilio calls this URL to get instructions for what to say
app.all('/voice/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
  const name     = lead.name     || 'there';
  const model    = lead.model    || 'Exeed SUV';
  const city     = lead.city     || 'UAE';
  const timeline = lead.timeline || 'soon';

  // Build a natural, professional AI voice script
  const script = buildScript(name, model, city, timeline);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    ${script}
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    To confirm your interest, press 1. To speak with a consultant now, press 2. To be called back later, press 3.
  </Say>
  <Gather numDigits="1" action="/voice-response/${req.params.leadId}" method="POST" timeout="10">
  </Gather>
  <Say voice="Polly.Joanna" language="en-US">
    We did not receive your input. A consultant will follow up with you shortly. Thank you and have a great day!
  </Say>
</Response>`);
});

// ── GATHER RESPONSE endpoint ─────────────────────────────────
app.post('/voice-response/:leadId', (req, res) => {
  const digit = req.body.Digits;
  const lead  = leads[req.params.leadId] || {};

  let response = '';
  if (digit === '1') {
    response = `Thank you for confirming your interest in the ${lead.model || 'Exeed'}. An Exeed consultant in ${lead.city || 'your area'} will contact you within 2 hours. We look forward to helping you find your perfect vehicle. Goodbye!`;
  } else if (digit === '2') {
    response = `Connecting you to an Exeed sales consultant now. Please hold.`;
  } else if (digit === '3') {
    response = `Understood. We will call you back at a convenient time. Thank you for your interest in ${lead.model || 'Exeed'}. Goodbye!`;
  } else {
    response = `Thank you for your interest. An Exeed consultant will be in touch shortly. Goodbye!`;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">${response}</Say>
</Response>`);
});

// ── CALL STATUS WEBHOOK ──────────────────────────────────────
app.post('/call-status/:leadId', (req, res) => {
  const { CallStatus, CallSid, CallDuration } = req.body;
  const lead = leads[req.params.leadId] || {};
  console.log(`[STATUS] ${CallSid} → ${CallStatus} | Duration: ${CallDuration}s | Lead: ${lead.name}`);
  res.sendStatus(200);
});

// ── BUILD VOICE SCRIPT ───────────────────────────────────────
function buildScript(name, model, city, timeline) {
  const firstName = name.split(' ')[0];
  const urgency = {
    'Within 1 month': `I can see you are looking to purchase within the next month, which is very exciting.`,
    '1–3 months':     `I understand you are planning to purchase in the next one to three months.`,
    '3–6 months':     `I see you are considering a purchase in the coming months.`,
    'Just browsing':  `I understand you are currently exploring your options.`
  }[timeline] || '';

  return `
    Hello, may I speak with ${firstName}?
    <break time="500ms"/>
    This is the Exeed AI Assistant calling on behalf of Data Direct Group.
    <break time="300ms"/>
    We received your enquiry about the ${model}, and I am reaching out to confirm your interest.
    <break time="400ms"/>
    ${urgency}
    <break time="300ms"/>
    Our Exeed dealership team in ${city} is ready to assist you with a personalised test drive and exclusive offer.
    <break time="400ms"/>
  `;
}

// ── START SERVER ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ D.A.R.E. Backend running on port ${PORT}`);
  console.log(`   Twilio SID:    ${ACCOUNT_SID ? ACCOUNT_SID.substring(0,8)+'...' : '⚠️  NOT SET'}`);
  console.log(`   Twilio Number: ${TWILIO_NUMBER || '⚠️  NOT SET'}`);
  console.log(`   Base URL:      ${BASE_URL || '⚠️  NOT SET'}\n`);
});
