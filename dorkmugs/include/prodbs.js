
var prodb = [];

var productsReady = fetch('/api/products')
	.then(function(response) {
		if (!response.ok) throw new Error('Catalog request failed with ' + response.status);
		return response.json();
	})
	.then(function(payload) {
		prodb.splice.apply(prodb, [0, prodb.length].concat(payload.products || []));
		return prodb;
	});

window.productsReady = productsReady;

window.GoStickCatalog = (function() {
	function escapeHtml(value) {
		return String(value == null ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function productCard(product, compact) {
		var className = compact ? 'card sticker-card' : 'product-card sticker-card';
		return '<article class="' + className + '" data-price="' + product.price + '" data-name="' + escapeHtml(product.pname) + '">' +
			'<a class="sticker-image" href="item.html?id=' + encodeURIComponent(product.id) + '">' +
				'<img src="' + escapeHtml(product.image) + '" alt="' + escapeHtml(product.pname) + '" loading="lazy" />' +
			'</a>' +
			'<div class="product-info">' +
				'<span class="collection-badge badge-stickers">CS2 Sticker</span>' +
				'<h3>' + escapeHtml(product.pname) + '</h3>' +
				'<p class="sticker-price">$' + Number(product.price).toFixed(2) + '</p>' +
				'<button class="card-add-btn js-add-product" type="button" data-product-id="' + escapeHtml(product.id) + '" ' + (product.printifyReady ? '' : 'disabled title="Print product is being prepared"') + '>' + (product.printifyReady ? 'Add to Cart' : 'Preparing...') + '</button>' +
				'<a href="item.html?id=' + encodeURIComponent(product.id) + '" class="card-view-link">View Details &rsaquo;</a>' +
			'</div>' +
		'</article>';
	}

	function bindCart(root) {
		root.addEventListener('click', function(event) {
			var button = event.target.closest('.js-add-product');
			if (!button) return;
			var product = prodb.find(function(item) { return item.id === button.dataset.productId; });
			if (!product || typeof Cart === 'undefined') return;
			Cart.add(product.id, product.pname, product.price, product.image, 1, product.printifyProductId, product.variantId);
		});
	}

	function showError(root, error) {
		root.innerHTML = '<div class="catalog-state"><h2>Catalog unavailable</h2><p>' + escapeHtml(error.message) + '</p></div>';
	}

	return { escapeHtml: escapeHtml, productCard: productCard, bindCart: bindCart, showError: showError };
})();
