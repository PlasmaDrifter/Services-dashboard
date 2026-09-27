let allServices = [];
let allContainers = [];
let currentFilter = 'all'; // 'all', 'running', 'inactive'
let currentCategoryFilter = 'all'; // 'all', 'web', 'containers', 'timers'
let currentSearch = '';
let currentViewMode = 'table';
let currentEditingUnit = null;
let currentLogsUnit = null;
let currentLastScanText = 'Last scan: --:--:--';

const CATEGORY_ORDER = [
  "Web Apps & Dashboards",
  "Containers",
  "Podman Containers",
  "Scheduled Tasks & Timers",
  "Local Utilities & Daemons"
];

document.addEventListener('DOMContentLoaded', () => {
  loadSavedSettings();
  applyAllActiveSettings();
  initEventListeners();
  initSettingsUI();
  loadData();
  checkAppUpdatesAsync();
});

function updateStatCardActiveState() {
  document.querySelectorAll('.stat-card').forEach(card => {
    const cat = card.dataset.category;
    let isActive = false;

    if (currentCategoryFilter === 'all') {
      if (currentFilter === 'running' && cat === 'running') {
        isActive = true;
      } else if (currentFilter === 'all' && cat === 'all') {
        isActive = true;
      }
    } else {
      if (cat === currentCategoryFilter) {
        isActive = true;
      }
    }

    if (isActive) {
      card.classList.add('active');
      card.setAttribute('aria-pressed', 'true');
    } else {
      card.classList.remove('active');
      card.setAttribute('aria-pressed', 'false');
    }
  });
}

function handleStatCardSelection(card) {
  const cat = card.dataset.category;
  const isCurrentlyActive = card.classList.contains('active');

  // Toggle behavior: if clicking the active category card (other than 'all'), toggle off back to 'all'
  if (isCurrentlyActive && cat !== 'all') {
    currentCategoryFilter = 'all';
    currentFilter = 'all';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
    if (allBtn) allBtn.classList.add('active');
  } else if (cat === 'all') {
    currentCategoryFilter = 'all';
    currentFilter = 'all';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
    if (allBtn) allBtn.classList.add('active');
  } else if (cat === 'running') {
    currentFilter = 'running';
    currentCategoryFilter = 'all';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const runBtn = document.querySelector('.filter-btn[data-filter="running"]');
    if (runBtn) runBtn.classList.add('active');
  } else {
    currentCategoryFilter = cat;
  }

  updateStatCardActiveState();
  renderContent();
}

function initEventListeners() {
  // Scan button
  document.getElementById('btn-scan').addEventListener('click', handleManualScan);

  // Search input
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderContent();
  });

  // Filter buttons (Running / Stopped / All)
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      updateStatCardActiveState();
      renderContent();
    });
  });

  // Stat cards filter click & keyboard accessibility
  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => handleStatCardSelection(card));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleStatCardSelection(card);
      }
    });
  });

  // Editor Modal Controls
  document.getElementById('btn-close-editor').addEventListener('click', closeEditorModal);
  document.getElementById('btn-cancel-editor').addEventListener('click', closeEditorModal);
  document.getElementById('btn-save-editor').addEventListener('click', () => saveUnitFile(false));
  document.getElementById('btn-save-restart-editor').addEventListener('click', () => saveUnitFile(true));

  // Logs Modal Controls
  document.getElementById('btn-close-logs').addEventListener('click', closeLogsModal);
  document.getElementById('btn-refresh-logs').addEventListener('click', refreshLogs);
  document.getElementById('btn-copy-logs').addEventListener('click', copyLogsToClipboard);

  // Settings Modal Controls
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', openSettingsModal);
  const btnCloseSettings = document.getElementById('settings-close-btn');
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', closeSettingsModal);
  const btnDoneSettings = document.getElementById('settings-done-btn');
  if (btnDoneSettings) btnDoneSettings.addEventListener('click', closeSettingsModal);

  // Close modals on escape key or outside click
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEditorModal();
      closeLogsModal();
      closeSettingsModal();
    }
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeEditorModal();
        closeLogsModal();
        closeSettingsModal();
      }
    });
  });

  // Tab key in textarea
  const textarea = document.getElementById('editor-textarea');
  textarea.addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = this.selectionStart;
      const end = this.selectionEnd;
      this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
      this.selectionStart = this.selectionEnd = start + 4;
    }
  });
}

async function loadData() {
  try {
    const res = await fetch('/api/services');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    applyData(data);
  } catch (err) {
    console.error('Failed to load services data:', err);
    showToast('Failed to fetch services data', 'error');
  }
}

