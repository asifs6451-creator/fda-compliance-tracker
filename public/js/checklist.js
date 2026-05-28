const params      = new URLSearchParams(location.search);
const warehouseId = +params.get('id');
if (!warehouseId) location.href = 'index.html';

let currentDate  = params.get('date') || todayIST();
let allItems     = [];
let statusMap    = {};
let warehouse    = null;
let pendingSaves = {};
let saveTimer    = null;
let isReadOnly   = false;
let currentUser  = null;

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}
function shiftDate(delta) {
  const d = new Date(currentDate + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const iso = d.toISOString().split('T')[0];
  if (iso > todayIST()) return;
  setDate(iso);
}
function setDate(iso) {
  currentDate = iso;
  document.getElementById('cDatePicker').value = iso;
  isReadOnly = iso < todayIST();
  document.getElementById('cBtnNext').disabled  = iso >= todayIST();
  document.getElementById('cBtnToday').disabled = iso === todayIST();
  document.getElementById('dateDisplay').textContent = fmtDate(iso);
  document.title = (warehouse?.name || 'Checklist') + ' — ' + fmtDate(iso);
  loadCompliance();
}
function goToday() { setDate(todayIST()); }

async function init() {
  try {
    currentUser = await checkAuth();
    if (!currentUser) return;

    if (currentUser.role === 'pharmacist' && currentUser.warehouse_id && currentUser.warehouse_id != warehouseId) {
      location.href = `checklist.html?id=${currentUser.warehouse_id}`;
      return;
    }

    const el = document.getElementById('navUser');
    if (el) el.textContent = currentUser.full_name || currentUser.username;

    const warehouses = await gasCall('getWarehouses');
    warehouse = (warehouses || []).find(w => w.id == warehouseId);
    if (!warehouse) { alert('Warehouse not found'); return; }

    document.getElementById('whName').textContent = warehouse.name;
    document.getElementById('whMeta').textContent =
      `${warehouse.location_code} · Pharmacist(s) on license: ${warehouse.pharmacist_count}`;

    const pInput = document.getElementById('pharmacistName');
    pInput.value = currentUser.full_name || currentUser.username || localStorage.getItem('pharmacistName') || '';
    pInput.addEventListener('input', () => localStorage.setItem('pharmacistName', pInput.value.trim()));

    setDate(currentDate);
    loadHistory();
  } catch (e) {
    document.getElementById('checklistContainer').innerHTML =
      `<div class="alert alert-danger mx-3">Failed to load: ${e.message}</div>`;
  }
}

async function loadCompliance() {
  try {
    const data = await gasCall('getCompliance', { warehouseId, date: currentDate });
    if (!data) return;
    allItems  = data.rows;
    statusMap = {};
    allItems.forEach(r => {
      statusMap[r.item_id] = {
        dcId:        r.id || null,
        status:      r.status      || 'pending',
        notes:       r.notes       || '',
        image_count: r.image_count || 0
      };
    });
    render();
  } catch (e) {
    document.getElementById('checklistContainer').innerHTML =
      `<div class="alert alert-danger">Failed to load: ${e.message}</div>`;
  }
}

function render() {
  const container = document.getElementById('checklistContainer');
  if (!allItems.length) {
    container.innerHTML = '<div class="text-muted text-center py-4">No checklist items found</div>';
    return;
  }
  const readonlyBanner = isReadOnly
    ? `<div class="alert alert-warning py-2 px-3 mb-3 small fw-semibold">
         <i class="fas fa-lock me-2"></i>Viewing past date — read-only mode.</div>` : '';
  container.innerHTML = readonlyBanner + allItems.map(item => itemHtml(item)).join('');
  attachListeners();
  updateProgress();
}

function itemHtml(item) {
  const st       = statusMap[item.item_id] || { status:'pending', notes:'', image_count:0 };
  const disabled = isReadOnly ? 'disabled' : '';
  const imgCount = st.image_count || 0;
  const isNumber = item.item_type === 'number';
  const expected = warehouse?.pharmacist_count;

  let answerHtml;
  if (isNumber) {
    const val = st.notes && /^\d+$/.test(String(st.notes).trim()) ? String(st.notes).trim() : '';
    answerHtml = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <label class="small text-muted mb-0">Count on license:</label>
        <span class="fw-bold text-primary">${expected}</span>
        <label class="small text-muted mb-0 ms-2">Current count:</label>
        <input type="number" min="0" max="20" class="count-input count-entry"
          data-item-id="${item.item_id}" value="${val}" placeholder="0" ${disabled}
          oninput="handleCount(${item.item_id}, this.value)">
        ${val && parseInt(val)===parseInt(expected)
          ? `<span class="sbadge sb-yes">Matches</span>`
          : val ? `<span class="sbadge sb-no">Mismatch</span>` : ''}
      </div>`;
  } else {
    answerHtml = `
      <div class="answer-group">
        ${ansBtn(item.item_id,'yes','YES','fa-circle-check',st.status,disabled)}
        ${ansBtn(item.item_id,'no', 'NO', 'fa-circle-xmark',st.status,disabled)}
        ${ansBtn(item.item_id,'na', 'N/A','fa-circle-minus',st.status,disabled)}
      </div>`;
  }

  const detailOpen = st.notes || imgCount > 0;
  return `
  <div class="chk-item p-3 st-${st.status}" id="item-${item.item_id}">
    <div class="d-flex gap-3 align-items-start">
      <div class="chk-num">${item.sr_no}</div>
      <div class="flex-grow-1 min-w-0">
        <div class="chk-title mb-2">${item.title}</div>
        <div class="d-flex flex-wrap align-items-start gap-3">
          ${answerHtml}
          ${!isReadOnly ? `
          <label class="upload-btn mb-0 ms-auto flex-shrink-0">
            <i class="fas fa-camera"></i>
            <span>${imgCount > 0 ? imgCount + ' photo' + (imgCount > 1?'s':'') : 'Upload'}</span>
            <input type="file" accept="image/*,application/pdf" class="d-none file-input"
              data-item-id="${item.item_id}" multiple>
          </label>` :
          imgCount > 0 ? `<button class="btn btn-sm btn-outline-secondary ms-auto"
            onclick="viewImages(${item.item_id})">
            <i class="fas fa-images me-1"></i>${imgCount} photo${imgCount>1?'s':''}</button>` : ''}
        </div>
        <div class="chk-detail ${detailOpen ? '' : 'd-none'}" id="detail-${item.item_id}">
          ${!isNumber ? `<textarea class="form-control notes-input mt-2"
            placeholder="Notes (optional)…" ${disabled}
            id="notes-${item.item_id}"
            oninput="handleNote(${item.item_id})">${escHtml(st.notes)}</textarea>` : ''}
          <div class="d-flex flex-wrap gap-2 mt-2" id="thumbs-${item.item_id}"></div>
        </div>
        ${!isReadOnly ? `<button class="btn btn-link btn-sm text-muted p-0 mt-1 toggle-detail"
          data-target="detail-${item.item_id}" style="font-size:.74rem">
          <i class="fas fa-${detailOpen?'chevron-up':'note-sticky'} me-1"></i>
          ${detailOpen ? 'Hide notes' : 'Add notes'}
        </button>` : ''}
      </div>
    </div>
  </div>`;
}

function ansBtn(itemId, val, label, icon, current, disabled) {
  const sel = current === val ? `sel-${val}` : '';
  return `<button class="ans-btn ${sel}" data-item="${itemId}" data-val="${val}"
    onclick="setAnswer(${itemId},'${val}')" ${disabled}>
    <i class="fas ${icon}"></i>${label}</button>`;
}

function attachListeners() {
  document.querySelectorAll('.file-input').forEach(input => {
    input.addEventListener('change', async e => {
      const id = e.target.dataset.itemId;
      for (const file of Array.from(e.target.files)) await uploadFile(id, file);
      e.target.value = '';
    });
  });
  document.querySelectorAll('.toggle-detail').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const hidden = target.classList.contains('d-none');
      target.classList.toggle('d-none', !hidden);
      const ic = btn.querySelector('i');
      if (ic) ic.className = hidden ? 'fas fa-chevron-up me-1' : 'fas fa-note-sticky me-1';
      btn.childNodes[btn.childNodes.length - 1].textContent = hidden ? ' Hide notes' : ' Add notes';
    });
  });
}

function setAnswer(itemId, val) {
  if (isReadOnly) return;
  if (!statusMap[itemId]) statusMap[itemId] = { status:'pending', notes:'', image_count:0 };
  statusMap[itemId].status = val;
  const card = document.getElementById(`item-${itemId}`);
  card.className = card.className.replace(/\bst-\S+/, '') + ' st-' + val;
  card.querySelectorAll('.ans-btn').forEach(btn => btn.classList.toggle(`sel-${btn.dataset.val}`, btn.dataset.val === val));
  if (val === 'no') document.getElementById(`detail-${itemId}`)?.classList.remove('d-none');
  scheduleSave(itemId);
  updateProgress();
}

function handleCount(itemId, val) {
  if (isReadOnly) return;
  if (!statusMap[itemId]) statusMap[itemId] = { status:'pending', notes:'', image_count:0 };
  const n = parseInt(val);
  statusMap[itemId].notes  = val;
  statusMap[itemId].status = isNaN(n) ? 'pending' : n === warehouse?.pharmacist_count ? 'yes' : 'no';
  scheduleSave(itemId);
  updateProgress();
}

function handleNote(itemId) {
  if (!statusMap[itemId]) statusMap[itemId] = { status:'pending', notes:'', image_count:0 };
  statusMap[itemId].notes = document.getElementById(`notes-${itemId}`)?.value || '';
  scheduleSave(itemId);
}

function updateProgress() {
  const total = allItems.length;
  const yes   = allItems.filter(i => statusMap[i.item_id]?.status === 'yes').length;
  const no    = allItems.filter(i => statusMap[i.item_id]?.status === 'no').length;
  const na    = allItems.filter(i => statusMap[i.item_id]?.status === 'na').length;
  const done  = yes + no + na;
  const yPct  = total ? Math.round(yes / total * 100) : 0;
  const nPct  = total ? Math.round(no  / total * 100) : 0;
  const naPct = total ? Math.round(na  / total * 100) : 0;
  document.getElementById('progressLabel').textContent =
    `${done} / ${total} items completed — ${yes} Yes · ${no} No · ${na} N/A`;
  document.getElementById('progressBarYes').style.width = yPct + '%';
  document.getElementById('progressBarNo').style.width  = nPct + '%';
  document.getElementById('progressBarNa').style.width  = naPct + '%';
  document.getElementById('navProgressBar').style.width = (done / total * 100) + '%';
  document.getElementById('navProgressPct').textContent = Math.round(done / total * 100) + '%';
  document.getElementById('footerStats').textContent    = `${done}/${total} filled · ${yes} ✓ · ${no} ✗ · ${na} N/A`;
}

function scheduleSave(itemId) {
  pendingSaves[itemId] = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 1000);
}

async function flushSaves() {
  if (isReadOnly) return;
  const pharmacistName = document.getElementById('pharmacistName').value.trim() || 'Unknown';
  const ids = Object.keys(pendingSaves);
  if (!ids.length) return;
  pendingSaves = {};
  await Promise.all(ids.map(id => {
    const st = statusMap[id] || {};
    return gasCall('saveCompliance', {
      warehouse_id: warehouseId, item_id: id,
      compliance_date: currentDate, status: st.status || 'pending',
      checked_by: pharmacistName, notes: st.notes || null
    });
  }));
  document.getElementById('lastSavedLabel').textContent =
    'Saved at ' + new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

async function saveAll() {
  const name = document.getElementById('pharmacistName').value.trim();
  if (!name) { showToast('Please enter your name before saving', 'danger'); document.getElementById('pharmacistName').focus(); return; }
  allItems.forEach(i => { pendingSaves[i.item_id] = true; });
  await flushSaves();
  showToast('All changes saved ✓', 'success');
}

/* ── File upload: convert to base64 then send via gasCall ── */

function fileToBase64(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
}

async function uploadFile(itemId, file) {
  const pname = document.getElementById('pharmacistName').value.trim() || 'Unknown';
  showToast('Uploading…', 'info');
  try {
    const base64 = await fileToBase64(file);
    const data = await gasCall('uploadImage', {
      warehouse_id:    warehouseId,
      item_id:         itemId,
      compliance_date: currentDate,
      checked_by:      pname,
      data:            base64,
      filename:        file.name,
      mimeType:        file.type || 'application/octet-stream'
    });
    if (!data) return;

    if (!statusMap[itemId]) statusMap[itemId] = { status:'yes', notes:'', image_count:0 };
    statusMap[itemId].image_count = (statusMap[itemId].image_count || 0) + 1;
    const imgCount = statusMap[itemId].image_count;

    const uploadLabel = document.querySelector(`#item-${itemId} .upload-btn span`);
    if (uploadLabel) uploadLabel.textContent = imgCount + ' photo' + (imgCount > 1 ? 's' : '');

    const thumbs = document.getElementById(`thumbs-${itemId}`);
    if (thumbs) {
      const wrap  = document.createElement('div');
      wrap.className = 'position-relative';
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      wrap.innerHTML = isPdf
        ? `<div class="ev-thumb d-flex align-items-center justify-content-center bg-light border" title="${file.name}">
             <i class="fas fa-file-pdf text-danger fa-lg"></i></div>
           <button class="thumb-del" onclick="delImg(this.parentNode,${data.id})" title="Remove">✕</button>`
        : `<img src="${data.url}" class="ev-thumb" onclick="window.open('${data.url}','_blank')" title="${file.name}">
           <button class="thumb-del" title="Remove" onclick="delImg(this.parentNode,${data.id})">✕</button>`;
      thumbs.appendChild(wrap);
      document.getElementById(`detail-${itemId}`)?.classList.remove('d-none');
    }
    showToast('Photo uploaded ✓', 'success');
  } catch (e) {
    showToast('Upload failed: ' + e.message, 'danger');
  }
}

async function delImg(wrap, uploadId) {
  if (!confirm('Remove this photo?')) return;
  try {
    if (uploadId) await gasCall('deleteImage', { uploadId });
    wrap.remove();
    showToast('Removed', 'info');
  } catch { showToast('Remove failed', 'danger'); }
}

async function viewImages(itemId) {
  try {
    const imgs = await gasCall('getImages', { warehouseId, itemId, date: currentDate });
    const item = allItems.find(i => i.item_id == itemId);
    document.getElementById('imageModalTitle').textContent = item?.title || 'Evidence Photos';
    if (!imgs || !imgs.length) {
      document.getElementById('imageModalBody').innerHTML =
        '<p class="text-muted text-center py-3">No photos uploaded for this item</p>';
    } else {
      document.getElementById('imageModalBody').innerHTML = `
        <div class="d-flex flex-wrap gap-3 justify-content-center py-2">
          ${imgs.map(img => {
            const isPdf = (img.original_name || '').toLowerCase().endsWith('.pdf');
            return isPdf
              ? `<div class="text-center">
                   <a href="${img.url}" target="_blank" class="btn btn-outline-danger btn-sm">
                     <i class="fas fa-file-pdf me-1"></i>${img.original_name}</a>
                   <div class="text-muted small mt-1">${fmtDateTime(img.uploaded_at)}</div></div>`
              : `<div class="text-center">
                   <img src="${img.url}" class="img-thumbnail" style="max-height:200px;cursor:pointer"
                     onclick="window.open('${img.url}','_blank')">
                   <div class="text-muted small mt-1">${fmtDateTime(img.uploaded_at)}</div></div>`;
          }).join('')}
        </div>`;
    }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('imageModal')).show();
  } catch { showToast('Could not load photos', 'danger'); }
}

