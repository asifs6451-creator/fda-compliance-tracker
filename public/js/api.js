/* ─── Shared GAS API helper ───────────────────────────────── */

async function gasCall(path, data) {
  const token   = localStorage.getItem('fda_token');
  const payload = Object.assign({ path }, token ? { token } : {}, data || {});

  // Note: no Content-Type header → stays as text/plain → no CORS preflight
  const res = await fetch(window.GAS_URL, {
    method: 'POST',
    body:   JSON.stringify(payload)
  });

  let result;
  try { result = await res.json(); } catch (e) { throw new Error('Bad response from server'); }

  if (result && result.error) {
    if (result.error === 'Not authenticated' || result.error === 'Session expired or invalid') {
      clearAuth();
      location.href = 'login.html';
      return null;
    }
    throw new Error(result.error);
  }
  return result;
}

/* ─── Auth helpers ────────────────────────────────────────── */

function getUser() {
  try { return JSON.parse(localStorage.getItem('fda_user') || 'null'); } catch { return null; }
}

function setAuth(token, user) {
  localStorage.setItem('fda_token', token);
  localStorage.setItem('fda_user',  JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem('fda_token');
  localStorage.removeItem('fda_user');
}

async function checkAuth(allowedRoles) {
  const user  = getUser();
  const token = localStorage.getItem('fda_token');
  if (!user || !token) {
    location.href = 'login.html';
    return null;
  }
  if (allowedRoles && allowedRoles.length && !allowedRoles.includes(user.role)) {
    // Show clear error instead of silent redirect
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
        <div style="text-align:center">
          <div style="font-size:3rem">🔒</div>
          <h4>Access Denied</h4>
          <p class="text-muted">Your role (<strong>${user.role}</strong>) cannot access this page.</p>
          <a href="index.html" class="btn btn-primary">Go to Dashboard</a>
        </div>
      </div>`;
    return null;
  }
  return user;
}

async function doLogout() {
  try { await gasCall('logout'); } catch (e) {}
  clearAuth();
  location.href = 'login.html';
}
