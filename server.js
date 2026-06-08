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

// ── ANSWERING MACHINE DETECTION ───────────────────────────────
app.post('/voice/start/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
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

// ── STEP 1: GREETING ──────────────────────────────────────────
app.all('/voice/greeting/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
  const name = (lead.name || 'there').split(' ')[0];

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Hello, may I speak with ${name}? ` +
    `This is Lara, the AI Lead Assistant from Data Direct Group. ` +
    `Thanks so much for your interest in the ${lead.model || 'Exeed SUV'}. ` +
    `I just have a few quick questions to make sure we match you with the right consultant. ` +
    `Is now a good time?`
  );

  const gather = twiml.gather({
    input: 'speech dtmf',
    action: `${BASE_URL}/voice/confirm-time/${req.params.leadId}`,
    speechTimeout: '3',
    timeout: 8,
    numDigits: 1,
  });
  gather.say({ voice: 'Polly.Joanna' }, 'Press 1 or say yes if now is a good time.');

  // No response handler
  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 2: CONFIRM TIME ──────────────────────────────────────
app.all('/voice/confirm-time/:leadId', (req, res) => {
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const digit  = req.body.Digits || '';
  const state  = callState[req.params.leadId] || {};

  const isYes = speech.match(/yes|sure|ok|good|fine|ready|go|now/) || digit === '1';
  const isNo  = speech.match(/no|busy|later|bad|not now|call back/);

  if (isNo) {
    // Schedule callback
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' },
      `No problem at all! I will have one of our Exeed specialists call you back at a more convenient time. ` +
      `Thank you for your time and have a wonderful day!`
    );
    twiml.hangup();
    leads[req.params.leadId].status = 'Callback Requested';
    return res.type('text/xml').send(twiml.toString());
  }

  // Proceed to interest question
  redirect(res, `${BASE_URL}/voice/interest/${req.params.leadId}`);
});

// ── STEP 3: CONFIRM INTEREST ──────────────────────────────────
app.all('/voice/interest/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna' },
    `Great! Could you briefly tell me what made you reach out about the ${lead.model || 'Exeed SUV'} today?`
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/budget/${req.params.leadId}`,
    speechTimeout: '4',
    timeout: 10,
  });

  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 4: BUDGET ────────────────────────────────────────────
app.all('/voice/budget/:leadId', (req, res) => {
  const speech = req.body.SpeechResult || '';
  if (speech) leads[req.params.leadId].responses.interest = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `That sounds great. Now, what budget range have you allocated for this kind of purchase?`
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/authority/${req.params.leadId}`,
    speechTimeout: '4',
    timeout: 10,
  });

  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 5: AUTHORITY ─────────────────────────────────────────
app.all('/voice/authority/:leadId', (req, res) => {
  const speech = req.body.SpeechResult || '';
  if (speech) leads[req.params.leadId].responses.budget = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Perfect. Are you the main decision maker for this purchase, or is there someone else involved?`
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/pain/${req.params.leadId}`,
    speechTimeout: '4',
    timeout: 10,
  });

  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 6: NEED / PAIN ───────────────────────────────────────
app.all('/voice/pain/:leadId', (req, res) => {
  const speech = req.body.SpeechResult || '';
  if (speech) leads[req.params.leadId].responses.authority = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Good to know. What specific needs or goals are you trying to meet with your next vehicle?`
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/timeline/${req.params.leadId}`,
    speechTimeout: '4',
    timeout: 10,
  });

  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 7: TIMELINE ─────────────────────────────────────────
app.all('/voice/timeline/:leadId', (req, res) => {
  const speech = req.body.SpeechResult || '';
  if (speech) leads[req.params.leadId].responses.need = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' },
    `Almost done. When are you looking to move forward with this purchase?`
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/human-check/${req.params.leadId}`,
    speechTimeout: '4',
    timeout: 10,
  });

  twiml.redirect(`${BASE_URL}/voice/no-response/${req.params.leadId}`);
  res.type('text/xml').send(twiml.toString());
});

// ── STEP 8: HUMAN AGENT CHECK ────────────────────────────────
app.all('/voice/human-check/:leadId', (req, res) => {
  const speech = (req.body.SpeechResult || '').toLowerCase();
  if (speech) leads[req.params.leadId].responses.timeline = speech;

  // Check if customer wants human agent
  const wantsHuman = speech.match(/human|agent|person|representative|speak to someone|real person|transfer/);

  if (wantsHuman) {
    return redirect(res, `${BASE_URL}/voice/transfer/${req.params.leadId}`);
  }

  redirect(res, `${BASE_URL}/voice/qualify/${req.params.leadId}`);
});

// ── STEP 9: QUALIFICATION DECISION ──────────────────────────
app.all('/voice/qualify/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
  const r    = lead.responses || {};

  // Scoring logic
  let score = 0;
  const budget   = (r.budget   || '').toLowerCase();
  const timeline = (r.timeline || '').toLowerCase();
  const authority= (r.authority|| '').toLowerCase();
  const interest = (r.interest || '').toLowerCase();

  if (budget.match(/120|150|180|200|250|300|above|high|good/)) score += 30;
  else if (budget.match(/100|enough|reasonable/)) score += 15;

  if (timeline.match(/month|week|soon|now|ready|quickly|immediate/)) score += 30;
  else if (timeline.match(/year|later|eventually|maybe/)) score += 10;

  if (authority.match(/yes|i am|myself|me|decision|i decide/)) score += 25;
  else if (authority.match(/wife|husband|partner|family|together/)) score += 15;

  if (interest.length > 10) score += 15;

  const isQualified = score >= 50;
  leads[req.params.leadId].status      = isQualified ? 'Qualified' : 'Not Qualified';
  leads[req.params.leadId].score       = score;
  leads[req.params.leadId].qualifiedAt = new Date().toISOString();

  const twiml = new twilio.twiml.VoiceResponse();

  if (isQualified) {
    twiml.say({ voice: 'Polly.Joanna' },
      `Excellent! Based on what you have shared, you are a great fit for the ${lead.model || 'Exeed'}. ` +
      `I am going to connect you with one of our dedicated Exeed consultants in ${lead.city || 'your area'} ` +
      `who will reach out to arrange a personalised test drive and exclusive offer. ` +
      `You should expect a call within the next 2 hours. ` +
      `Thank you so much and have a wonderful day!`
    );
  } else {
    twiml.say({ voice: 'Polly.Joanna' },
      `Thank you so much for your time today. ` +
      `Based on our conversation, I will pass your details to our team for the right follow-up. ` +
      `Thank you for considering Exeed and have a great day!`
    );
  }

  twiml.hangup();
  res.type('text/xml').send(twiml.toString());

  console.log(`[QUALIFY] Lead ${req.params.leadId}: ${isQualified ? 'QUALIFIED' : 'NOT QUALIFIED'} | Score: ${score}`);
});

// ── HUMAN AGENT TRANSFER ──────────────────────────────────────
app.all('/voice/transfer/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
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

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ D.A.R.E. Backend v2 running on port ${PORT}`);
  console.log(`   Twilio SID:    ${ACCOUNT_SID ? ACCOUNT_SID.substring(0,8)+'...' : '⚠️  NOT SET'}`);
  console.log(`   Twilio Number: ${TWILIO_NUMBER || '⚠️  NOT SET'}`);
  console.log(`   Base URL:      ${BASE_URL || '⚠️  NOT SET'}\n`);
});
