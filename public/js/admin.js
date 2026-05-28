let warehouses = [];

async function init() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { location.href = '/login.html'; return; }
    const { user } = await res.json();
    if (!['admin','manager'].includes(user.role)) { location.href = '/'; return; }
    if (user.role === 'manager') {
      document.querySelectorAll('[data-admin-only]').forEach(el => el.remove());
    }
    const wRes = await fetch('/api/warehouses');
    warehouses = await wRes.json();
    populateWarehouseSelect();
    loadUsers();
    loadAlertConfig();
    checkSmtpStatus();
  } catch { location.href = '/login.html'; }
}

/* ── Tabs ── */
document.querySelectorAll('.nav-tabs .nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['users','alerts'].forEach(t => {
      const el = document.getElementById(`tab-${t}`);
      el?.classList.toggle('d-none', t !== btn.dataset.tab);
    });
  });
});

/* ── Users ── */
async function loadUsers() {
  const res = await fetch('/api/users');
  const users = await res.json();
  const tbody = document.getElementById('usersTable');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">No users found</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td class="fw-semibold">${u.full_name||'—'}</td>
      <td class="text-muted small">${u.username}</td>
      <td><span class="badge ${roleBadge(u.role)}">${u.role}</span></td>
      <td class="small">${u.warehouse_name||'All Locations'}</td>
      <td class="small text-muted">${u.email||'—'}</td>
      <td><span class="badge ${u.is_active ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}">
        ${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-xs btn-outline-secondary me-1" onclick="openUserModal(${JSON.stringify(u).replace(/"/g,'&quot;')})">
          <i class="fas fa-pen"></i></button>
        <button class="btn btn-xs btn-outline-danger" onclick="deleteUser(${u.id},'${u.username}')">
          <i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function roleBadge(role) {
  return {admin:'bg-danger-subtle text-danger', manager:'bg-primary-subtle text-primary', pharmacist:'bg-success-subtle text-success'}[role]||'bg-secondary';
}

function populateWarehouseSelect() {
  const sel = document.getElementById('u-warehouse');
  sel.innerHTML = '<option value="">— All Locations —</option>' +
    warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
}

function toggleWarehouseField() {
  const role = document.getElementById('u-role').value;
  document.getElementById('warehouseField').style.display = role === 'pharmacist' ? '' : 'none';
}

function openUserModal(user) {
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('userModal'));
  const isEdit = !!user;
  document.getElementById('userModalTitle').textContent = isEdit ? 'Edit User' : 'Add User';
  document.getElementById('editUserId').value = user?.id || '';
  document.getElementById('u-name').value = user?.full_name || '';
  document.getElementById('u-username').value = user?.username || '';
  document.getElementById('u-password').value = '';
  document.getElementById('u-role').value = user?.role || 'pharmacist';
  document.getElementById('u-email').value = user?.email || '';
  document.getElementById('u-warehouse').value = user?.warehouse_id || '';
  document.getElementById('u-active').checked = user ? !!user.is_active : true;
  document.getElementById('statusField').classList.toggle('d-none', !isEdit);
  document.getElementById('pwdLabel').textContent = isEdit ? 'New Password (leave blank to keep)' : 'Password';
  toggleWarehouseField();
  modal.show();
}

async function saveUser() {
  const id = document.getElementById('editUserId').value;
  const body = {
    full_name: document.getElementById('u-name').value.trim(),
    username: document.getElementById('u-username').value.trim(),
    role: document.getElementById('u-role').value,
    email: document.getElementById('u-email').value.trim(),
    warehouse_id: document.getElementById('u-warehouse').value || null,
    is_active: document.getElementById('u-active').checked ? 1 : 0,
  };
  const pwd = document.getElementById('u-password').value;
  if (pwd) body.password = pwd;
  if (!id && !pwd) { showToast('Password required for new user','danger'); return; }

  try {
    const res = await fetch(id ? `/api/users/${id}` : '/api/users', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);
    bootstrap.Modal.getInstance(document.getElementById('userModal')).hide();
    loadUsers();
    showToast('User saved', 'success');
  } catch (e) { showToast(e.message, 'danger'); }
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
  if (res.ok) { loadUsers(); showToast('User deleted', 'success'); }
  else showToast('Delete failed', 'danger');
}

/* ── Alerts ── */
async function checkSmtpStatus() {
  const res = await fetch('/api/alerts/smtp-status');
  const { configured } = await res.json();
  if (!configured) document.getElementById('smtpWarning')?.classList.remove('d-none');
}

async function loadAlertConfig() {
  const res = await fetch('/api/alerts/config');
  const configs = await res.json();
  configs.forEach(c => {
    const prefix = c.alert_type === 'reminder' ? 'rem' : 'sum';
    const timeEl = document.getElementById(`${prefix}-time`);
    const recEl  = document.getElementById(`${prefix}-recipients`);
    const actEl  = document.getElementById(`${prefix}-active`);
    if (timeEl) timeEl.value = c.send_time || (prefix === 'rem' ? '17:00' : '21:00');
    if (recEl)  recEl.value  = (c.recipients||[]).join('\n');
    if (actEl)  actEl.checked = !!c.is_active;
  });
}

async function saveAlertConfig(type) {
  const prefix = type === 'reminder' ? 'rem' : 'sum';
  const send_time   = document.getElementById(`${prefix}-time`).value;
  const recipients  = (document.getElementById(`${prefix}-recipients`).value||'')
    .split('\n').map(s=>s.trim()).filter(Boolean);
  const is_active   = document.getElementById(`${prefix}-active`).checked;
  const res = await fetch('/api/alerts/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert_type: type, send_time, recipients, is_active })
  });
  if (res.ok) showToast('Alert settings saved', 'success');
  else showToast('Save failed', 'danger');
}

async function testAlert(type) {
  const endpoint = type === 'reminder' ? '/api/alerts/test-reminder' : '/api/alerts/test-summary';
  const res = await fetch(endpoint, { method: 'POST' });
  const data = await res.json();
  showToast(data.message || data.error || 'Done', res.ok ? 'success' : 'danger');
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.className = `toast align-items-center text-white border-0 bg-${type === 'success' ? 'success' : 'danger'}`;
  document.getElementById('toastMsg').textContent = msg;
  bootstrap.Toast.getOrCreateInstance(t, { delay: 2500 }).show();
}

init();
