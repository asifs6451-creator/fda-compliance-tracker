let currentDate = todayIST();

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}

async function init() {
  const user = await checkAuth();
  if (!user) return;

  // Pharmacist → go straight to their checklist
  if (user.role === 'pharmacist' && user.warehouse_id) {
    location.href = `checklist.html?id=${user.warehouse_id}`;
    return;
  }

  // Set username in navbar
  const navEl = document.getElementById('navUsername');
  if (navEl) navEl.textContent = user.full_name || user.username;

  // Show review + admin buttons for admin/manager
  if (['admin', 'manager'].includes(user.role)) {
    document.getElementById('reviewBtn')?.classList.remove('d-none');
    document.getElementById('adminBtn')?.classList.remove('d-none');
    loadReviewCount();
  }

  // Wire up filter tab clicks
  document.querySelectorAll('#filterTabs .nav-link').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterTabs .nav-link').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadDashboard();
    });
  });

  document.getElementById('datePicker').value = currentDate;
  updateDateDisplay();
  await loadDashboard();
  setInterval(loadDashboard, 60000);
}

async function loadReviewCount() {
  try {
    const data = await gasCall('reviewCount');
    if (data && data.count > 0) {
      const badge = document.getElementById('reviewBadge');
      if (badge) { badge.textContent = data.count; badge.classList.remove('d-none'); }
    }
  } catch (e) {}
}

async function loadDashboard() {
  try {
    const grid = document.getElementById('warehouseGrid');
    if (grid) grid.innerHTML = '<div class="col-12 text-center py-5 text-muted"><i class="fas fa-spinner fa-spin fa-2x d-block mb-3"></i>Loading…</div>';

    const data = await gasCall('getDashboard', { date: currentDate });
    if (!data) return;

    renderSummary(data.warehouses || []);
    renderGrid(data.warehouses || []);
    renderActivity(data.activity || []);
    updateDateDisplay();
  } catch (e) {
    const grid = document.getElementById('warehouseGrid');
    if (grid) grid.innerHTML = `<div class="col-12"><div class="alert alert-danger">Failed to load: ${e.message}</div></div>`;
  }
}

function renderSummary(warehouses) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('s-active',    warehouses.length);
  set('s-complete',  warehouses.filter(w => w.status === 'complete').length);
  set('s-partial',   warehouses.filter(w => w.status === 'partial' || w.status === 'has-no').length);
  set('s-notstarted',warehouses.filter(w => w.status === 'notstart').length);
}

function renderGrid(warehouses) {
  const activeBtn = document.querySelector('#filterTabs .nav-link.active');
  const filter    = activeBtn ? (activeBtn.dataset.filter || 'all') : 'all';

  let filtered = warehouses;
  if (filter === 'active') filtered = warehouses.filter(w => w.status !== 'notstart');
  if (filter === 'issue')  filtered = warehouses.filter(w => w.status === 'has-no' || w.status === 'partial');

  const grid = document.getElementById('warehouseGrid');
  if (!grid) return;

  if (!filtered.length) {
    grid.innerHTML = '<div class="col-12 text-center text-muted py-5">No warehouses match this filter</div>';
    return;
  }

  const badgeMap = {
    complete: '<span class="badge bg-success">✅ Complete</span>',
    'has-no': '<span class="badge bg-danger">❌ Has Issues</span>',
    partial:  '<span class="badge bg-warning text-dark">⚠️ Partial</span>',
    notstart: '<span class="badge bg-secondary">— Not Started</span>'
  };

  grid.innerHTML = filtered.map(wh => {
    const total   = wh.total || 13;
    const pct     = total ? Math.round(wh.filled / total * 100) : 0;
    const status  = wh.status || 'notstart';
    return `
    <div class="col-sm-6 col-lg-4 col-xl-3">
      <div class="card wh-card ${status} h-100"
           style="cursor:pointer"
           onclick="location.href='checklist.html?id=${wh.id}&date=${currentDate}'">
        <div class="card-body p-3">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
              <div class="fw-bold" style="font-size:.95rem">${wh.name}</div>
              <div class="text-muted small">${wh.location_code} &nbsp;·&nbsp; ${wh.pharmacist_count} pharmacist${wh.pharmacist_count>1?'s':''}</div>
            </div>
            ${badgeMap[status] || ''}
          </div>
          <div class="d-flex justify-content-between small text-muted mb-1">
            <span>${wh.filled} / ${total} items filled</span>
            <span class="fw-bold wh-pct ${status}">${pct}%</span>
          </div>
          <div class="progress rounded-pill mb-2" style="height:7px">
            <div class="progress-bar bg-success" style="width:${Math.round((wh.yes_count||0)/total*100)}%"></div>
            <div class="progress-bar bg-danger"  style="width:${Math.round((wh.no_count||0)/total*100)}%"></div>
            <div class="progress-bar bg-info"    style="width:${Math.round((wh.na_count||0)/total*100)}%"></div>
          </div>
          <div class="d-flex gap-2">
            <span class="mini-pill mp-yes">✓ ${wh.yes_count||0}</span>
            <span class="mini-pill mp-no">✗ ${wh.no_count||0}</span>
            <span class="mini-pill mp-na">— ${wh.na_count||0}</span>
            ${wh.filled > 0 ? `<span class="mini-pill mp-pd ms-auto">${total - wh.filled} left</span>` : ''}
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
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">No activity today</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td class="small">${l.warehouse_name || ''}</td>
      <td class="small text-truncate" style="max-width:180px">${l.item_title || ''}</td>
      <td class="small">${l.compliance_date || ''}</td>
      <td><span class="badge bg-${l.new_status==='yes'?'success':l.new_status==='no'?'danger':'secondary'}">${(l.new_status||'').toUpperCase()}</span></td>
      <td class="small text-muted">${l.changed_by || ''}</td>
      <td class="small text-muted">${fmtTime(l.created_at)}</td>
    </tr>`).join('');
}

function updateDateDisplay() {
  const d = new Date(currentDate + 'T00:00:00');
  const el = document.getElementById('dateLabel');
  if (el) el.textContent = d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  const btnNext  = document.getElementById('btnNext');
  const btnToday = document.getElementById('btnToday');
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

// called from datePicker onchange="setDate(this.value)"
function setDate(val) {
  if (!val || val > todayIST()) return;
  currentDate = val;
  loadDashboard();
}

function fmtTime(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }); }
  catch { return s; }
}

function logout() { doLogout(); }

init();
