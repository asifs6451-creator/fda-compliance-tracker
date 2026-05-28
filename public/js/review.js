let allImages = [];
let filtered = [];

async function init() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) { location.href = '/login.html'; return; }
  const { user } = await res.json();
  if (!['admin','manager'].includes(user.role)) { location.href = '/'; return; }
  await loadLocations();
  await loadPending();
}

async function loadLocations() {
  const res = await fetch('/api/warehouses');
  const wh = await res.json();
  const sel = document.getElementById('filterLocation');
  wh.forEach(w => sel.insertAdjacentHTML('beforeend', `<option value="${w.name}">${w.name}</option>`));
}

async function loadPending() {
  const res = await fetch('/api/review/pending');
  allImages = await res.json();
  const count = allImages.filter(i => i.review_status === 'pending').length;
  document.getElementById('pendingCount').textContent = `${count} Pending`;
  applyFilter();
}

function applyFilter() {
  const loc    = document.getElementById('filterLocation').value;
  const status = document.getElementById('filterStatus').value;
  filtered = allImages.filter(img => {
    if (loc    && img.warehouse_name !== loc)    return false;
    if (status && img.review_status  !== status) return false;
    return true;
  });
  document.getElementById('resultCount').textContent = `${filtered.length} photo${filtered.length !== 1 ? 's' : ''}`;
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('reviewGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="col-12 text-center text-muted py-5"><i class="fas fa-image fa-3x d-block mb-3 opacity-25"></i>No photos to review</div>';
    return;
  }
  grid.innerHTML = filtered.map(img => imageCard(img)).join('');
}

function imageCard(img) {
  const isPdf = img.filename?.endsWith('.pdf');
  const statusBadge = {
    pending:  '<span class="badge bg-warning text-dark">⏳ Pending</span>',
    approved: '<span class="badge bg-success">✅ Approved</span>',
    rejected: '<span class="badge bg-danger">❌ Rejected</span>',
  }[img.review_status] || '';

  const thumb = isPdf
    ? `<div class="d-flex align-items-center justify-content-center bg-light" style="height:180px;border-radius:8px 8px 0 0">
         <i class="fas fa-file-pdf text-danger fa-3x"></i></div>`
    : `<img src="${img.url}" alt="Evidence"
         style="width:100%;height:180px;object-fit:cover;border-radius:8px 8px 0 0;cursor:pointer"
         onclick="window.open('${img.url}','_blank')">`;

  const actionBtns = img.review_status === 'pending'
    ? `<div class="d-flex gap-2 mt-2">
         <button class="btn btn-sm btn-success flex-grow-1" onclick="approveImg(${img.id})">
           <i class="fas fa-check me-1"></i>Approve</button>
         <button class="btn btn-sm btn-danger flex-grow-1" onclick="openReject(${img.id})">
           <i class="fas fa-times me-1"></i>Reject</button>
       </div>`
    : img.review_notes
    ? `<div class="small text-muted mt-2">Note: ${img.review_notes}</div>`
    : '';

  return `
  <div class="col-sm-6 col-md-4 col-xl-3">
    <div class="card border-0 shadow-sm h-100">
      ${thumb}
      <div class="card-body p-2">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <span class="fw-semibold small" style="font-size:.8rem">${img.warehouse_name}</span>
          ${statusBadge}
        </div>
        <div class="text-muted" style="font-size:.75rem">${img.item_title}</div>
        <div class="text-muted" style="font-size:.72rem">${img.compliance_date} · ${img.uploaded_by||'?'}</div>
        ${img.reviewed_by ? `<div class="text-muted" style="font-size:.7rem">Reviewed by: ${img.reviewed_by}</div>` : ''}
        ${actionBtns}
      </div>
    </div>
  </div>`;
}

async function approveImg(id) {
  const res = await fetch(`/api/review/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approved' })
  });
  if (res.ok) {
    const img = allImages.find(i => i.id === id);
    if (img) img.review_status = 'approved';
    applyFilter();
    showToast('Image approved ✓', 'success');
  }
}

function openReject(id) {
  document.getElementById('rejectUploadId').value = id;
  document.getElementById('rejectNotes').value = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('rejectModal')).show();
}

async function submitReject() {
  const id    = document.getElementById('rejectUploadId').value;
  const notes = document.getElementById('rejectNotes').value.trim();
  const res = await fetch(`/api/review/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rejected', notes })
  });
  bootstrap.Modal.getInstance(document.getElementById('rejectModal')).hide();
  if (res.ok) {
    const img = allImages.find(i => i.id == id);
    if (img) { img.review_status = 'rejected'; img.review_notes = notes; }
    applyFilter();
    showToast('Image rejected', 'success');
  }
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
