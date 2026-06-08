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

const leads = {};

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Project D.A.R.E. Backend' });
});

app.post('/call', async (req, res) => {
  const { name, phone, model, city, timeline } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const leadId = Date.now().toString();
  leads[leadId] = { name, phone, model, city, timeline };
  try {
    const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
    const call = await client.calls.create({
      url:  BASE_URL + '/voice/' + leadId,
      to:   phone,
      from: TWILIO_NUMBER,
    });
    console.log('Call initiated: ' + call.sid + ' → ' + phone);
    res.json({ success: true, callSid: call.sid, status: call.status, leadId });
  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.all('/voice/:leadId', (req, res) => {
  const lead = leads[req.params.leadId] || {};
  const name  = (lead.name  || 'there').split(' ')[0];
  const model = lead.model || 'Exeed SUV';
  const city  = lead.city  || 'UAE';
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Polly.Joanna">Hello ' + name + '. This is the Exeed AI Assistant from Data Direct Group. We received your enquiry about the ' + model + '. Our team in ' + city + ' is ready to assist you with a personalised test drive and exclusive offer. Thank you and have a wonderful day!</Say></Response>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('D.A.R.E. Backend running on port ' + PORT);
  console.log('Twilio SID: ' + (ACCOUNT_SID ? ACCOUNT_SID.substring(0,8)+'...' : 'NOT SET'));
  console.log('Twilio Number: ' + (TWILIO_NUMBER || 'NOT SET'));
  console.log('Base URL: ' + (BASE_URL || 'NOT SET'));
});
