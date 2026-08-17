// src/routes/checkout.js
const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/checkout');
const { optionalAuth } = require('../middleware/auth');

router.post(
  '/',
  optionalAuth,
  body('items').isArray({ min: 1 }).withMessage('Cart cannot be empty.'),
  body('items.*.id').notEmpty().withMessage('Item ID required.'),
  body('items.*.qty').isInt({ min: 1 }).withMessage('Quantity must be at least 1.'),
  body('shippingZone').isIn(['US', 'CA', 'INTL']).withMessage('Invalid shipping zone.'),
  ctrl.createCheckout
);

module.exports = router;
