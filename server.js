require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const BASE_URL      = process.env.BASE_URL;

// ── In-memory lead store ─────────────────────────────────────
const leads = {};
const callState = {}; // tracks conversation state per call

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Project D.A.R.E. — AI Lead Qualification Backend v2' });
});

// ── TRIGGER CALL ─────────────────────────────────────────────
app.post('/call', async (req, res) => {
  const { name, phone, model, city, budget, timeline, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  const leadId = Date.now().toString();
  leads[leadId] = { name, phone, model, city, budget, timeline, email,
    status: 'In Progress', responses: {}, startTime: new Date().toISOString() };

  // Initialise conversation state
  callState[leadId] = { step: 'greeting', responses: {}, noResponseCount: 0 };

  try {
    const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
    const call = await client.calls.create({
      url:   `${BASE_URL}/voice/start/${leadId}`,
      to:    phone,
      from:  TWILIO_NUMBER,
      statusCallback:      `${BASE_URL}/call-status/${leadId}`,
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable',
    });

    console.log(`[${new Date().toISOString()}] Call initiated: ${call.sid} → ${phone} (${name})`);
    res.json({ success: true, callSid: call.sid, status: call.status, leadId });

  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ENSURE LEAD EXISTS (handles direct Twilio calls without /call endpoint) ──
function ensureLead(leadId) {
  if (!leads[leadId]) {
    leads[leadId] = {
      name: 'Customer', model: 'Exeed SUV', city: 'UAE',
      budget: 'Standard', timeline: 'Soon',
      status: 'In Progress', responses: {}, startTime: new Date().toISOString()
    };
    callState[leadId] = { step: 'greeting', responses: {}, noResponseCount: 0 };
  }
  if (!leads[leadId].responses) leads[leadId].responses = {};
  return leads[leadId];
}

// ── ANSWERING MACHINE DETECTION ───────────────────────────────
app.post('/voice/start/:leadId', (req, res) => {
  const lead = ensureLead(req.params.leadId);
  const name = (lead.name || 'there').split(' ')[0];
  const amdStatus = req.body.AnsweredBy;

  // If voicemail detected — leave a short message
  if (amdStatus && (amdStatus.includes('machine') || amdStatus === 'fax')) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
      `Hello ${name}, this is the Exeed AI Assistant from Data Direct Group. ` +
      `We received your enquiry about the ${lead.model || 'Exeed SUV'}. ` +
      `Please call us back or visit our website to schedule a test drive. Thank you!`
    );
    twiml.hangup();
    leads[req.params.leadId].status = 'Voicemail Left';
    return res.type('text/xml').send(twiml.toString());
  }

  // Human answered — start qualification
  redirect(res, `${BASE_URL}/voice/greeting/${req.params.leadId}`);
});

// ── HELPER: Yes/No gather ────────────────────────────────────
function yesNoGather(twiml, action, leadId) {
  const g = twiml.gather({
    input: 'speech dtmf',
    action,
    speechTimeout: '2',
    timeout: 7,
    numDigits: 1,
  });
  g.say({ voice: 'Polly.Joanna' }, 'Press 1 for yes, or 2 for no.');
  twiml.redirect(`${BASE_URL}/voice/no-response/${leadId}`);
}

function isYes(req) {
  const s = (req.body.SpeechResult || '').toLowerCase();
  const d = req.body.Digits || '';
  return d === '1' || !!s.match(/yes|yeah|sure|ok|correct|right|good|fine|ready|yep|absolutely|of course/);
}

function isNo(req) {
  const s = (req.body.SpeechResult || '').toLowerCase();
  const d = req.body.Digits || '';
  return d === '2' || !!s.match(/no|nope|not|busy|later|cant|cannot|negative|dont|don't/);
}

// ── STEP 1: GREETING ──────────────────────────────────────────
app.all('/voice/greeting/:leadId', (req, res) => {
  const lead = ensureLead(req.params.leadId);
  const name = (lead.name || 'there').split(' ')[0];
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna' },
    `Hello ${name}! This is Lili, AI assistant from Data Direct Group. ` +
    `You recently showed interest in the ${lead.model || 'Exeed SUV'}. ` +
    `I have just 4 quick yes or no questions — takes less than one minute. ` +
    `Is now a good time?`
  );
  yesNoGather(twiml, `${BASE_URL}/voice/q1/${req.params.leadId}`, req.params.leadId);
  res.type('text/xml').send(twiml.toString());
});

// ── Q1: STILL INTERESTED? ─────────────────────────────────────
app.all('/voice/q1/:leadId', (req, res) => {
  ensureLead(req.params.leadId);
  if (isNo(req)) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' },
      `No problem! Our team will reach out at a better time. Have a great day!`
    );
    twiml.hangup();
    leads[req.params.leadId].status = 'Callback Requested';
    return res.type('text/xml').send(twiml.toString());
  }
  ensureLead(req.params.leadId);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Great! Question 1: Are you still interested in purchasing the ${ensureLead(req.params.leadId).model || 'Exeed SUV'}?`
  );
  yesNoGather(twiml, `${BASE_URL}/voice/q2/${req.params.leadId}`, req.params.leadId);
  res.type('text/xml').send(twiml.toString());
});

// ── Q2: BUDGET READY? ─────────────────────────────────────────
app.all('/voice/q2/:leadId', (req, res) => {
  ensureLead(req.params.leadId);
  leads[req.params.leadId].responses.interested = isYes(req);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Question 2: Do you have your budget ready for this purchase?`
  );
  yesNoGather(twiml, `${BASE_URL}/voice/q3/${req.params.leadId}`, req.params.leadId);
  res.type('text/xml').send(twiml.toString());
});