async function loadHistory() {
  try {
    const rows = await gasCall('getHistory', { warehouseId });
    const total = allItems.length || 13;
    const tbody = document.getElementById('historyBody');
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-2">No history yet</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(h => {
      const pct = total ? Math.round((h.yes_count || 0) / total * 100) : 0;
      return `<tr>
        <td><a href="checklist.html?id=${warehouseId}&date=${h.compliance_date}" class="text-decoration-none">${h.compliance_date}</a></td>
        <td>${h.filled} / ${total}</td>
        <td><span class="sbadge sb-yes">${h.yes_count || 0}</span></td>
        <td><span class="sbadge sb-no">${h.no_count || 0}</span></td>
        <td>
          <div class="progress rounded-pill" style="height:8px;width:100px;display:inline-block">
            <div class="progress-bar bg-success" style="width:${pct}%"></div>
          </div>
          <span class="ms-1 small">${pct}%</span>
        </td></tr>`;
    }).join('');
  } catch { /* silent */ }
}

function fmtDate(iso) {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' }); }
  catch { return iso; }
}
function fmtDateTime(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); }
  catch { return d; }
}
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.className = `toast align-items-center text-white border-0 bg-${type==='success'?'success':type==='danger'?'danger':'secondary'}`;
  document.getElementById('toastMsg').textContent = msg;
  bootstrap.Toast.getOrCreateInstance(t, { delay: 2200 }).show();
}

function logout() { doLogout(); }

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAll(); }
});

init();
