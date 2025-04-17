// server.js
// Abandoned Cart Recovery Bot for Shopify using Node.js, Express, MongoDB, and Twilio

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');
const axios = require('axios');
const { sendSmsReminder } = require('./services/twilio');
const { createDiscount } = require('./services/shopify');
const CartLog = require('./models/CartLog');

// App setup
const app = express();
app.use(bodyParser.json({ type: 'application/json' }));

// Verify Shopify Webhook
function verifyShopifyWebhook(req, res, buf) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const computed = crypto
    .createHmac('sha256', process.env.SHOPIFY_SECRET)
    .update(buf, 'utf8')
    .digest('base64');
  if (computed !== hmac) {
    return res.status(401).send('Webhook verification failed');
  }
}
app.use('/webhooks/cart/create', bodyParser.raw({ type: 'application/json', verify: verifyShopifyWebhook }));

// Cart creation webhook endpoint
app.post('/webhooks/cart/create', async (req, res) => {
  const cart = JSON.parse(req.body.toString());
  // Schedule check after 1 hour
  setTimeout(() => checkCartAndSendReminder(cart), 60 * 60 * 1000);
  res.status(200).send('Cart received');
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

// Function to check cart status and send reminder
async function checkCartAndSendReminder(cart) {
  try {
    // Fetch orders to see if cart converted
    const ordersRes = await axios.get(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/orders.json`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN },
      params: { "query": `cart_id:${cart.id}` }
    });
    if (!ordersRes.data.orders.length) {
      // Cart abandoned → create discount & send reminder
      const discount = await createDiscount();
      const recoveryUrl = cart.online_checkout_url;
      const phone = cart.customer?.phone;
      const name = cart.customer?.first_name || '';
      await sendSmsReminder(phone, recoveryUrl, discount.code, name);
      // Log event
      await CartLog.create({ cartId: cart.id, phone, discount: discount.code, sentAt: new Date() });
    }
  } catch (err) {
    console.error('Error in checkCartAndSendReminder:', err);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// services/shopify.js
// Creates a 10% off discount code via Shopify Price Rules API

// services/shopify.js
const axiosShop = require('axios');

async function createDiscount() {
  const baseUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
  // Step 1: Create price rule
  const rulePayload = {
    price_rule: {
      title: `CartRecovery_${Date.now()}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: '-10.0',
      customer_selection: 'all',
      starts_at: new Date().toISOString()
    }
  };
  const ruleRes = await axiosShop.post(
    `${baseUrl}/price_rules.json`,
    rulePayload,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN }}
  );
  const ruleId = ruleRes.data.price_rule.id;

  // Step 2: Create discount code
  const code = `SAVE10_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  const codePayload = { discount_code: { code }};
  await axiosShop.post(
    `${baseUrl}/price_rules/${ruleId}/discount_codes.json`,
    codePayload,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN }}
  );

  return { code };
}

module.exports = { createDiscount };

// services/twilio.js
// Sends SMS/WhatsApp reminders via Twilio

const twilio = require('twilio');
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function sendSmsReminder(phone, url, code, name) {
  if (!phone) throw new Error('No phone number provided');
  const message = `Hi ${name}, you left items in your cart 🛒 Use code ${code} within 1 hour: ${url}`;
  return client.messages.create({
    body: message,
    from: process.env.TWILIO_FROM,
    to: phone
  });
}

module.exports = { sendSmsReminder };

// models/CartLog.js
const mongoose = require('mongoose');
const CartLogSchema = new mongoose.Schema({
  cartId: { type: String, required: true },
  phone: { type: String, required: true },
  discount: String,
  sentAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('CartLog', CartLogSchema);

// package.json
{
  "name": "shopify-cart-recovery-bot",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "axios": "^1.0.0",
    "body-parser": "^1.19.0",
    "dotenv": "^8.2.0",
    "express": "^4.17.1",
    "mongoose": "^5.9.7",
    "twilio": "^3.55.0"
  }
}

// .env.example
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_TOKEN=shpat_XXXXXXXXXXXXXXXXXX
SHOPIFY_SECRET=XXXXXXXXXXXXXXXXXXXX
TWILIO_SID=ACXXXXXXXXXXXXXXXXXXXX
TWILIO_TOKEN=your_twilio_auth_token
TWILIO_FROM=+1234567890
MONGODB_URI=mongodb://localhost:27017/cartbot