// ── Q3: DECISION MAKER? ───────────────────────────────────────
app.all('/voice/q3/:leadId', (req, res) => {
  ensureLead(req.params.leadId);
  leads[req.params.leadId].responses.budgetReady = isYes(req);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Question 3: Are you the main decision maker for this purchase?`
  );
  yesNoGather(twiml, `${BASE_URL}/voice/q4/${req.params.leadId}`, req.params.leadId);
  res.type('text/xml').send(twiml.toString());
});

// ── Q4: READY WITHIN 3 MONTHS? ───────────────────────────────
app.all('/voice/q4/:leadId', (req, res) => {
  ensureLead(req.params.leadId);
  leads[req.params.leadId].responses.decisionMaker = isYes(req);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Last question: Are you planning to purchase within the next 3 months?`
  );
  yesNoGather(twiml, `${BASE_URL}/voice/q-human/${req.params.leadId}`, req.params.leadId);
  res.type('text/xml').send(twiml.toString());
});

// ── HUMAN AGENT REQUEST CHECK ────────────────────────────────
app.all('/voice/q-human/:leadId', (req, res) => {
  ensureLead(req.params.leadId);
  leads[req.params.leadId].responses.soonPurchase = isYes(req);
  const speech = (req.body.SpeechResult || '').toLowerCase();

  if (speech.match(/human|agent|person|transfer|speak to someone|real/)) {
    return redirect(res, `${BASE_URL}/voice/transfer/${req.params.leadId}`);
  }
  redirect(res, `${BASE_URL}/voice/qualify/${req.params.leadId}`);
});

// ── QUALIFICATION DECISION ───────────────────────────────────
app.all('/voice/qualify/:leadId', (req, res) => {
  const lead = ensureLead(req.params.leadId);
  const r    = lead.responses || {};

  // Simple yes/no scoring
  let score = 0;
  if (r.interested)    score += 25;
  if (r.budgetReady)   score += 30;
  if (r.decisionMaker) score += 25;
  if (r.soonPurchase)  score += 20;

  const isQualified = score >= 55;
  leads[req.params.leadId].status      = isQualified ? 'Qualified' : 'Not Qualified';
  leads[req.params.leadId].score       = score;
  leads[req.params.leadId].qualifiedAt = new Date().toISOString();

  const twiml = new twilio.twiml.VoiceResponse();
  if (isQualified) {
    twiml.say({ voice: 'Polly.Joanna' },
      `Excellent! You are all set. ` +
      `A dedicated Exeed consultant will call you within 2 hours ` +
      `to arrange a personalised test drive and exclusive offer in ${lead.city || 'your area'}. ` +
      `Thank you ${(lead.name||'').split(' ')[0]} and have a wonderful day!`
    );
  } else {
    twiml.say({ voice: 'Polly.Joanna' },
      `Thank you for your time. ` +
      `Our team will be in touch when the timing is right. ` +
      `Have a great day!`
    );
  }
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
  console.log(`[QUALIFY] ${req.params.leadId}: ${isQualified?'QUALIFIED':'NOT QUALIFIED'} | Score: ${score} | Responses: ${JSON.stringify(r)}`);
});