async function handleManualScan() {
  const btn = document.getElementById('btn-scan');
  const spinIcon = btn.querySelector('.spin-icon');
  const btnText = document.getElementById('scan-btn-text');
  
  btn.disabled = true;
  spinIcon.classList.add('spinning');
  btnText.textContent = 'Scanning...';

  try {
    const res = await fetch('/api/scan', { method: 'POST' });
    if (!res.ok) throw new Error(`Scan failed with status ${res.status}`);
    const result = await res.json();
    applyData(result.data);
    showToast('Scan completed successfully!');
  } catch (err) {
    console.error('Manual scan error:', err);
    showToast('Scan failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    spinIcon.classList.remove('spinning');
    btnText.textContent = 'Rescan';
  }
}

function applyData(data) {
  allServices = data.services || [];
  allContainers = data.containers || [];
  
  // Calculate Web apps count
  const webCount = allServices.filter(s => s.category === "Web Apps & Dashboards").length;
  const runningServicesCount = allServices.filter(s => s.active_state === 'active').length;
  
  // Update stats
  document.getElementById('stat-total-services').textContent = allServices.length;
  document.getElementById('stat-running-services').textContent = runningServicesCount;
  document.getElementById('stat-web').textContent = webCount;
  const containerCount = (data.stats && typeof data.stats.total_containers === 'number') ? data.stats.total_containers : allContainers.length;
  const statContainersEl = document.getElementById('stat-containers');
  if (statContainersEl) {
    statContainersEl.textContent = containerCount;
    if (data.stats && (data.stats.podman_containers !== undefined || data.stats.docker_containers !== undefined)) {
      statContainersEl.parentElement.title = `Filter Containers (${data.stats.podman_containers || 0} Podman, ${data.stats.docker_containers || 0} Docker)`;
    }
  }
  document.getElementById('stat-timers').textContent = (data.stats && data.stats.active_timers) || 0;

  if (data.last_scan) {
    currentLastScanText = `Last scan: ${data.last_scan}`;
  }

  renderContent();

  const scanEl = document.getElementById('last-scan-time');
  if (scanEl) {
    scanEl.textContent = currentLastScanText;
  }
}

function getUnifiedItems() {
  let combined = [];
  const containerMap = new Map();
  allContainers.forEach(c => {
    containerMap.set(c.name.toLowerCase(), c);
  });

  const matchedContainerNames = new Set();

  // Process services (including Quadlets)
  allServices.forEach(s => {
    let cleanName = s.name.replace('.service', '').replace('container-', '');
    let matchedContainer = containerMap.get(cleanName.toLowerCase());

    if (matchedContainer) {
      matchedContainerNames.add(matchedContainer.name.toLowerCase());
    }

    let description = s.description;
    let engine = s.type === 'quadlet' ? 'podman' : (matchedContainer ? matchedContainer.engine : null);
    if (!description && matchedContainer) {
      const engineLabel = matchedContainer.engine === 'docker' ? 'Docker' : 'Podman';
      description = `${engineLabel} Container: ${matchedContainer.image}`;
    }

    combined.push({
      itemType: s.type === 'quadlet' ? 'quadlet' : 'service',
      engine: engine,
      name: s.name,
      displayName: s.custom_name || cleanName,
      description: description || 'Background Service',
      filePath: s.file_path,
      activeState: s.active_state,
      subState: s.sub_state,
      port: s.port || (matchedContainer ? matchedContainer.port : null),
      timer: s.timer,
      category: s.category || "Local Utilities & Daemons"
    });
  });

  // Only add standalone containers that aren't already represented by a systemd quadlet or service
  allContainers.forEach(c => {
    if (!matchedContainerNames.has(c.name.toLowerCase())) {
      combined.push({
        itemType: 'container',
        engine: c.engine || 'podman',
        name: c.name,
        displayName: c.name,
        description: `Container Image: ${c.image}`,
        filePath: `${c.engine === 'docker' ? 'Docker' : 'Podman'} ID: ${c.id}`,
        activeState: c.state === 'running' ? 'active' : 'inactive',
        subState: c.status,
        port: c.port,
        timer: null,
        category: c.category || "Containers"
      });
    }
  });

  // Status Filter
  let filtered = combined.filter(item => {
    if (currentFilter === 'running') {
      return item.activeState === 'active';
    }
    if (currentFilter === 'inactive') {
      return item.activeState !== 'active';
    }
    return true;
  });

  // Category Quick Filter
  if (currentCategoryFilter !== 'all') {
    if (currentCategoryFilter === 'web') {
      filtered = filtered.filter(i => i.category === 'Web Apps & Dashboards');
    } else if (currentCategoryFilter === 'containers') {
      filtered = filtered.filter(i => i.category === 'Containers' || i.category === 'Podman Containers');
    } else if (currentCategoryFilter === 'timers') {
      filtered = filtered.filter(i => i.category === 'Scheduled Tasks & Timers');
    }
  }

  // Search Filter
  if (currentSearch) {
    filtered = filtered.filter(item => {
      const matchName = item.displayName.toLowerCase().includes(currentSearch);
      const matchFile = item.name.toLowerCase().includes(currentSearch);
      const matchDesc = item.description.toLowerCase().includes(currentSearch);
      const matchPort = item.port ? String(item.port).includes(currentSearch) : false;
      const matchEngine = item.engine && item.engine.toLowerCase().includes(currentSearch);
      const matchTimer = item.timer ? (item.timer.name.toLowerCase().includes(currentSearch) || (item.timer.schedule && item.timer.schedule.toLowerCase().includes(currentSearch))) : false;
      return matchName || matchFile || matchDesc || matchPort || matchEngine || matchTimer;
    });
  }

  return filtered;
}

function renderContent() {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  updateStatCardActiveState();

  const items = getUnifiedItems();

  if (items.length === 0) {
    const isFiltered = (currentCategoryFilter !== 'all');
    let resetBtn = '';
    if (isFiltered) {
      resetBtn = `<br><button class="btn btn-secondary btn-sm" id="btn-empty-clear-category" style="margin-top: 10px;">Show All Categories</button>`;
    }
    container.innerHTML = `<div class="empty-state">No matching services or timers found.${resetBtn}</div>`;
    const emptyClear = document.getElementById('btn-empty-clear-category');
    if (emptyClear) {
      emptyClear.addEventListener('click', () => {
        currentCategoryFilter = 'all';
        updateStatCardActiveState();
        renderContent();
      });
    }
    return;
  }

  // Group by Category
  const grouped = {};
  CATEGORY_ORDER.forEach(cat => { grouped[cat] = []; });

  items.forEach(item => {
    const cat = item.category || "Local Utilities & Daemons";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });

  // Render each category section
  let isFirstCategory = true;
  CATEGORY_ORDER.forEach(categoryName => {
    const categoryItems = grouped[categoryName] || [];
    if (categoryItems.length === 0) return;

    const section = document.createElement('section');
    section.className = 'category-section';

    const isFilteredCategory = (currentCategoryFilter !== 'all');
    if (isFilteredCategory) {
      section.classList.add('is-filtered');
    }

    let filterPillHtml = '';
    if (isFilteredCategory) {
      filterPillHtml = `
        <button class="category-filter-pill" id="btn-clear-category-filter" title="Clear category filter and show all">
          <span>Filtered</span>
          <span class="pill-close">&times;</span>
        </button>
      `;
    }

    // Category Header
    const header = document.createElement('div');
    header.className = 'category-header';

    let lastScanHtml = '';
    if (categoryName === "Web Apps & Dashboards" || isFirstCategory) {
      lastScanHtml = `<span class="last-scan-label" id="last-scan-time">${currentLastScanText}</span>`;
      isFirstCategory = false;
    }

    header.innerHTML = `
      <div class="category-title-area">
        <h2 class="category-title">${escapeHtml(categoryName)}</h2>
        <span class="category-badge">${categoryItems.length}</span>
        ${filterPillHtml}
      </div>
      ${lastScanHtml}
    `;
    section.appendChild(header);

    const clearBtn = header.querySelector('#btn-clear-category-filter');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        currentCategoryFilter = 'all';
        updateStatCardActiveState();
        renderContent();
      });
    }

    // Body: Table Mode
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'table-container';
    tableWrapper.innerHTML = renderTableHTML(categoryItems);
    section.appendChild(tableWrapper);

    container.appendChild(section);
  });
}

