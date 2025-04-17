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
    const ordersRes = await axios.get(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/orders.json?query=cart_id:${cart.id}`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN }
    });
    if (ordersRes.data.orders.length === 0) {
      // Cart abandoned
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
