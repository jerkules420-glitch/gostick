const config = require('../config');

function discountRateFor(quantity) {
  const tier = config.commerce.discounts.find((item) => quantity >= item.minimumQuantity);
  return tier ? tier.rate : 0;
}

function priceOrder(items, shippingZoneCode) {
  const shippingZone = config.commerce.shippingZones[shippingZoneCode];
  if (!shippingZone) throw new Error('Invalid shipping zone.');

  const quantity = items.reduce((sum, item) => sum + item.qty, 0);
  const discountRate = discountRateFor(quantity);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const pricedItems = items.map((item) => ({
    ...item,
    price: Math.round(item.price * (1 - discountRate)),
  }));
  const discountedSubtotal = pricedItems.reduce(
    (sum, item) => sum + item.price * item.qty,
    0
  );
  const shipping = subtotal >= shippingZone.freeThreshold ? 0 : shippingZone.amount;

  return {
    items: pricedItems,
    quantity,
    subtotal,
    discountRate,
    discount: subtotal - discountedSubtotal,
    discountedSubtotal,
    shipping,
    total: discountedSubtotal + shipping,
    shippingZone: { code: shippingZoneCode, ...shippingZone },
  };
}

module.exports = { discountRateFor, priceOrder };