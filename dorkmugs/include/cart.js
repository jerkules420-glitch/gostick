/* cart.js — GoStick client-side cart with localStorage persistence + backend checkout */
var Cart = (function () {
  'use strict';

  var KEY = 'gostick_cart';
  var SHIPPING_KEY = 'gostick_shipping_zone';
  var SHIPPING_ZONES = {
    US: { label: 'United States', amount: 599, freeThreshold: 4000 },
    CA: { label: 'Canada', amount: 1099, freeThreshold: 7000 },
    INTL: { label: 'UK / Australia', amount: 1299, freeThreshold: 8000 },
  };
  var API = window.location.origin + '/api';

  /* ── storage ── */
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }
  function save(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
    _updateBadge();
  }

  function reconcileProducts(products) {
    var byId = new Map(products.map(function (product) { return [product.id, product]; }));
    var changed = false;
    var items = load().filter(function (item) {
      var product = byId.get(item.id);
      if (!product) { changed = true; return false; }
      var nextValues = {
        name: product.pname,
        price: product.price,
        image: product.image,
        printifyProductId: product.printifyProductId || null,
        variantId: product.variantId || null,
      };
      Object.keys(nextValues).forEach(function (key) {
        if (item[key] !== nextValues[key]) {
          item[key] = nextValues[key];
          changed = true;
        }
      });
      return true;
    });
    if (changed) save(items);
    renderDrawer();
  }

  /* ── public read ── */
  function getItems() { return load(); }
  function getCount() {
    return load().reduce(function (n, i) { return n + i.qty; }, 0);
  }
  function getShippingZone() {
    var code = localStorage.getItem(SHIPPING_KEY) || 'US';
    return SHIPPING_ZONES[code] ? code : 'US';
  }
  function getPricing() {
    var items = load();
    var quantity = items.reduce(function (sum, item) { return sum + item.qty; }, 0);
    var rate = quantity >= 5 ? 0.15 : (quantity >= 3 ? 0.10 : 0);
    var subtotal = items.reduce(function (sum, item) {
      return sum + Math.round(item.price * 100) * item.qty;
    }, 0);
    var discountedSubtotal = items.reduce(function (sum, item) {
      return sum + Math.round(item.price * 100 * (1 - rate)) * item.qty;
    }, 0);
    var zoneCode = getShippingZone();
    var zone = SHIPPING_ZONES[zoneCode];
    var shipping = !items.length || subtotal >= zone.freeThreshold ? 0 : zone.amount;
    return {
      quantity: quantity,
      discountRate: rate,
      subtotal: subtotal,
      discount: subtotal - discountedSubtotal,
      shipping: shipping,
      total: discountedSubtotal + shipping,
      zoneCode: zoneCode,
      zone: zone,
    };
  }
  function getTotal() {
    return getPricing().total / 100;
  }

  /* ── mutations ── */
  /**
   * Add a product to the cart.
   * @param {string} id                   Internal product ID
   * @param {string} name
   * @param {number} price                  In cents (e.g. 2499 for $24.99)
   * @param {string} image
   * @param {number} qty
   * @param {string} [printifyProductId]    Printify product ID (required for fulfillment)
   * @param {string} [variantId]            Printify variant ID (required for fulfillment)
   */
  function add(id, name, price, image, qty, printifyProductId, variantId) {
    qty = parseInt(qty, 10) || 1;
    var items = load();
    var found = false;
    for (var x = 0; x < items.length; x++) {
      if (items[x].id === id) {
        items[x].qty += qty;
        if (printifyProductId) items[x].printifyProductId = printifyProductId;
        if (variantId) items[x].variantId = variantId;
        found = true; break;
      }
    }
    if (!found) {
      items.push({
        id: id, name: name, price: parseFloat(price), image: image, qty: qty,
        printifyProductId: printifyProductId || null,
        variantId: variantId || null,
      });
    }
    save(items);
    _showToast(name);
  }

  function remove(id) {
    save(load().filter(function (i) { return i.id !== id; }));
    renderDrawer();
  }

  function setQty(id, qty) {
    qty = parseInt(qty, 10);
    if (qty < 1) { remove(id); return; }
    var items = load();
    for (var x = 0; x < items.length; x++) {
      if (items[x].id === id) { items[x].qty = qty; break; }
    }
    save(items);
    renderDrawer();
  }

  /* ── badge ── */
  function _updateBadge() {
    var badge = document.getElementById('cart-badge');
    if (!badge) return;
    var n = getCount();
    badge.textContent = n;
    badge.style.display = n > 0 ? 'flex' : 'none';
  }

  /* ── toast ── */
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function _showToast(name) {
    var t = document.getElementById('cart-toast');
    if (!t) return;
    t.innerHTML = '<i class="fas fa-check-circle"></i> <strong>' + _esc(name) + '</strong> added to cart!';
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  /* ── checkout ── */
  /**
   * Create a Stripe Checkout Session via the backend and redirect to Stripe.
   */
  function checkout() {
    var items = load();
    if (!items.length) return;

    var btn = document.getElementById('checkout-btn') || document.querySelector('.cart-checkout-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }

    var payload = items.map(function (i) {
      return {
        id: i.id,
        name: i.name,
        price: Math.round(i.price * 100), // convert to cents
        qty: i.qty,
        image: i.image || undefined,
        printifyProductId: i.printifyProductId || undefined,
        variantId: i.variantId || undefined,
      };
    });

    fetch(API + '/checkout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: payload, shippingZone: getShippingZone() }),
    })
    .then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Checkout failed.');
        return d;
      });
    })
    .then(function (data) {
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned.');
      }
    })
    .catch(function (err) {
      var message = err instanceof TypeError && err.message === 'Failed to fetch'
        ? 'Checkout is temporarily unavailable. Please wait a moment and try again.'
        : (err.message || 'Could not start checkout. Please try again.');
      alert(message);
      if (btn) { btn.disabled = false; btn.textContent = 'Proceed to Checkout'; }
    });
  }

  /* ── drawer render ── */
  function renderDrawer() {
    var list    = document.getElementById('cart-items');
    var totalEl = document.getElementById('cart-total');
    var countEl = document.getElementById('cart-drawer-count');
    if (!list) return;

    var items = load();
    var pricing = getPricing();

    if (countEl) countEl.textContent = getCount();

    if (items.length === 0) {
      list.innerHTML = '<p class="cart-empty"><i class="fas fa-shopping-cart"></i><br>Your cart is empty.</p>';
      if (totalEl) totalEl.textContent = '$0.00';
      updatePricingSummary(pricing);
      return;
    }

    list.innerHTML = items.map(function (item) {
      return [
        '<div class="cart-item">',
          '<img class="cart-item-img" src="' + _esc(item.image) + '" alt="' + _esc(item.name) + '" />',
          '<div class="cart-item-info">',
            '<p class="cart-item-name">' + _esc(item.name) + '</p>',
            '<p class="cart-item-price">$' + (item.price * item.qty).toFixed(2) + '</p>',
            '<div class="cart-item-qty">',
              '<button type="button" aria-label="Decrease" data-cart-action="decrease" data-item-id="' + _esc(item.id) + '">&#8722;</button>',
              '<span>' + item.qty + '</span>',
              '<button type="button" aria-label="Increase" data-cart-action="increase" data-item-id="' + _esc(item.id) + '">&#43;</button>',
            '</div>',
          '</div>',
          '<button class="cart-item-remove" type="button" aria-label="Remove item"',
            ' data-cart-action="remove" data-item-id="' + _esc(item.id) + '">&#10005;</button>',
        '</div>'
      ].join('');
    }).join('');

    if (totalEl) totalEl.textContent = '$' + (pricing.total / 100).toFixed(2);
    updatePricingSummary(pricing);
  }

  function ensurePricingControls() {
    var footer = document.querySelector('.cart-drawer-footer');
    if (!footer || document.getElementById('cart-shipping-zone')) return;
    var total = footer.querySelector('.cart-subtotal');
    if (!total) return;
    var controls = document.createElement('div');
    controls.className = 'cart-pricing-controls';
    controls.innerHTML =
      '<label class="cart-shipping-control" for="cart-shipping-zone">' +
        '<span>Ship to</span>' +
        '<select id="cart-shipping-zone">' +
          '<option value="US">United States</option>' +
          '<option value="CA">Canada</option>' +
          '<option value="INTL">UK / Australia</option>' +
        '</select>' +
      '</label>' +
      '<div class="cart-breakdown">' +
        '<div><span>Items</span><span id="cart-items-subtotal">$0.00</span></div>' +
        '<div id="cart-discount-row"><span>Bundle discount</span><span id="cart-discount">-$0.00</span></div>' +
        '<div><span>Shipping</span><span id="cart-shipping">$0.00</span></div>' +
      '</div>';
    footer.insertBefore(controls, total);
    total.querySelector('span:first-child').textContent = 'Total';
    var select = document.getElementById('cart-shipping-zone');
    select.value = getShippingZone();
    select.addEventListener('change', function () {
      localStorage.setItem(SHIPPING_KEY, select.value);
      renderDrawer();
    });
  }

  function updatePricingSummary(pricing) {
    ensurePricingControls();
    var subtotal = document.getElementById('cart-items-subtotal');
    var discount = document.getElementById('cart-discount');
    var discountRow = document.getElementById('cart-discount-row');
    var shipping = document.getElementById('cart-shipping');
    var note = document.querySelector('.cart-shipping-note');
    var select = document.getElementById('cart-shipping-zone');
    if (select) select.value = pricing.zoneCode;
    if (subtotal) subtotal.textContent = '$' + (pricing.subtotal / 100).toFixed(2);
    if (discount) discount.textContent = '-$' + (pricing.discount / 100).toFixed(2);
    if (discountRow) discountRow.style.display = pricing.discount ? 'flex' : 'none';
    if (shipping) shipping.textContent = pricing.shipping ? '$' + (pricing.shipping / 100).toFixed(2) : 'FREE';
    if (note) {
      var remaining = Math.max(0, pricing.zone.freeThreshold - pricing.subtotal);
      note.innerHTML = remaining
        ? '<i class="fas fa-truck"></i> Add $' + (remaining / 100).toFixed(2) + ' for free ' + pricing.zone.label + ' shipping'
        : '<i class="fas fa-check"></i> Free ' + pricing.zone.label + ' shipping unlocked';
    }
  }

  /* ── drawer open / close ── */
  function openDrawer() {
    renderDrawer();
    var drawer  = document.getElementById('cart-drawer');
    var overlay = document.getElementById('cart-overlay');
    if (drawer)  { drawer.classList.add('open');  drawer.setAttribute('aria-hidden', 'false'); }
    if (overlay) overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    var drawer  = document.getElementById('cart-drawer');
    var overlay = document.getElementById('cart-overlay');
    if (drawer)  { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ── init ── */
  document.addEventListener('DOMContentLoaded', function () {
    ensurePricingControls();
    /* cart button */
    var cartBtn = document.getElementById('btn002');
    if (cartBtn) cartBtn.addEventListener('click', openDrawer);

    /* close btn */
    var closeBtn = document.getElementById('cart-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

    /* overlay click */
    var overlay = document.getElementById('cart-overlay');
    if (overlay) overlay.addEventListener('click', closeDrawer);

    var itemList = document.getElementById('cart-items');
    if (itemList) {
      itemList.addEventListener('click', function (event) {
        var button = event.target.closest('[data-cart-action]');
        if (!button) return;
        var id = button.dataset.itemId;
        var item = load().find(function (candidate) { return candidate.id === id; });
        if (!item) return;
        if (button.dataset.cartAction === 'remove') remove(id);
        if (button.dataset.cartAction === 'increase') setQty(id, item.qty + 1);
        if (button.dataset.cartAction === 'decrease') setQty(id, item.qty - 1);
      });
    }

    document.querySelectorAll('.cart-continue-link').forEach(function (link) {
      link.removeAttribute('onclick');
      link.addEventListener('click', closeDrawer);
    });

    /* Escape key */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    /* hamburger */
    var hamburger = document.getElementById('nav-hamburger');
    var navList   = document.querySelector('.header-nav');
    if (hamburger && navList) {
      hamburger.addEventListener('click', function () {
        var open = navList.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    _updateBadge();

    if (window.productsReady) {
      window.productsReady.then(reconcileProducts).catch(function () {});
    }

    /* checkout button */
    var checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', function () { Cart.checkout(); });
    }
  });

  /* ── public API ── */
  return {
    add: add, remove: remove, setQty: setQty,
    getItems: getItems, getCount: getCount, getTotal: getTotal,
    getPricing: getPricing, getShippingZone: getShippingZone,
    reconcileProducts: reconcileProducts,
    openDrawer: openDrawer, closeDrawer: closeDrawer,
    renderDrawer: renderDrawer, updateBadge: _updateBadge,
    checkout: checkout,
  };
})();