function renderTableHTML(items) {
  let rows = '';
  items.forEach(item => {
    const isRunning = item.activeState === 'active';
    let statusClass = isRunning ? 'active' : 'inactive';
    let statusLabel = isRunning ? 'Running' : (item.timer ? 'Timer Active' : item.activeState);

    // Port link
    let webLink = '-';
    if (item.port) {
      webLink = `<a href="http://localhost:${item.port}" target="_blank" class="port-badge">:${item.port} &nearr;</a>`;
    }

    // Timer info
    let timerInfo = '-';
    if (item.timer) {
      const nextStr = item.timer.next_str ? item.timer.next_str : (item.timer.left_str || 'Scheduled');
      const rule = item.timer.schedule ? ` (${item.timer.schedule})` : '';
      timerInfo = `<span style="color:var(--blue); font-size:0.8rem;">${escapeHtml(nextStr)}${escapeHtml(rule)}</span>`;
    }

    // Actions
    let actionButtons = '';
    if (item.itemType === 'service' || item.itemType === 'quadlet') {
      actionButtons = `
        <div class="table-actions">
          ${isRunning 
            ? `<button class="btn btn-sm btn-danger-soft" onclick="performAction('${item.name}', 'stop')">Stop</button>`
            : `<button class="btn btn-sm btn-success-soft" onclick="performAction('${item.name}', 'start')">Start</button>`
          }
          <button class="btn btn-sm btn-secondary" onclick="performAction('${item.name}', 'restart')">Restart</button>
          <button class="btn btn-sm btn-secondary" onclick="openLogsModal('${item.name}')">Logs</button>
          <button class="btn btn-sm btn-primary" onclick="openEditorModal('${item.name}')">Edit</button>
        </div>
      `;
    } else {
      actionButtons = `
        <div class="table-actions">
          <span class="file-path-badge">${escapeHtml(item.subState)}</span>
          ${item.port ? `<a class="btn btn-sm btn-primary" href="http://localhost:${item.port}" target="_blank">Open UI</a>` : ''}
        </div>
      `;
    }

    rows += `
      <tr>
        <td style="width: 140px;">
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${statusLabel}
          </span>
        </td>
        <td>
          <div class="table-service-name">
            ${escapeHtml(item.displayName)}
            ${item.engine ? `<span class="engine-badge engine-${item.engine}">${item.engine === 'docker' ? 'Docker' : 'Podman'}</span>` : ''}
          </div>
          <div class="table-service-file">${escapeHtml(item.name)}</div>
        </td>
        <td class="table-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</td>
        <td style="text-align: center;">${webLink}</td>
        <td>${timerInfo}</td>
        <td>${actionButtons}</td>
      </tr>
    `;
  });

  return `
    <table class="services-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Service Name</th>
          <th>Description</th>
          <th style="text-align: center;">Web UI</th>
          <th>Timer / Schedule</th>
          <th style="text-align: right; width: 280px; min-width: 260px;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function createCardElement(item) {
  const card = document.createElement('div');
  card.className = 'service-card';

  const isRunning = item.activeState === 'active';
  let statusClass = isRunning ? 'active' : 'inactive';
  let statusText = isRunning ? 'Running' : (item.timer ? 'Timer Scheduled' : item.activeState);

  let typeLabel = item.timer ? 'Timer' : 'Service';
  let typePillClass = '';
  if (item.itemType === 'quadlet') {
    typeLabel = 'Quadlet';
    typePillClass = 'engine-podman';
  } else if (item.itemType === 'container') {
    typeLabel = item.engine === 'docker' ? 'Docker' : 'Podman';
    typePillClass = item.engine === 'docker' ? 'engine-docker' : 'engine-podman';
  } else if (item.engine) {
    typePillClass = item.engine === 'docker' ? 'engine-docker' : 'engine-podman';
  }

  let metaHtml = '';
  if (item.timer) {
    const nextText = item.timer.next_str ? `Next: ${item.timer.next_str}` : (item.timer.left_str ? `Left: ${item.timer.left_str}` : 'Scheduled');
    const scheduleRule = item.timer.schedule ? ` (${item.timer.schedule})` : '';
    metaHtml += `
      <div class="meta-chip timer-chip">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>${escapeHtml(nextText)}${escapeHtml(scheduleRule)}</span>
      </div>
    `;
  }

  if (item.port) {
    metaHtml += `
      <div class="meta-chip web-chip">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <a href="http://localhost:${item.port}" target="_blank" rel="noopener noreferrer">
          Open Web UI (:${item.port}) &nearr;
        </a>
      </div>
    `;
  }

  let actionButtonsHtml = '';
  if (item.itemType === 'service' || item.itemType === 'quadlet') {
    actionButtonsHtml = `
      <div class="action-group-left">
        ${isRunning 
          ? `<button class="btn btn-sm btn-danger-soft" onclick="performAction('${item.name}', 'stop')">Stop</button>`
          : `<button class="btn btn-sm btn-success-soft" onclick="performAction('${item.name}', 'start')">Start</button>`
        }
        <button class="btn btn-sm btn-secondary" onclick="performAction('${item.name}', 'restart')">Restart</button>
      </div>
      <div class="action-group-right">
        <button class="btn btn-sm btn-secondary" onclick="openLogsModal('${item.name}')">Logs</button>
        <button class="btn btn-sm btn-primary" onclick="openEditorModal('${item.name}')">Edit</button>
      </div>
    `;
  } else {
    actionButtonsHtml = `
      <div class="action-group-left">
        <span class="file-path-badge">${escapeHtml(item.subState)}</span>
      </div>
      <div class="action-group-right">
        ${item.port ? `<a class="btn btn-sm btn-primary" href="http://localhost:${item.port}" target="_blank">Open UI</a>` : ''}
      </div>
    `;
  }

  card.innerHTML = `
    <div>
      <div class="card-top">
        <div class="card-title-group">
          <div class="service-title">${escapeHtml(item.displayName)}</div>
          <div class="service-filename">${escapeHtml(item.name)}</div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${statusText}
          </span>
          <span class="type-pill ${typePillClass}">${typeLabel}</span>
        </div>
      </div>
      <div class="service-desc">${escapeHtml(item.description)}</div>
      <div class="card-meta-bar">${metaHtml}</div>
    </div>
    <div class="card-actions">${actionButtonsHtml}</div>
  `;

  return card;
}

// Service Actions (Start / Stop / Restart)
async function performAction(unitName, action) {
  try {
    showToast(`Sending ${action} command to ${unitName}...`);
    const res = await fetch(`/api/service/${unitName}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || `Action failed`);
    }
    showToast(`Successfully performed ${action} on ${unitName}!`);
    loadData();
  } catch (err) {
    console.error('Service action error:', err);
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Editor Modal
async function openEditorModal(unitName) {
  currentEditingUnit = unitName;
  const modal = document.getElementById('editor-modal');
  const title = document.getElementById('editor-title');
  const pathBadge = document.getElementById('editor-file-path');
  const textarea = document.getElementById('editor-textarea');
  const banner = document.getElementById('editor-banner');

  banner.className = 'banner hidden';
  title.textContent = `Edit ${unitName}`;
  textarea.value = 'Loading file contents...';
  modal.classList.add('open');

  try {
    const res = await fetch(`/api/service/${unitName}/file`);
    if (!res.ok) throw new Error(`Could not load unit file`);
    const data = await res.json();
    pathBadge.textContent = data.file_path;
    textarea.value = data.content;
    textarea.focus();
  } catch (err) {
    console.error('Error fetching unit file:', err);
    textarea.value = `Error loading file: ${err.message}`;
  }
}

function closeEditorModal() {
  document.getElementById('editor-modal').classList.remove('open');
  currentEditingUnit = null;
}

async function saveUnitFile(restartAfter) {
  if (!currentEditingUnit) return;
  const textarea = document.getElementById('editor-textarea');
  const banner = document.getElementById('editor-banner');
  const saveBtn = document.getElementById('btn-save-editor');
  const saveRestartBtn = document.getElementById('btn-save-restart-editor');

  saveBtn.disabled = true;
  saveRestartBtn.disabled = true;
  banner.className = 'banner hidden';

  try {
    const res = await fetch(`/api/service/${currentEditingUnit}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: textarea.value,
        restart: restartAfter
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Save failed');
    }
    const result = await res.json();
    banner.className = 'banner success';
    banner.textContent = `File saved successfully! (Backup: ${result.backup})${result.restarted ? ' Service restarted.' : ''}`;
    banner.classList.remove('hidden');
    showToast(`Saved ${currentEditingUnit}!`);
    loadData();
    setTimeout(() => {
      closeEditorModal();
    }, 1200);
  } catch (err) {
    banner.className = 'banner error';
    banner.textContent = `Error saving file: ${err.message}`;
    banner.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveRestartBtn.disabled = false;
  }
}

// Logs Modal
async function openLogsModal(unitName) {
  currentLogsUnit = unitName;
  const modal = document.getElementById('logs-modal');
  const title = document.getElementById('logs-title');
  const unitBadge = document.getElementById('logs-unit-name');
  const terminal = document.getElementById('logs-terminal');

  title.textContent = `Journal Logs: ${unitName}`;
  unitBadge.textContent = unitName;
  terminal.textContent = 'Loading logs...';
  modal.classList.add('open');

  await refreshLogs();
}

function closeLogsModal() {
  document.getElementById('logs-modal').classList.remove('open');
  currentLogsUnit = null;
}

async function refreshLogs() {
  if (!currentLogsUnit) return;
  const terminal = document.getElementById('logs-terminal');
  try {
    const res = await fetch(`/api/service/${currentLogsUnit}/logs?lines=100`);
    if (!res.ok) throw new Error('Could not fetch logs');
    const data = await res.json();
    terminal.textContent = data.logs || 'No journal log entries found for this service.';
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    terminal.textContent = `Error fetching logs: ${err.message}`;
  }
}

function copyLogsToClipboard() {
  const terminal = document.getElementById('logs-terminal');
  navigator.clipboard.writeText(terminal.textContent).then(() => {
    showToast('Logs copied to clipboard!');
  }).catch(() => {
    showToast('Failed to copy logs', 'error');
  });
}

// Toast
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.borderColor = type === 'error' ? 'var(--danger)' : 'var(--primary)';
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   Settings, Themes & Integration System (AppIndex Model)
   ========================================================================== */

const STORAGE_KEY = "podman_dashboard_settings_v1";

const PRESET_THEMES = {
  "catppuccin": {
    name: "Catppuccin Macchiato",
    colors: {
      "--bg-primary": "#181926",
      "--bg-secondary": "#1e2030",
      "--bg-card": "#24273a",
      "--bg-card-hover": "#2b2f46",
      "--border-color": "#363a4f",
      "--text-primary": "#cad3f5",
      "--text-secondary": "#a5adcb",
      "--text-muted": "#8087a2",
      "--accent-blue": "#8aadf4",
      "--accent-purple": "#c6a0f6",
      "--accent-orange": "#f5a97f",
      "--accent-green": "#a6da95",
      "--accent-red": "#ed8796"
    },
    swatches: ["#181926", "#24273a", "#8aadf4", "#c6a0f6"]
  },
  "tokyo-night": {
    name: "Tokyo Night",
    colors: {
      "--bg-primary": "#1a1b26",
      "--bg-secondary": "#16161e",
      "--bg-card": "#24283b",
      "--bg-card-hover": "#2f354f",
      "--border-color": "#292e42",
      "--text-primary": "#c0caf5",
      "--text-secondary": "#9aa5ce",
      "--text-muted": "#565f89",
      "--accent-blue": "#7aa2f7",
      "--accent-purple": "#bb9af7",
      "--accent-orange": "#ff9e64",
      "--accent-green": "#9ece6a",
      "--accent-red": "#f7768e"
    },
    swatches: ["#1a1b26", "#24283b", "#7aa2f7", "#bb9af7"]
  },
  "nord": {
    name: "Nord",
    colors: {
      "--bg-primary": "#2e3440",
      "--bg-secondary": "#242933",
      "--bg-card": "#3b4252",
      "--bg-card-hover": "#434c5e",
      "--border-color": "#4c566a",
      "--text-primary": "#eceff4",
      "--text-secondary": "#e5e9f0",
      "--text-muted": "#81a1c1",
      "--accent-blue": "#88c0d0",
      "--accent-purple": "#b48ead",
      "--accent-orange": "#d08770",
      "--accent-green": "#a3be8c",
      "--accent-red": "#bf616a"
    },
    swatches: ["#2e3440", "#3b4252", "#88c0d0", "#b48ead"]
  },
  "gruvbox": {
    name: "Gruvbox Dark",
    colors: {
      "--bg-primary": "#1d2021",
      "--bg-secondary": "#282828",
      "--bg-card": "#32302f",
      "--bg-card-hover": "#3c3836",
      "--border-color": "#504945",
      "--text-primary": "#ebdbb2",
      "--text-secondary": "#d5c4a1",
      "--text-muted": "#928374",
      "--accent-blue": "#83a598",
      "--accent-purple": "#d3869b",
      "--accent-orange": "#fe8019",
      "--accent-green": "#b8bb26",
      "--accent-red": "#fb4934"
    },
    swatches: ["#1d2021", "#32302f", "#83a598", "#fe8019"]
  },
  "dracula": {
    name: "Dracula",
    colors: {
      "--bg-primary": "#21222c",
      "--bg-secondary": "#282a36",
      "--bg-card": "#343746",
      "--bg-card-hover": "#44475a",
      "--border-color": "#6272a4",
      "--text-primary": "#f8f8f2",
      "--text-secondary": "#e2e2dc",
      "--text-muted": "#9ea8c7",
      "--accent-blue": "#8be9fd",
      "--accent-purple": "#bd93f9",
      "--accent-orange": "#ffb86c",
      "--accent-green": "#50fa7b",
      "--accent-red": "#ff5555"
    },
    swatches: ["#21222c", "#343746", "#8be9fd", "#bd93f9"]
  },
  "cyberpunk": {
    name: "Cyberpunk",
    colors: {
      "--bg-primary": "#0d0e15",
      "--bg-secondary": "#141622",
      "--bg-card": "#1a1d2e",
      "--bg-card-hover": "#262b45",
      "--border-color": "#2f3659",
      "--text-primary": "#e6e6f0",
      "--text-secondary": "#a0a5c0",
      "--text-muted": "#6a7090",
      "--accent-blue": "#00f0ff",
      "--accent-purple": "#ff007f",
      "--accent-orange": "#ffb800",
      "--accent-green": "#05ffa1",
      "--accent-red": "#ff2a5f"
    },
    swatches: ["#0d0e15", "#1a1d2e", "#00f0ff", "#ff007f"]
  },
  "clean-light": {
    name: "Clean Light",
    colors: {
      "--bg-primary": "#f8fafc",
      "--bg-secondary": "#f1f5f9",
      "--bg-card": "#ffffff",
      "--bg-card-hover": "#f1f5f9",
      "--border-color": "#cbd5e1",
      "--text-primary": "#0f172a",
      "--text-secondary": "#334155",
      "--text-muted": "#64748b",
      "--accent-blue": "#2563eb",
      "--accent-purple": "#7c3aed",
      "--accent-orange": "#ea580c",
      "--accent-green": "#16a34a",
      "--accent-red": "#dc2626"
    },
    swatches: ["#f8fafc", "#ffffff", "#2563eb", "#7c3aed"]
  }
};

const COLOR_PICKER_MAP = [
  { inputId: "color-bg-primary", hexId: "hex-bg-primary", varName: "--bg-primary" },
  { inputId: "color-bg-secondary", hexId: "hex-bg-secondary", varName: "--bg-secondary" },
  { inputId: "color-bg-card", hexId: "hex-bg-card", varName: "--bg-card" },
  { inputId: "color-border", hexId: "hex-border", varName: "--border-color" },
  { inputId: "color-text-primary", hexId: "hex-text-primary", varName: "--text-primary" },
  { inputId: "color-text-muted", hexId: "hex-text-muted", varName: "--text-muted" },
  { inputId: "color-accent-blue", hexId: "hex-accent-blue", varName: "--accent-blue" },
  { inputId: "color-accent-purple", hexId: "hex-accent-purple", varName: "--accent-purple" },
];

let userSettings = {
  themeId: "catppuccin",
  density: "standard",
  fontScale: 100,
  customColors: null,
  savedCustomThemes: {},
  showAppIndexLink: false,
  openAppIndexInSameTab: false,
  appIndexUrl: "http://localhost:8765",
  showGitHubBtn: true,
  checkForUpdates: true
};

let appUpdateData = null;
let cachedAppVersion = "v1.1.8";
let cachedGithubRepo = "PlasmaDrifter/podman-systemd-dashboard";

function loadSavedSettings() {
  let hasLocalSettings = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      hasLocalSettings = true;
      const parsed = JSON.parse(raw);
      userSettings = {
        themeId: parsed.themeId || "catppuccin",
        density: parsed.density || "standard",
        fontScale: typeof parsed.fontScale === "number" ? parsed.fontScale : 100,
        customColors: parsed.customColors || null,
        savedCustomThemes: parsed.savedCustomThemes || {},
        showAppIndexLink: Boolean(parsed.showAppIndexLink),
        openAppIndexInSameTab: Boolean(parsed.openAppIndexInSameTab),
        appIndexUrl: parsed.appIndexUrl || "http://localhost:8765",
        showGitHubBtn: parsed.showGitHubBtn !== undefined ? Boolean(parsed.showGitHubBtn) : true,
        checkForUpdates: parsed.checkForUpdates !== undefined ? Boolean(parsed.checkForUpdates) : true
      };
    }
  } catch (err) {
    console.warn("Could not load settings from localStorage:", err);
  }

  // Asynchronously sync with backend metadata/settings
  fetch("/api/settings")
    .then((r) => r.json())
    .then((data) => {
      if (data && data.status === "ok") {
        if (data.app_version) cachedAppVersion = data.app_version;
        if (data.github_repo) cachedGithubRepo = data.github_repo;
        const s = data.settings || {};

        let needsSaveToLocal = false;
        let needsSaveToBackend = false;

        // If backend explicitly has show_appindex_link = true, adopt it
        if (s.show_appindex_link === true && !userSettings.showAppIndexLink) {
          userSettings.showAppIndexLink = true;
          needsSaveToLocal = true;
        } else if (userSettings.showAppIndexLink && s.show_appindex_link !== true) {
          // If local explicitly has it enabled but backend does not, sync local setting to backend
          needsSaveToBackend = true;
        }

        if (s.open_appindex_same_tab === true && !userSettings.openAppIndexInSameTab) {
          userSettings.openAppIndexInSameTab = true;
          needsSaveToLocal = true;
        } else if (userSettings.openAppIndexInSameTab && s.open_appindex_same_tab !== true) {
          needsSaveToBackend = true;
        }

        if (s.appindex_url && s.appindex_url !== "http://localhost:8765" && userSettings.appIndexUrl === "http://localhost:8765") {
          userSettings.appIndexUrl = s.appindex_url;
          needsSaveToLocal = true;
        }

        if (s.show_github_btn !== undefined && !hasLocalSettings) {
          userSettings.showGitHubBtn = Boolean(s.show_github_btn);
          needsSaveToLocal = true;
        }

        if (s.check_for_updates !== undefined && !hasLocalSettings) {
          userSettings.checkForUpdates = Boolean(s.check_for_updates);
          needsSaveToLocal = true;
        }

        if (needsSaveToLocal) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
          } catch (e) {}
        }

        if (needsSaveToBackend) {
          saveSettingsToStorage();
        }

        if (data.update_info) {
          appUpdateData = data.update_info;
          renderUpdateUI(appUpdateData);
        }
        applyAllActiveSettings();
        syncSettingsUI();
      }
    })
    .catch(() => {});
}

function saveSettingsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
  } catch (err) {
    console.warn("Could not save settings to localStorage:", err);
  }

  // Persist companion and integration settings to backend metadata
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      show_github_btn: userSettings.showGitHubBtn,
      check_for_updates: userSettings.checkForUpdates,
      show_appindex_link: userSettings.showAppIndexLink,
      open_appindex_same_tab: userSettings.openAppIndexInSameTab,
      appindex_url: userSettings.appIndexUrl
    })
  }).catch((err) => {
    console.warn("Could not save settings to backend:", err);
  });
}

function applyAllActiveSettings() {
  // Apply Theme
  if (userSettings.themeId === "custom" && userSettings.customColors) {
    applyThemeColors(userSettings.customColors);
  } else if (PRESET_THEMES[userSettings.themeId]) {
    applyThemeColors(PRESET_THEMES[userSettings.themeId].colors);
  } else if (userSettings.savedCustomThemes && userSettings.savedCustomThemes[userSettings.themeId]) {
    applyThemeColors(userSettings.savedCustomThemes[userSettings.themeId]);
  } else {
    applyThemeColors(PRESET_THEMES["catppuccin"].colors);
  }

  // Apply Density
  applyDensity(userSettings.density);

  // Apply Font Scale
  applyFontScale(userSettings.fontScale);

  // Apply AppIndex Companion Nav Link
  applyAppIndexNav();

  // Apply GitHub Nav Button
  applyGitHubNav();
}

function applyThemeColors(colorsObj) {
  if (!colorsObj) return;
  const root = document.documentElement;
  const savedFontScale = root.style.getPropertyValue("--font-scale");
  root.removeAttribute("style");
  if (savedFontScale) {
    root.style.setProperty("--font-scale", savedFontScale);
  }

  for (const [key, val] of Object.entries(colorsObj)) {
    root.style.setProperty(key, val);
  }

  // Sync dashboard theme aliases
  if (colorsObj["--bg-primary"]) root.style.setProperty("--bg-base", colorsObj["--bg-primary"]);
  if (colorsObj["--bg-secondary"]) root.style.setProperty("--bg-surface", colorsObj["--bg-secondary"]);
  if (colorsObj["--text-primary"]) root.style.setProperty("--text-main", colorsObj["--text-primary"]);
  if (colorsObj["--accent-blue"]) {
    root.style.setProperty("--primary", colorsObj["--accent-blue"]);
    root.style.setProperty("--primary-hover", colorsObj["--accent-blue"]);
  }
  if (colorsObj["--accent-purple"]) {
    root.style.setProperty("--accent", colorsObj["--accent-purple"]);
    root.style.setProperty("--accent-hover", colorsObj["--accent-purple"]);
  }
  if (colorsObj["--accent-green"]) root.style.setProperty("--success", colorsObj["--accent-green"]);
  if (colorsObj["--accent-orange"]) root.style.setProperty("--warning", colorsObj["--accent-orange"]);
  if (colorsObj["--accent-red"]) root.style.setProperty("--danger", colorsObj["--accent-red"]);
}

function applyDensity(density) {
  if (!document.body) return;
  document.body.classList.remove("density-compact", "density-standard", "density-spacious");
  document.body.classList.add("density-" + (density || "standard"));
}

function applyFontScale(scaleVal) {
  const scale = (scaleVal || 100) / 100;
  document.documentElement.style.setProperty("--font-scale", scale.toString());
}

function applyAppIndexNav() {
  const link = document.getElementById("nav-appindex-link");
  if (!link) return;
  const show = Boolean(userSettings.showAppIndexLink);
  link.style.display = show ? "inline-flex" : "none";
  link.href = userSettings.appIndexUrl || "http://localhost:8765";

  const arrow = link.querySelector(".nav-external-arrow");
  if (userSettings.openAppIndexInSameTab) {
    link.target = "_self";
    link.removeAttribute("rel");
    if (arrow) arrow.style.display = "none";
  } else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (arrow) arrow.style.display = "";
  }
}

function applyGitHubNav() {
  const link = document.getElementById("nav-github-link");
  if (link) {
    link.style.display = userSettings.showGitHubBtn ? "inline-flex" : "none";
  }
}

function checkAppUpdatesAsync(force = false) {
  if (!userSettings.checkForUpdates) {
    clearUpdateIndicator();
    return;
  }

  const url = force ? "/api/check-update?force=1" : "/api/check-update";
  fetch(url, { method: force ? "POST" : "GET" })
    .then((r) => r.json())
    .then((data) => {
      if (data && data.update_info) {
        appUpdateData = data.update_info;
        renderUpdateUI(data.update_info);
      }
    })
    .catch((err) => {
      console.warn("Could not check for updates:", err);
    });
}

function parseVersionString(v) {
  if (!v) return [];
  const cleaned = String(v).trim().replace(/^[vV]/, '');
  return cleaned.split(/[-.+_]/).map((p) => parseInt(p, 10)).filter((n) => !isNaN(n));
}

function isNewerVersionString(latest, current) {
  const l = parseVersionString(latest);
  const c = parseVersionString(current);
  const len = Math.max(l.length, c.length);
  for (let i = 0; i < len; i++) {
    const lPart = l[i] || 0;
    const cPart = c[i] || 0;
    if (lPart > cPart) return true;
    if (lPart < cPart) return false;
  }
  return false;
}

function renderUpdateUI(info) {
  const ghLink = document.getElementById("nav-github-link");
  const navBadge = document.getElementById("nav-update-badge");
  const statusBadge = document.getElementById("update-status-badge");
  const banner = document.getElementById("settings-update-banner");
  const bannerVer = document.getElementById("update-banner-version");
  const bannerLink = document.getElementById("update-banner-link");
  const btnSettings = document.getElementById("btn-settings");

  const settingsVer = document.getElementById("settings-app-version");
  const curVer = (info && info.current_version) ? info.current_version : (cachedAppVersion || "v1.1.5");
  if (settingsVer) {
    settingsVer.textContent = curVer.startsWith("v") ? curVer : `v${curVer}`;
  }

  if (!userSettings.checkForUpdates) {
    clearUpdateIndicator();
    return;
  }

  const hasValidUpdate = Boolean(
    info &&
    info.has_update &&
    info.latest_version &&
    isNewerVersionString(info.latest_version, curVer)
  );

  if (hasValidUpdate) {
    const cleanVer = info.latest_version.startsWith("v") ? info.latest_version : `v${info.latest_version}`;
    const dismissedVer = localStorage.getItem("dashboard_dismissed_update_version");
    const isDismissed = (dismissedVer === info.latest_version);

    if (ghLink) {
      ghLink.classList.remove("has-update");
      ghLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/podman-systemd-dashboard'}`;
      ghLink.title = `GitHub Repository (${cachedAppVersion || 'v1.1.8'})`;
    }

    if (btnSettings) {
      btnSettings.title = isDismissed ? "Application Settings" : `Application Settings (Update ${info.latest_version} available)`;
    }

    if (!isDismissed) {
      if (navBadge) {
        navBadge.classList.remove("hidden");
        navBadge.style.display = "flex";
        navBadge.title = `Update available: ${info.latest_version}`;
      }
      if (statusBadge) {
        statusBadge.style.display = "inline-block";
        statusBadge.textContent = `${cleanVer} available`;
        if (info.release_url) {
          statusBadge.onclick = () => window.open(info.release_url, "_blank");
        }
      }
      if (banner) {
        banner.style.display = "flex";
        if (bannerVer) bannerVer.textContent = cleanVer;
        if (bannerLink && info.release_url) bannerLink.href = info.release_url;
        const bannerCodeLink = document.getElementById("update-banner-code-link");
        if (bannerCodeLink) {
          bannerCodeLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/podman-systemd-dashboard'}/tree/${cleanVer}`;
        }
      }
    } else {
      if (navBadge) {
        navBadge.classList.add("hidden");
        navBadge.style.display = "none";
      }
      if (statusBadge) statusBadge.style.display = "none";
      if (banner) banner.style.display = "none";
    }
  } else {
    clearUpdateIndicator();
  }
}

function clearUpdateIndicator() {
  const ghLink = document.getElementById("nav-github-link");
  const navBadge = document.getElementById("nav-update-badge");
  const statusBadge = document.getElementById("update-status-badge");
  const banner = document.getElementById("settings-update-banner");
  const btnSettings = document.getElementById("btn-settings");

  if (btnSettings) {
    btnSettings.title = "Application Settings";
  }
  if (ghLink) {
    ghLink.classList.remove("has-update");
    ghLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/podman-systemd-dashboard'}`;
    ghLink.title = `GitHub Repository (${cachedAppVersion || 'v1.1.8'})`;
  }
  if (navBadge) {
    navBadge.classList.add("hidden");
    navBadge.style.display = "none";
  }
  if (statusBadge) {
    statusBadge.style.display = "none";
  }
  if (banner) {
    banner.style.display = "none";
  }
}

async function executeSelfUpdate() {
  const versionStr = appUpdateData && appUpdateData.latest_version ? ` to ${appUpdateData.latest_version}` : "";
  const confirmed = window.confirm(`Update podman-systemd-dashboard${versionStr}? The server will automatically download changes and restart.`);
  if (!confirmed) return;

  const btnApply = document.getElementById("btn-apply-update");
  const btnDismiss = document.getElementById("btn-dismiss-update-banner");
  const origBtnContent = btnApply ? btnApply.innerHTML : "Update Now";

  if (btnApply) {
    btnApply.disabled = true;
    btnApply.innerHTML = `<svg class="spin-loop" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: -2px;"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>Updating...`;
    btnApply.style.color = "var(--accent-orange, #f5a97f)";
    btnApply.style.borderColor = "var(--accent-orange, #f5a97f)";
    btnApply.style.cursor = "wait";
  }
  if (btnDismiss) {
    btnDismiss.style.display = "none";
  }

  const progressModal = document.getElementById("update-progress-modal");
  const progressTitle = document.getElementById("update-progress-title");
  const progressDesc = document.getElementById("update-progress-desc");

  if (progressModal) {
    progressModal.style.display = "flex";
  }

  try {
    const res = await fetch("/api/apply-update", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server returned error ${res.status}`);
    }

    if (progressTitle) progressTitle.textContent = "Restarting Server...";
    if (progressDesc) progressDesc.textContent = "Application updated. Waiting for server to come back online...";

    await new Promise((r) => setTimeout(r, 2000));

    let reconnected = false;
    for (let i = 0; i < 40; i++) {
      try {
        const ping = await fetch("/api/status", { cache: "no-store" });
        if (ping.ok) {
          reconnected = true;
          break;
        }
      } catch (_) {
        // Still rebooting
      }
      await new Promise((r) => setTimeout(r, 750));
    }

    if (reconnected) {
      if (progressTitle) progressTitle.textContent = "Reloading...";
      if (progressDesc) progressDesc.textContent = "Update complete! Refreshing page...";
      localStorage.removeItem("dashboard_dismissed_update_version");
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } else {
      if (progressDesc) {
        progressDesc.textContent = "Server took too long to respond. Please refresh manually or check your terminal.";
      }
      setTimeout(() => {
        if (progressModal) progressModal.style.display = "none";
        if (btnApply) {
          btnApply.disabled = false;
          btnApply.innerHTML = origBtnContent;
          btnApply.style.cursor = "pointer";
        }
        if (btnDismiss) {
          btnDismiss.style.display = "";
        }
      }, 5000);
    }
  } catch (err) {
    if (progressModal) progressModal.style.display = "none";
    if (btnApply) {
      btnApply.disabled = false;
      btnApply.innerHTML = origBtnContent;
      btnApply.style.cursor = "pointer";
    }
    if (btnDismiss) {
      btnDismiss.style.display = "";
    }
    alert(`Update failed: ${err.message}`);
  }
}

function initSettingsUI() {
  renderPresetThemeGrid();
  renderSavedCustomThemes();
  syncSettingsUI();
  bindSettingsInteractiveEvents();
}

function syncSettingsUI() {
  // Sync Density Buttons
  const selector = document.getElementById("density-selector");
  if (selector) {
    selector.querySelectorAll(".density-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.density === userSettings.density);
    });
  }

  // Sync Font Scale
  const slider = document.getElementById("font-scale-slider");
  const valBadge = document.getElementById("font-scale-value");
  if (slider) slider.value = userSettings.fontScale;
  if (valBadge) valBadge.textContent = userSettings.fontScale + "%";

  // Sync Color Pickers
  let currentColors = {};
  if (userSettings.themeId === "custom" && userSettings.customColors) {
    currentColors = userSettings.customColors;
  } else if (PRESET_THEMES[userSettings.themeId]) {
    currentColors = PRESET_THEMES[userSettings.themeId].colors;
  } else if (userSettings.savedCustomThemes && userSettings.savedCustomThemes[userSettings.themeId]) {
    currentColors = userSettings.savedCustomThemes[userSettings.themeId];
  } else {
    currentColors = PRESET_THEMES["catppuccin"].colors;
  }
  updateColorPickersUI(currentColors);

  // Highlight Active Theme Card
  const presetsGrid = document.getElementById("theme-presets-grid");
  if (presetsGrid) {
    presetsGrid.querySelectorAll(".theme-preset-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.themeId === userSettings.themeId);
    });
  }

  // Sync Companion Tools (AppIndex)
  const toggleAppIndex = document.getElementById("toggle-appindex-link");
  const toggleSameTab = document.getElementById("toggle-appindex-same-tab");
  const sameTabWrapper = document.getElementById("companion-same-tab-wrapper");
  const appIndexUrlConfig = document.getElementById("appindex-url-config");
  const appIndexUrlInput = document.getElementById("appindex-url-input");
  const toggleGitHub = document.getElementById("toggle-github-btn");
  const toggleUpdates = document.getElementById("toggle-check-updates");

  if (toggleGitHub) {
    toggleGitHub.checked = Boolean(userSettings.showGitHubBtn);
  }
  if (toggleUpdates) {
    toggleUpdates.checked = Boolean(userSettings.checkForUpdates);
  }

  const statusBadge = document.getElementById("update-status-badge");
  const banner = document.getElementById("settings-update-banner");
  const bannerVer = document.getElementById("update-banner-version");
  const bannerLink = document.getElementById("update-banner-link");

  const curVer = (appUpdateData && appUpdateData.current_version) ? appUpdateData.current_version : (cachedAppVersion || "v1.1.5");
  const hasValidUpdate = Boolean(
    userSettings.checkForUpdates &&
    appUpdateData &&
    appUpdateData.has_update &&
    appUpdateData.latest_version &&
    isNewerVersionString(appUpdateData.latest_version, curVer)
  );

  if (hasValidUpdate) {
    const cleanVer = appUpdateData.latest_version.startsWith("v") ? appUpdateData.latest_version : `v${appUpdateData.latest_version}`;
    const dismissedVer = localStorage.getItem("dashboard_dismissed_update_version");
    const isDismissed = (dismissedVer === appUpdateData.latest_version);

    if (!isDismissed) {
      if (statusBadge) {
        statusBadge.style.display = "inline-block";
        statusBadge.textContent = `${cleanVer} available`;
      }
      if (banner) {
        banner.style.display = "flex";
        if (bannerVer) bannerVer.textContent = cleanVer;
        if (bannerLink && appUpdateData.release_url) bannerLink.href = appUpdateData.release_url;
      }
    } else {
      if (statusBadge) statusBadge.style.display = "none";
      if (banner) banner.style.display = "none";
    }
  } else {
    if (statusBadge) statusBadge.style.display = "none";
    if (banner) banner.style.display = "none";
  }

  if (toggleAppIndex) {
    toggleAppIndex.checked = Boolean(userSettings.showAppIndexLink);
  }
  if (toggleSameTab) {
    toggleSameTab.checked = Boolean(userSettings.openAppIndexInSameTab);
  }
  if (sameTabWrapper) {
    if (userSettings.showAppIndexLink) {
      sameTabWrapper.classList.remove("toggle-disabled");
      if (toggleSameTab) toggleSameTab.disabled = false;
    } else {
      sameTabWrapper.classList.add("toggle-disabled");
      if (toggleSameTab) toggleSameTab.disabled = true;
    }
  }
  if (appIndexUrlConfig) {
    appIndexUrlConfig.style.display = userSettings.showAppIndexLink ? "flex" : "none";
  }
  if (appIndexUrlInput) {
    appIndexUrlInput.value = userSettings.appIndexUrl || "http://localhost:8765";
  }
}

function renderPresetThemeGrid() {
  const presetsGrid = document.getElementById("theme-presets-grid");
  if (!presetsGrid) return;
  presetsGrid.innerHTML = "";

  Object.entries(PRESET_THEMES).forEach(([themeId, theme]) => {
    const card = document.createElement("div");
    card.className = "theme-preset-card" + (userSettings.themeId === themeId ? " active" : "");
    card.dataset.themeId = themeId;

    const swatchesHtml = theme.swatches
      .map((hex) => `<span class="theme-swatch-circle" style="background-color: ${hex};"></span>`)
      .join("");

    card.innerHTML = `
      <div class="theme-swatches">${swatchesHtml}</div>
      <span class="theme-name" title="${theme.name}">${theme.name}</span>
    `;

    card.addEventListener("click", () => {
      userSettings.themeId = themeId;
      userSettings.customColors = null;
      applyThemeColors(theme.colors);
      updateColorPickersUI(theme.colors);
      saveSettingsToStorage();
      syncSettingsUI();
      showToast(`Applied ${theme.name}`);
    });

    presetsGrid.appendChild(card);
  });
}

function updateColorPickersUI(colorsObj) {
  COLOR_PICKER_MAP.forEach(({ inputId, hexId, varName }) => {
    const input = document.getElementById(inputId);
    const hexSpan = document.getElementById(hexId);
    if (!input) return;

    let hexVal = colorsObj[varName];
    if (!hexVal) {
      hexVal = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    }
    hexVal = normalizeHex(hexVal);

    input.value = hexVal;
    if (hexSpan) hexSpan.textContent = hexVal.toUpperCase();
  });
}

function normalizeHex(colorStr) {
  if (!colorStr) return "#000000";
  colorStr = colorStr.trim();
  if (colorStr.startsWith("#") && (colorStr.length === 7 || colorStr.length === 4)) {
    if (colorStr.length === 4) {
      return "#" + colorStr[1] + colorStr[1] + colorStr[2] + colorStr[2] + colorStr[3] + colorStr[3];
    }
    return colorStr;
  }
  const match = colorStr.match(/\d+/g);
  if (match && match.length >= 3) {
    const r = parseInt(match[0], 10).toString(16).padStart(2, "0");
    const g = parseInt(match[1], 10).toString(16).padStart(2, "0");
    const b = parseInt(match[2], 10).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }
  return "#000000";
}

function renderSavedCustomThemes() {
  const customSection = document.getElementById("saved-custom-themes-section");
  const list = document.getElementById("saved-themes-list");
  if (!list || !customSection) return;
  const names = Object.keys(userSettings.savedCustomThemes || {});

  if (names.length === 0) {
    customSection.style.display = "none";
    list.innerHTML = "";
    return;
  }

  customSection.style.display = "block";
  list.innerHTML = "";

  names.forEach((name) => {
    const chip = document.createElement("div");
    chip.className = "saved-theme-chip" + (userSettings.themeId === name ? " active" : "");

    chip.innerHTML = `
      <button type="button" class="saved-theme-apply-btn">${escapeHtml(name)}</button>
      <button type="button" class="saved-theme-del-btn" title="Delete theme">&times;</button>
    `;

    chip.querySelector(".saved-theme-apply-btn").addEventListener("click", () => {
      userSettings.themeId = name;
      userSettings.customColors = null;
      const themeColors = userSettings.savedCustomThemes[name];
      applyThemeColors(themeColors);
      updateColorPickersUI(themeColors);
      saveSettingsToStorage();
      syncSettingsUI();
      renderSavedCustomThemes();
      showToast(`Applied custom theme: ${name}`);
    });

    chip.querySelector(".saved-theme-del-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      delete userSettings.savedCustomThemes[name];
      if (userSettings.themeId === name) {
        userSettings.themeId = "catppuccin";
        applyThemeColors(PRESET_THEMES["catppuccin"].colors);
      }
      saveSettingsToStorage();
      syncSettingsUI();
      renderSavedCustomThemes();
      showToast(`Deleted theme: ${name}`);
    });

    list.appendChild(chip);
  });
}

function bindSettingsInteractiveEvents() {
  // Density selector buttons
  const selector = document.getElementById("density-selector");
  if (selector) {
    selector.querySelectorAll(".density-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const density = btn.dataset.density;
        userSettings.density = density;
        applyDensity(density);
        saveSettingsToStorage();
        syncSettingsUI();
      });
    });
  }

  // Font scale slider
  const slider = document.getElementById("font-scale-slider");
  const valBadge = document.getElementById("font-scale-value");
  if (slider) {
    slider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      userSettings.fontScale = val;
      applyFontScale(val);
      if (valBadge) valBadge.textContent = val + "%";
      saveSettingsToStorage();
    });
  }

  // Quick tick buttons
  document.querySelectorAll(".tick-btn").forEach((tick) => {
    tick.addEventListener("click", () => {
      const val = parseInt(tick.dataset.val, 10);
      userSettings.fontScale = val;
      applyFontScale(val);
      if (slider) slider.value = val;
      if (valBadge) valBadge.textContent = val + "%";
      saveSettingsToStorage();
    });
  });

  // Color pickers input
  COLOR_PICKER_MAP.forEach(({ inputId, hexId, varName }) => {
    const input = document.getElementById(inputId);
    const hexSpan = document.getElementById(hexId);
    if (!input) return;

    input.addEventListener("input", (e) => {
      const val = e.target.value;
      if (hexSpan) hexSpan.textContent = val.toUpperCase();
      document.documentElement.style.setProperty(varName, val);

      if (!userSettings.customColors) {
        userSettings.customColors = {};
      }
      userSettings.customColors[varName] = val;
      userSettings.themeId = "custom";

      if (varName === "--bg-card") {
        document.documentElement.style.setProperty("--bg-card-hover", val);
      }

      // Sync legacy aliases
      if (varName === "--bg-primary") document.documentElement.style.setProperty("--bg-base", val);
      if (varName === "--bg-secondary") document.documentElement.style.setProperty("--bg-surface", val);
      if (varName === "--text-primary") document.documentElement.style.setProperty("--text-main", val);
      if (varName === "--accent-blue") document.documentElement.style.setProperty("--primary", val);
      if (varName === "--accent-purple") document.documentElement.style.setProperty("--accent", val);

      saveSettingsToStorage();
      const presetsGrid = document.getElementById("theme-presets-grid");
      if (presetsGrid) {
        presetsGrid.querySelectorAll(".theme-preset-card").forEach((c) => c.classList.remove("active"));
      }
    });
  });

  // Save custom theme button
  const btnSaveTheme = document.getElementById("btn-save-custom-theme");
  const nameInput = document.getElementById("custom-theme-name");
  if (btnSaveTheme && nameInput) {
    btnSaveTheme.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        showToast("Please enter a name for the custom theme", "error");
        nameInput.focus();
        return;
      }

      const colors = {};
      COLOR_PICKER_MAP.forEach(({ inputId, varName }) => {
        const input = document.getElementById(inputId);
        if (input) colors[varName] = input.value;
      });

      colors["--bg-card-hover"] = colors["--bg-card"];

      userSettings.savedCustomThemes[name] = colors;
      userSettings.themeId = name;
      userSettings.customColors = null;
      nameInput.value = "";

      saveSettingsToStorage();
      syncSettingsUI();
      renderSavedCustomThemes();
      showToast(`Custom theme "${name}" saved!`);
    });
  }

  // Reset to default button
  const btnReset = document.getElementById("btn-reset-theme");
  if (btnReset) {
    btnReset.addEventListener("click", () => {
      userSettings.themeId = "catppuccin";
      userSettings.density = "standard";
      userSettings.fontScale = 100;
      userSettings.customColors = null;
      userSettings.showGitHubBtn = true;
      userSettings.checkForUpdates = true;
      userSettings.showAppIndexLink = false;
      userSettings.openAppIndexInSameTab = false;
      userSettings.appIndexUrl = "http://localhost:8765";

      localStorage.removeItem("dashboard_dismissed_update_version");
      applyAllActiveSettings();
      syncSettingsUI();
      saveSettingsToStorage();
      if (userSettings.checkForUpdates) {
        checkAppUpdatesAsync();
      }
      showToast("Reset all settings to default");
    });
  }

  // Settings Update Banner Dismiss / Clear button
  const btnDismissBanner = document.getElementById("btn-dismiss-update-banner");
  if (btnDismissBanner) {
    btnDismissBanner.addEventListener("click", () => {
      // 1. Hide the banner in settings
      const banner = document.getElementById("settings-update-banner");
      if (banner) banner.style.display = "none";

      // 2. Clear both notifications: banner AND Settings navigation badge
      const navBadge = document.getElementById("nav-update-badge");
      if (navBadge) {
        navBadge.classList.add("hidden");
        navBadge.style.display = "none";
      }
      const btnSettings = document.getElementById("btn-settings");
      if (btnSettings) {
        btnSettings.title = "Application Settings";
      }
      const ghLink = document.getElementById("nav-github-link");
      if (ghLink) {
        ghLink.classList.remove("has-update");
      }
      const statusBadge = document.getElementById("update-status-badge");
      if (statusBadge) {
        statusBadge.style.display = "none";
      }

      // 3. Persist dismissed state for this release version
      if (appUpdateData && appUpdateData.latest_version) {
        localStorage.setItem("dashboard_dismissed_update_version", appUpdateData.latest_version);
      }
      showToast("Update notifications cleared");
    });
  }

  // Settings Update Banner Apply (Self-Update)
  const btnApplyUpdate = document.getElementById("btn-apply-update");
  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener("click", () => {
      executeSelfUpdate();
    });
  }

  // Navigation Links & Updates
  const toggleGitHub = document.getElementById("toggle-github-btn");
  const toggleUpdates = document.getElementById("toggle-check-updates");

  if (toggleGitHub) {
    toggleGitHub.addEventListener("change", (e) => {
      userSettings.showGitHubBtn = e.target.checked;
      applyGitHubNav();
      saveSettingsToStorage();
    });
  }

  if (toggleUpdates) {
    toggleUpdates.addEventListener("change", (e) => {
      userSettings.checkForUpdates = e.target.checked;
      saveSettingsToStorage();
      if (e.target.checked) {
        checkAppUpdatesAsync(true);
      } else {
        clearUpdateIndicator();
      }
    });
  }

  // Companion Tools (AppIndex)
  const toggleAppIndex = document.getElementById("toggle-appindex-link");
  const toggleSameTab = document.getElementById("toggle-appindex-same-tab");
  const sameTabWrapper = document.getElementById("companion-same-tab-wrapper");
  const appIndexUrlConfig = document.getElementById("appindex-url-config");
  const appIndexUrlInput = document.getElementById("appindex-url-input");
  const btnResetUrl = document.getElementById("btn-reset-appindex-url");

  if (toggleAppIndex) {
    toggleAppIndex.addEventListener("change", (e) => {
      userSettings.showAppIndexLink = e.target.checked;
      if (appIndexUrlConfig) {
        appIndexUrlConfig.style.display = e.target.checked ? "flex" : "none";
      }
      if (sameTabWrapper) {
        if (e.target.checked) {
          sameTabWrapper.classList.remove("toggle-disabled");
          if (toggleSameTab) toggleSameTab.disabled = false;
        } else {
          sameTabWrapper.classList.add("toggle-disabled");
          if (toggleSameTab) toggleSameTab.disabled = true;
        }
      }
      applyAppIndexNav();
      saveSettingsToStorage();
    });
  }

  if (toggleSameTab) {
    toggleSameTab.addEventListener("change", (e) => {
      userSettings.openAppIndexInSameTab = e.target.checked;
      applyAppIndexNav();
      saveSettingsToStorage();
    });
  }

  if (appIndexUrlInput) {
    const handleUrlChange = () => {
      let val = appIndexUrlInput.value.trim();
      if (!val) {
        val = "http://localhost:8765";
        appIndexUrlInput.value = val;
      }
      userSettings.appIndexUrl = val;
      applyAppIndexNav();
      saveSettingsToStorage();
    };
    appIndexUrlInput.addEventListener("change", handleUrlChange);
    appIndexUrlInput.addEventListener("blur", handleUrlChange);
  }

  if (btnResetUrl && appIndexUrlInput) {
    btnResetUrl.addEventListener("click", () => {
      appIndexUrlInput.value = "http://localhost:8765";
      userSettings.appIndexUrl = "http://localhost:8765";
      applyAppIndexNav();
      saveSettingsToStorage();
      showToast("Reset AppIndex URL to default");
    });
  }

  // Help Popovers Setup
  const setupPopover = (btnId, popoverId) => {
    const btn = document.getElementById(btnId);
    const popover = document.getElementById(popoverId);
    if (!btn || !popover) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = popover.style.display === "block";

      document.querySelectorAll(".help-popover").forEach((p) => (p.style.display = "none"));
      document.querySelectorAll(".help-circle-btn").forEach((b) => b.classList.remove("active"));

      popover.style.display = isVisible ? "none" : "block";
      btn.classList.toggle("active", !isVisible);
    });
  };

  setupPopover("appindex-help-btn", "appindex-help-popover");
  setupPopover("github-help-btn", "github-help-popover");

  document.addEventListener("click", (e) => {
    document.querySelectorAll(".help-popover").forEach((popover) => {
      if (!popover.contains(e.target)) {
        popover.style.display = "none";
      }
    });
    document.querySelectorAll(".help-circle-btn").forEach((btn) => {
      if (!btn.contains(e.target)) {
        btn.classList.remove("active");
      }
    });
  });
}

function openSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    document.querySelectorAll(".help-popover").forEach((p) => (p.style.display = "none"));
    document.querySelectorAll(".help-circle-btn").forEach((b) => b.classList.remove("active"));

    syncSettingsUI();
    modal.classList.add("open");
    modal.style.display = "flex";
  }
}

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    document.querySelectorAll(".help-popover").forEach((p) => (p.style.display = "none"));
    document.querySelectorAll(".help-circle-btn").forEach((b) => b.classList.remove("active"));

    saveSettingsToStorage();
    applyAllActiveSettings();

    modal.classList.remove("open");
    modal.style.display = "none";
  }
}