// ── HUMAN AGENT TRANSFER ──────────────────────────────────────
app.all('/voice/transfer/:leadId', (req, res) => {
  const lead = ensureLead(req.params.leadId);
  leads[req.params.leadId].status           = 'Transferred — Human Agent';
  leads[req.params.leadId].ccAgent          = 'Arif Mohamed';
  leads[req.params.leadId].salesOwner       = 'Exeed Sales Team';
  leads[req.params.leadId].assignedTo       = 'Mahmoud Hafez';
  leads[req.params.leadId].pendingStatus    = 'Pending — Contact Centre';

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `No problem at all! I will transfer you to one of our Exeed specialists right away. ` +
    `Please hold for just a moment.`
  );
  twiml.pause({ length: 2 });
  twiml.say({ voice: 'Polly.Joanna' },
    `I have noted your details and our team will be with you shortly. ` +
    `Thank you for your patience and have a wonderful day!`
  );
  twiml.hangup();

  console.log(`[TRANSFER] Lead ${req.params.leadId} → Human agent requested`);
  res.type('text/xml').send(twiml.toString());
});

// ── NO RESPONSE HANDLER ───────────────────────────────────────
app.all('/voice/no-response/:leadId', (req, res) => {
  const state = callState[req.params.leadId] || { noResponseCount: 0 };
  state.noResponseCount = (state.noResponseCount || 0) + 1;
  callState[req.params.leadId] = state;

  if (state.noResponseCount >= 2) {
    // Close as not qualified — no engagement
    leads[req.params.leadId].status = 'Not Qualified — No Response';
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' },
      `It seems like you may be busy right now. No problem at all. ` +
      `I will note this and our team will follow up at a better time. ` +
      `Thank you and have a great day!`
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // One more try
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, `I am sorry, I did not catch that. Could you please repeat?`);
  twiml.pause({ length: 2 });
  twiml.redirect(`${BASE_URL}/voice/greeting/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── CALL STATUS WEBHOOK ───────────────────────────────────────
app.post('/call-status/:leadId', (req, res) => {
  const { CallStatus, CallSid, CallDuration } = req.body;
  const lead = leads[req.params.leadId] || {};
  console.log(`[STATUS] ${CallSid} → ${CallStatus} | Duration: ${CallDuration}s | Lead: ${lead.name}`);

  if (CallStatus === 'no-answer' || CallStatus === 'busy') {
    leads[req.params.leadId].status = 'Not Qualified — Never Answered';
  }
  if (CallStatus === 'completed' && !leads[req.params.leadId].status) {
    leads[req.params.leadId].status = 'Completed';
  }
  res.sendStatus(200);
});

// ── GET LEAD STATUS (for CRM polling) ────────────────────────
app.get('/lead/:leadId', (req, res) => {
  const lead = leads[req.params.leadId];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

// ── HELPER ────────────────────────────────────────────────────
function redirect(res, url) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.redirect(url);
  res.type('text/xml').send(twiml.toString());
}

// ── GLOBAL ERROR HANDLER — returns valid TwiML instead of crashing ──
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    'I am sorry, something went wrong. Please call us back or we will reach out to you shortly. Goodbye!'
  );
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── WRAP ALL ROUTES IN TRY-CATCH ──────────────────────────────
// Replace any uncaught promise rejections with graceful TwiML
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ D.A.R.E. Backend v2 running on port ${PORT}`);
  console.log(`   Twilio SID:    ${ACCOUNT_SID ? ACCOUNT_SID.substring(0,8)+'...' : '⚠️  NOT SET'}`);
  console.log(`   Twilio Number: ${TWILIO_NUMBER || '⚠️  NOT SET'}`);
  console.log(`   Base URL:      ${BASE_URL || '⚠️  NOT SET'}\n`);
});
