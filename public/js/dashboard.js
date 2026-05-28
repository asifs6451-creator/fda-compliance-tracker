let currentDate = todayIST();
let currentFilter = 'all';
let allWarehouses = [];
let currentUser = null;

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}
function shiftDate(d) {
  const dt = new Date(currentDate + 'T00:00:00');
  dt.setDate(dt.getDate() + d);
  const iso = dt.toISOString().split('T')[0];
  if (iso > todayIST()) return;
  setDate(iso);
}
function setDate(iso) {
  currentDate = iso;
  document.getElementById('datePicker').value = iso;
  updateDateUI();
  loadDashboard();
}
function goToday() { setDate(todayIST()); }
function updateDateUI() {
  const isToday = currentDate === todayIST();
  const d = new Date(currentDate + 'T00:00:00');
  document.getElementById('dateLabel').textContent =
    (isToday ? 'Today — ' : '') + d.toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  document.getElementById('btnNext').disabled = isToday;
  document.getElementById('btnToday').disabled = isToday;
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { location.href = '/login.html'; return; }
    const { user } = await res.json();
    currentUser = user;
    document.getElementById('navUsername').textContent = user.full_name || user.username;
    document.getElementById('navRole').textContent = `Role: ${user.role}`;
    if (['admin','manager'].includes(user.role)) {
      document.getElementById('adminBtn')?.classList.remove('d-none');
      document.getElementById('reviewBtn')?.classList.remove('d-none');
      loadReviewCount();
    }
    // Pharmacist with single warehouse → redirect to checklist
    if (user.role === 'pharmacist' && user.warehouse_id) {
      location.href = `/checklist.html?id=${user.warehouse_id}`;
      return;
    }
    loadDashboard();
    loadActivity();
  } catch { location.href = '/login.html'; }
}

async function loadReviewCount() {
  try {
    const res = await fetch('/api/review/count');
    const { count } = await res.json();
    const badge = document.getElementById('reviewBadge');
    if (badge) badge.textContent = count > 0 ? count : '';
  } catch {}
}

async function loadDashboard() {
  try {
    const res = await fetch(`/api/dashboard?date=${currentDate}`);
    const data = await res.json();
    allWarehouses = data.warehouses;
    renderStats();
    renderGrid();
  } catch (e) {
    document.getElementById('warehouseGrid').innerHTML =
      `<div class="col-12 alert alert-danger">Error: ${e.message}</div>`;
  }
}

function renderStats() {
  const active = allWarehouses.filter(w => w.is_active);
  const complete = active.filter(w => w.filled === w.total_items && w.filled > 0 && w.no_count === 0);
  const partial = active.filter(w => w.filled > 0 && (w.filled < w.total_items || w.no_count > 0));
  const notStart = active.filter(w => w.filled === 0);
  document.getElementById('s-active').textContent     = active.length;
  document.getElementById('s-complete').textContent   = complete.length;
  document.getElementById('s-partial').textContent    = partial.length;
  document.getElementById('s-notstarted').textContent = notStart.length;
}

function renderGrid() {
  const filtered = allWarehouses.filter(w => {
    if (currentFilter === 'active') return w.is_active;
    if (currentFilter === 'issue')  return w.is_active && w.no_count > 0;
    return true;
  });
  if (!filtered.length) {
    document.getElementById('warehouseGrid').innerHTML =
      '<div class="col-12 text-center text-muted py-4">No locations match this filter</div>';
    return;
  }
  document.getElementById('warehouseGrid').innerHTML = filtered.map(cardHtml).join('');
}

