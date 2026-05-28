let currentDate = todayIST();

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}

async function init() {
  const user = await checkAuth();
  if (!user) return;

  // Pharmacist with warehouse → go straight to checklist
  if (user.role === 'pharmacist' && user.warehouse_id) {
    location.href = `checklist.html?id=${user.warehouse_id}`;
    return;
  }

  document.getElementById('navUser').textContent = user.full_name || user.username;

  if (['admin', 'manager'].includes(user.role)) {
    document.getElementById('reviewBadgeWrap').classList.remove('d-none');
    document.getElementById('adminLink').classList.remove('d-none');
    loadReviewCount();
  }

  document.getElementById('datePicker').value = currentDate;
  await loadDashboard();
  setInterval(loadDashboard, 60000);
}

async function loadReviewCount() {
  try {
    const data = await gasCall('reviewCount');
    if (data && data.count > 0) {
      const badge = document.getElementById('reviewBadge');
      badge.textContent = data.count;
      badge.classList.remove('d-none');
    }
  } catch (e) {}
}

async function loadDashboard() {
  try {
    document.getElementById('loadingSpinner')?.classList.remove('d-none');
    const data = await gasCall('getDashboard', { date: currentDate });
    if (!data) return;
    renderSummary(data.warehouses);
    renderGrid(data.warehouses);
    renderActivity(data.activity || []);
    updateDateDisplay();
  } catch (e) {
    document.getElementById('whGrid').innerHTML =
      `<div class="col-12"><div class="alert alert-danger">Failed to load: ${e.message}</div></div>`;
  } finally {
    document.getElementById('loadingSpinner')?.classList.add('d-none');
  }
}

function renderSummary(warehouses) {
  document.getElementById('statTotal').textContent    = warehouses.length;
  document.getElementById('statComplete').textContent = warehouses.filter(w => w.status === 'complete').length;
  document.getElementById('statPartial').textContent  = warehouses.filter(w => w.status === 'partial' || w.status === 'has-no').length;
  document.getElementById('statNotStart').textContent = warehouses.filter(w => w.status === 'notstart').length;
}

function renderGrid(warehouses) {
  const activeBtn = document.querySelector('#filterTabs .active');
  const filter    = activeBtn ? (activeBtn.dataset.filter || 'all') : 'all';
  let filtered = warehouses;
  if (filter === 'active') filtered = warehouses.filter(w => w.status !== 'notstart');
  if (filter === 'issues') filtered = warehouses.filter(w => w.status === 'has-no' || w.status === 'partial');

  const grid = document.getElementById('whGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="col-12 text-center text-muted py-5">No warehouses match this filter</div>';
    return;
  }
  const colorMap = { complete: '#16a34a', 'has-no': '#dc2626', partial: '#d97706', notstart: '#94a3b8' };
  const badgeMap = {
    complete: '<span class="badge bg-success">Complete</span>',
    'has-no': '<span class="badge bg-danger">Has Issues</span>',
    partial:  '<span class="badge bg-warning text-dark">Partial</span>',
    notstart: '<span class="badge bg-secondary">Not Started</span>'
  };
  grid.innerHTML = filtered.map(wh => {
    const total = wh.total || 13;
    const pct   = total ? Math.round(wh.filled / total * 100) : 0;
    const color = colorMap[wh.status] || '#94a3b8';
    return `
    <div class="col-sm-6 col-lg-4 col-xl-3">
      <div class="card border-0 shadow-sm h-100" style="cursor:pointer;border-top:4px solid ${color}!important"
           onclick="location.href='checklist.html?id=${wh.id}&date=${currentDate}'">
        <div class="card-body p-3">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
              <div class="fw-semibold">${wh.name}</div>
              <div class="text-muted small">${wh.location_code}</div>
            </div>
            ${badgeMap[wh.status] || ''}
          </div>
          <div class="d-flex justify-content-between small text-muted mb-1">
            <span>${wh.filled} / ${total} items</span><span>${pct}%</span>
          </div>
          <div class="progress rounded-pill mb-2" style="height:6px">
            <div class="progress-bar bg-success" style="width:${Math.round(wh.yes_count/total*100)}%"></div>
            <div class="progress-bar bg-danger"  style="width:${Math.round(wh.no_count/total*100)}%"></div>
            <div class="progress-bar bg-secondary" style="width:${Math.round(wh.na_count/total*100)}%"></div>
          </div>
          <div class="d-flex gap-3 small">
            <span class="text-success">✓ ${wh.yes_count} Yes</span>
            <span class="text-danger">✗ ${wh.no_count} No</span>
            <span class="text-muted">— ${wh.na_count} N/A</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderActivity(logs) {
  const tbody = document.getElementById('activityBody');
  if (!tbody) return;
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">No activity today</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td class="small text-muted">${fmtTime(l.created_at)}</td>
      <td class="small">${l.warehouse_name || ''}</td>
      <td class="small text-truncate" style="max-width:180px">${l.item_title || ''}</td>
      <td><span class="badge bg-${l.new_status==='yes'?'success':l.new_status==='no'?'danger':'secondary'}">${(l.new_status||'').toUpperCase()}</span></td>
      <td class="small text-muted">${l.changed_by || ''}</td>
    </tr>`).join('');
}

function updateDateDisplay() {
  const d = new Date(currentDate + 'T00:00:00');
  const el = document.getElementById('dateDisplay');
  if (el) el.textContent = d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  const btnNext  = document.getElementById('btnDateNext');
  const btnToday = document.getElementById('btnDateToday');
  if (btnNext)  btnNext.disabled  = currentDate >= todayIST();
  if (btnToday) btnToday.disabled = currentDate === todayIST();
}

function shiftDate(delta) {
  const d = new Date(currentDate + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const iso = d.toISOString().split('T')[0];
  if (iso > todayIST()) return;
  currentDate = iso;
  const dp = document.getElementById('datePicker');
  if (dp) dp.value = iso;
  loadDashboard();
}

function goToday() {
  currentDate = todayIST();
  const dp = document.getElementById('datePicker');
  if (dp) dp.value = currentDate;
  loadDashboard();
}

function onDatePick(val) {
  if (val > todayIST()) return;
  currentDate = val;
  loadDashboard();
}

function setFilter(el, filter) {
  document.querySelectorAll('#filterTabs .btn').forEach(b => { b.classList.remove('active'); delete b.dataset.filter; });
  el.classList.add('active');
  el.dataset.filter = filter;
  renderGrid(window._lastWarehouses || []);
}

function fmtTime(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }); }
  catch { return s; }
}

function logout() { doLogout(); }

init();
