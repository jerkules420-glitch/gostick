/* include/auth.js — frontend auth state helper
 * Communicates with the backend API (cookies are httpOnly; this file
 * only manages the non-sensitive display state stored in sessionStorage).
 */
(function () {
  'use strict';

  var API = window.location.origin + '/api';

  // ─── Public API ────────────────────────────────────────────────────────────

  window.Auth = {
    getUser: getUser,
    isLoggedIn: isLoggedIn,
    isAdmin: isAdmin,
    login: login,
    register: register,
    logout: logout,
    refreshSession: refreshSession,
    updateNavButtons: updateNavButtons,
  };

  // ─── Session state (non-sensitive) ─────────────────────────────────────────

  var SESSION_KEY = 'dm_user';

  function getUser() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
    catch (e) { return null; }
  }

  function setUser(user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  }

  function clearUser() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function isLoggedIn() { return !!getUser(); }
  function isAdmin() { var u = getUser(); return u && u.role === 'ADMIN'; }

  // ─── API calls ──────────────────────────────────────────────────────────────

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      credentials: 'include', // send/receive httpOnly cookies
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data: data, status: r.status });
        return data;
      });
    });
  }

  /** Attempt silent refresh; resolves with user or null */
  function refreshSession() {
    return api('POST', '/auth/refresh')
      .then(function (data) { setUser(data.user); return data.user; })
      .catch(function () { clearUser(); return null; });
  }

  /** On page load: validate session cookie via /auth/me, fallback to refresh */
  function initSession() {
    return api('GET', '/auth/me')
      .then(function (data) { setUser(data.user); return data.user; })
      .catch(function () {
        return refreshSession();
      });
  }

  function login(email, password) {
    return api('POST', '/auth/login', { email: email, password: password })
      .then(function (data) { setUser(data.user); return data.user; });
  }

  function register(name, email, password) {
    return api('POST', '/auth/register', { name: name, email: email, password: password })
      .then(function (data) { setUser(data.user); return data.user; });
  }

  function logout() {
    return api('POST', '/auth/logout')
      .finally(function () {
        clearUser();
        window.location.href = 'index.html';
      });
  }

  // ─── Nav button wiring ──────────────────────────────────────────────────────

  function updateNavButtons() {
    var user = getUser();
    var btnLogin = document.getElementById('btn-login');
    var btnSignup = document.getElementById('btn001');
    var btnAccount = document.getElementById('btn-account');
    var btnLogout = document.getElementById('btn-logout');

    if (user) {
      // Logged in state
      if (btnLogin) { btnLogin.style.display = 'none'; }
      if (btnSignup) { btnSignup.style.display = 'none'; }
      if (btnAccount) {
        var onProfilePage = window.location.pathname.endsWith('/account.html');
        var showAdminPanel = user.role === 'ADMIN' && onProfilePage;
        btnAccount.style.display = '';
        btnAccount.textContent = showAdminPanel ? 'Admin Panel' : 'My Profile';
        btnAccount.setAttribute(
          'aria-label',
          showAdminPanel ? 'Open admin panel' : 'Open my profile'
        );
        btnAccount.onclick = function () {
          window.location.href = showAdminPanel ? 'admin.html' : 'account.html';
        };
      }
      if (btnLogout) {
        btnLogout.style.display = '';
        btnLogout.onclick = function () { Auth.logout(); };
      }
    } else {
      // Logged out state
      if (btnLogin) {
        btnLogin.style.display = '';
        btnLogin.onclick = function () { window.location.href = 'login.html'; };
      }
      if (btnSignup) {
        btnSignup.style.display = '';
        btnSignup.onclick = function () { window.location.href = 'register.html'; };
      }
      if (btnAccount) { btnAccount.style.display = 'none'; }
      if (btnLogout) { btnLogout.style.display = 'none'; }
    }
  }
  function initAnnouncementCarousel() {
    var bar = document.querySelector('.announcement-bar');
    if (!bar || window.location.pathname.endsWith('/admin.html')) return;
    var messages = [
      'Buy 3+ stickers and save 10%',
      'Buy 5+ stickers and save 15%',
      'Free US shipping on orders over $40',
      'Free Canada shipping over $70 · UK / Australia over $80',
    ];
    var index = 0;
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML = '<span class="announcement-message"></span>';
    var message = bar.querySelector('.announcement-message');

    function showMessage() {
      message.classList.remove('is-visible');
      window.setTimeout(function () {
        message.textContent = messages[index];
        message.classList.add('is-visible');
        index = (index + 1) % messages.length;
      }, 160);
    }

    showMessage();
    window.setInterval(showMessage, 3600);
  }

  // ─── Auto-init ──────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    initAnnouncementCarousel();
    initSession().then(function () {
      updateNavButtons();
    });
  });

})();