function cardHtml(w) {
  const total = w.total_items;
  const allFilled = w.filled === total && total > 0;
  const cls = !w.is_active ? 'notstart' : w.no_count > 0 ? 'has-no' :
    (allFilled && w.no_count === 0) ? 'complete' : w.filled > 0 ? 'partial' : 'notstart';
  const pctCls = cls;
  const pending = total - w.filled;
  const isToday = w.is_today;

  return `
  <div class="col-sm-6 col-xl-4">
    <div class="card wh-card shadow-sm ${cls} ${!w.is_active ? 'inactive' : ''}">
      <div class="card-body pb-2">
        <div class="d-flex justify-content-between align-items-start mb-3">
          <div>
            <div class="fw-bold">${w.name}</div>
            <div class="text-muted small">${w.location_code}</div>
          </div>
          <div class="text-end">
            <div class="wh-pct ${pctCls}">${w.filled}/${total}</div>
            <span class="badge ${w.is_active ? 'bg-success-subtle text-success' : 'bg-secondary-subtle text-secondary'}" style="font-size:.68rem">
              ${w.is_active ? 'Active' : 'Closed'}
            </span>
          </div>
        </div>
        <div class="mb-2">
          <div class="progress rounded-pill mb-2" style="height:8px">
            <div class="progress-bar bg-success" style="width:${total ? Math.round(w.yes_count/total*100) : 0}%"></div>
            <div class="progress-bar bg-danger"  style="width:${total ? Math.round(w.no_count/total*100) : 0}%"></div>
            <div class="progress-bar bg-info"    style="width:${total ? Math.round(w.na_count/total*100) : 0}%"></div>
          </div>
          <div class="d-flex gap-2 flex-wrap">
            ${w.yes_count ? `<span class="mini-pill mp-yes"><i class="fas fa-check fa-xs"></i>${w.yes_count} Yes</span>` : ''}
            ${w.no_count  ? `<span class="mini-pill mp-no"><i class="fas fa-xmark fa-xs"></i>${w.no_count} No</span>` : ''}
            ${w.na_count  ? `<span class="mini-pill mp-na"><i class="fas fa-minus fa-xs"></i>${w.na_count} N/A</span>` : ''}
            ${pending > 0 ? `<span class="mini-pill mp-pd"><i class="fas fa-clock fa-xs"></i>${pending} Pending</span>` : ''}
          </div>
        </div>
        <div class="text-muted mb-2" style="font-size:.72rem">
          ${w.last_updated ? `Last by <strong>${w.last_by||'?'}</strong> at ${fmtTime(w.last_updated)}` : `Not yet filled for ${isToday ? 'today' : 'this date'}`}
        </div>
        <a href="/checklist.html?id=${w.id}&date=${currentDate}"
           class="btn btn-sm w-100 ${w.is_active ? (allFilled ? 'btn-outline-success' : 'btn-primary') : 'btn-outline-secondary'} fw-semibold">
          <i class="fas fa-clipboard-check me-2"></i>${isToday ? "Fill Today's Checklist" : 'View Checklist'}
          ${allFilled && w.no_count === 0 ? ' <i class="fas fa-circle-check ms-1 text-success"></i>' : ''}
        </a>
      </div>
    </div>
  </div>`;
}

async function loadActivity() {
  try {
    const res = await fetch('/api/activity?limit=30');
    const logs = await res.json();
    const tbody = document.getElementById('activityBody');
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">No activity yet</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr>
        <td class="fw-semibold small">${l.warehouse_name||'—'}</td>
        <td class="small text-muted" style="max-width:220px">${l.item_title||'—'}</td>
        <td class="small">${l.compliance_date||'—'}</td>
        <td><span class="sbadge sb-${l.old_status||'pending'}">${fmtStatus(l.old_status)}</span>
          <i class="fas fa-arrow-right text-muted mx-1" style="font-size:.6rem"></i>
          <span class="sbadge sb-${l.new_status}">${fmtStatus(l.new_status)}</span></td>
        <td class="small">${l.changed_by||'—'}</td>
        <td class="small text-muted">${fmtDT(l.created_at)}</td>
      </tr>`).join('');
  } catch {}
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

function fmtStatus(s) {
  return {yes:'Yes',no:'No',na:'N/A',pending:'Pending'}[s] || s || '—';
}
function fmtTime(d) {
  try { return new Date(d).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}); } catch { return ''; }
}
function fmtDT(d) {
  try { return new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch { return d||''; }
}

document.querySelectorAll('#filterTabs .nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filterTabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderGrid();
  });
});

document.getElementById('datePicker').value = currentDate;
updateDateUI();
checkAuth();
setInterval(loadDashboard, 60000);
