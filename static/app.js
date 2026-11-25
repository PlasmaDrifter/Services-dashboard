let allServices = [];
let allContainers = [];
let currentActiveView = 'services'; // 'services' or 'system'
let systemTasksData = null;
let currentSysCategoryFilter = 'all'; // 'all', 'timers', 'cron', 'watchers', 'failed'
let currentFilter = 'all'; // 'all', 'running', 'inactive'
let currentCategoryFilter = 'all'; // 'all', 'web', 'containers', 'timers'
let currentSearch = '';
let currentEditingUnit = null;
let currentLogsUnit = null;
let currentLogsScope = 'user';
let currentLastScanText = 'Last scan: --:--:--';
let lastDataLoadTime = 0;
let activatingPollTimer = null;
let toastTimer = null;
let editorCloseTimer = null;
let loadDataAbortController = null;
let editorFetchController = null;
let logsFetchController = null;

const CATEGORY_ORDER = [
  "Web Apps & Dashboards",
  "Containers",
  "Podman Containers",
  "Scheduled Tasks & Timers",
  "Local Utilities & Daemons"
];

const TRANSIENT_ACTIVE_STATES = new Set(["activating", "deactivating", "reloading"]);
const TRANSIENT_SUB_STATES = new Set(["start-pre", "start-post", "auto-restart", "stop-sigterm", "stop-post"]);
const TRANSIENT_CONTAINER_STATES = new Set(["restarting", "created", "removing"]);

document.addEventListener('DOMContentLoaded', () => {
  loadSavedSettings();
  applyAllActiveSettings();
  initEventListeners();
  initSettingsUI();
  loadData();
});

function setActiveStatusFilterButton(filterVal) {
  document.querySelectorAll('.filter-tabs .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filterVal);
  });
}

function updateStatCardActiveState() {
  document.querySelectorAll('#services-stats-group .stat-card').forEach(card => {
    const cat = card.dataset.category;
    let isActive = false;

    if (currentCategoryFilter === 'all') {
      if (currentFilter === 'running' && cat === 'running') {
        isActive = true;
      } else if (currentFilter === 'all' && cat === 'all') {
        isActive = true;
      }
    } else if (cat === currentCategoryFilter) {
      isActive = true;
    }

    card.classList.toggle('active', isActive);
    card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function handleStatCardSelection(card) {
  const cat = card.dataset.category;
  const isCurrentlyActive = card.classList.contains('active');

  if (isCurrentlyActive && cat !== 'all') {
    currentCategoryFilter = 'all';
    currentFilter = 'all';
    setActiveStatusFilterButton('all');
  } else if (cat === 'all') {
    currentCategoryFilter = 'all';
    currentFilter = 'all';
    setActiveStatusFilterButton('all');
  } else if (cat === 'running') {
    currentFilter = 'running';
    currentCategoryFilter = 'all';
    setActiveStatusFilterButton('running');
  } else {
    currentCategoryFilter = cat;
  }

  updateStatCardActiveState();
  renderContent();
}

function updateSystemStatCardActiveState() {
  document.querySelectorAll('#system-stats-group .stat-card').forEach(card => {
    const cat = card.dataset.sysCategory;
    const isActive = cat === currentSysCategoryFilter;
    card.classList.toggle('active', isActive);
    card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function handleSystemStatCardSelection(card) {
  const cat = card.dataset.sysCategory;
  if (currentSysCategoryFilter === cat && cat !== 'all') {
    currentSysCategoryFilter = 'all';
  } else {
    currentSysCategoryFilter = cat;
  }
  updateSystemStatCardActiveState();
  renderContent();
}

function switchView(viewName) {
  currentActiveView = viewName;
  const servicesBtn = document.getElementById('view-tab-services');
  const systemBtn = document.getElementById('view-tab-system');
  const servicesStats = document.getElementById('services-stats-group');
  const systemStats = document.getElementById('system-stats-group');

  if (viewName === 'services') {
    if (servicesBtn) servicesBtn.classList.add('active');
    if (systemBtn) systemBtn.classList.remove('active');
    if (servicesStats) servicesStats.style.display = 'flex';
    if (systemStats) systemStats.style.display = 'none';
  } else {
    if (systemBtn) systemBtn.classList.add('active');
    if (servicesBtn) servicesBtn.classList.remove('active');
    if (servicesStats) servicesStats.style.display = 'none';
    if (systemStats) systemStats.style.display = 'flex';
  }
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
  document.querySelectorAll('.filter-tabs .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      setActiveStatusFilterButton(currentFilter);
      updateStatCardActiveState();
      renderContent();
    });
  });

  // Delegated actions inside #categories-container (prevents inline onclick XSS / escaping issues)
  const categoriesContainer = document.getElementById('categories-container');
  if (categoriesContainer) {
    categoriesContainer.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-ui-action]');
      if (!actionBtn) return;

      const uiAction = actionBtn.dataset.uiAction;
      if (uiAction === 'service-action') {
        performAction(actionBtn.dataset.unit, actionBtn.dataset.action);
      } else if (uiAction === 'open-logs') {
        openLogsModal(actionBtn.dataset.unit, actionBtn.dataset.scope || 'user');
      } else if (uiAction === 'open-editor') {
        openEditorModal(actionBtn.dataset.unit);
      } else if (uiAction === 'open-inspect') {
        openInspectModal(actionBtn.dataset.unit, actionBtn.dataset.scope || 'system');
      } else if (uiAction === 'copy-cmd') {
        copyEditCommand(actionBtn.dataset.copy);
      } else if (uiAction === 'clear-service-category') {
        currentCategoryFilter = 'all';
        updateStatCardActiveState();
        renderContent();
      } else if (uiAction === 'clear-system-category') {
        currentSysCategoryFilter = 'all';
        updateSystemStatCardActiveState();
        renderContent();
      }
    });
  }

  // View Switcher (Services vs System Tasks)
  const servicesViewBtn = document.getElementById('view-tab-services');
  const systemViewBtn = document.getElementById('view-tab-system');
  if (servicesViewBtn && systemViewBtn) {
    servicesViewBtn.addEventListener('click', () => switchView('services'));
    systemViewBtn.addEventListener('click', () => switchView('system'));
  }

  // Stat cards filter click & keyboard accessibility (Services View)
  document.querySelectorAll('#services-stats-group .stat-card').forEach(card => {
    card.addEventListener('click', () => handleStatCardSelection(card));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleStatCardSelection(card);
      }
    });
  });

  // Stat cards filter click & keyboard accessibility (System Tasks View)
  document.querySelectorAll('#system-stats-group .stat-card').forEach(card => {
    card.addEventListener('click', () => handleSystemStatCardSelection(card));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSystemStatCardSelection(card);
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

  // Close modals on Escape key or backdrop click
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEditorModal();
      closeLogsModal();
      closeSettingsModal();
    }
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    if (overlay.id === 'update-progress-modal') return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.id === 'editor-modal') closeEditorModal();
        else if (overlay.id === 'logs-modal') closeLogsModal();
        else if (overlay.id === 'settings-modal') closeSettingsModal();
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

  // Refresh when returning to tab if stale (>10s)
  const refreshIfStale = () => {
    if (Date.now() - lastDataLoadTime > 10000) {
      loadData();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshIfStale();
    }
  });
  window.addEventListener('focus', refreshIfStale);
}

async function loadData(options = { servicesOnly: false }) {
  lastDataLoadTime = Date.now();
  if (loadDataAbortController) {
    loadDataAbortController.abort();
  }
  loadDataAbortController = new AbortController();
  const { signal } = loadDataAbortController;

  try {
    if (options.servicesOnly) {
      const resServices = await fetch('/api/services', { signal });
      if (!resServices.ok) {
        throw new Error(`HTTP ${resServices.status} fetching services`);
      }
      const data = await resServices.json();
      applyData(data);
      return;
    }

    const [resServices, resSystem] = await Promise.all([
      fetch('/api/services', { signal }),
      fetch('/api/system-tasks', { signal })
    ]);

    if (!resServices.ok) {
      throw new Error(`HTTP ${resServices.status} fetching services`);
    }
    const data = await resServices.json();
    applyData(data);

    if (resSystem.ok) {
      const sysData = await resSystem.json();
      applySystemData(sysData);
    } else {
      console.warn(`System tasks request failed with HTTP ${resSystem.status}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
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
    const [resScan, resSysScan] = await Promise.all([
      fetch('/api/scan', { method: 'POST' }),
      fetch('/api/system-tasks/scan', { method: 'POST' })
    ]);

    if (!resScan.ok || !resSysScan.ok) {
      const failedRes = !resScan.ok ? resScan : resSysScan;
      const errBody = await failedRes.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server returned HTTP ${failedRes.status}`);
    }

    const [result, sysResult] = await Promise.all([resScan.json(), resSysScan.json()]);
    lastDataLoadTime = Date.now();
    applyData(result.data);
    applySystemData(sysResult.data);
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

function applySystemData(data) {
  if (!data) return;
  systemTasksData = data;
  const stats = data.stats || {};

  const totalSys = (stats.total_system_timers || 0) + (stats.total_cron_jobs || 0) + (stats.total_watchers || 0);
  const badgeCount = document.getElementById('view-tab-system-count');
  if (badgeCount) {
    const failedCount = stats.failed_units_count || 0;
    if (failedCount > 0) {
      badgeCount.style.display = 'inline-flex';
      badgeCount.textContent = String(failedCount);
      badgeCount.classList.add('badge-failed');
      badgeCount.title = `${failedCount} failed unit(s) detected`;
    } else if (totalSys > 0) {
      badgeCount.style.display = 'inline-flex';
      badgeCount.textContent = String(totalSys);
      badgeCount.classList.remove('badge-failed');
      badgeCount.title = `${totalSys} system task(s)`;
    } else {
      badgeCount.style.display = 'none';
      badgeCount.classList.remove('badge-failed');
      badgeCount.title = '';
    }
  }

  const statTotal = document.getElementById('stat-sys-total');
  if (statTotal) statTotal.textContent = totalSys;

  const statTimers = document.getElementById('stat-sys-timers');
  if (statTimers) statTimers.textContent = stats.total_system_timers || 0;

  const statCron = document.getElementById('stat-sys-cron');
  if (statCron) statCron.textContent = stats.total_cron_jobs || 0;

  const statWatchers = document.getElementById('stat-sys-watchers');
  if (statWatchers) statWatchers.textContent = stats.total_watchers || 0;

  const statFailed = document.getElementById('stat-sys-failed');
  if (statFailed) {
    const failedCount = stats.failed_units_count || 0;
    statFailed.textContent = failedCount;
    statFailed.className = failedCount > 0 ? 'stat-value text-danger' : 'stat-value text-success';
  }

  if (currentActiveView === 'system') {
    renderContent();
  }
}

function applyData(data) {
  allServices = data.services || [];
  allContainers = data.containers || [];

  const webCount = allServices.filter(s => s.category === "Web Apps & Dashboards").length;
  const runningServicesCount = allServices.filter(s => s.active_state === 'active').length;

  document.getElementById('stat-total-services').textContent = allServices.length;
  document.getElementById('stat-running-services').textContent = runningServicesCount;
  document.getElementById('stat-web').textContent = webCount;
  const containerCount = (data.stats && typeof data.stats.total_containers === 'number')
    ? data.stats.total_containers
    : allContainers.length;
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

  if (currentActiveView === 'services') {
    renderContent();
    const scanEl = document.getElementById('last-scan-time');
    if (scanEl) {
      scanEl.textContent = currentLastScanText;
    }
  }

  // If any service or container is in a transient state, poll only /api/services in 2.5s
  const hasTransient =
    allServices.some(s => TRANSIENT_ACTIVE_STATES.has(s.active_state) || TRANSIENT_SUB_STATES.has(s.sub_state)) ||
    allContainers.some(c => TRANSIENT_CONTAINER_STATES.has((c.state || '').toLowerCase()));

  if (hasTransient) {
    if (!activatingPollTimer) {
      activatingPollTimer = setTimeout(() => {
        activatingPollTimer = null;
        loadData({ servicesOnly: true });
      }, 2500);
    }
  } else if (activatingPollTimer) {
    clearTimeout(activatingPollTimer);
    activatingPollTimer = null;
  }
}

function getUnifiedItems() {
  const combined = [];
  const containerMap = new Map();
  allContainers.forEach(c => {
    containerMap.set(c.name.toLowerCase(), c);
  });

  const matchedContainerNames = new Set();

  // Process services (including Quadlets)
  allServices.forEach(s => {
    const cleanName = s.name.replace(/\.service$/, '').replace(/^container-/, '');
    const matchedContainer = containerMap.get(cleanName.toLowerCase());

    if (matchedContainer) {
      matchedContainerNames.add(matchedContainer.name.toLowerCase());
    }

    let description = s.description;
    const engine = s.type === 'quadlet' ? 'podman' : (matchedContainer ? matchedContainer.engine : null);
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

  // Add standalone containers not already represented by a systemd quadlet or service
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
      const matchTimer = item.timer
        ? (item.timer.name.toLowerCase().includes(currentSearch) ||
           (item.timer.schedule && item.timer.schedule.toLowerCase().includes(currentSearch)))
        : false;
      return matchName || matchFile || matchDesc || matchPort || matchEngine || matchTimer;
    });
  }

  return filtered;
}

function renderContent() {
  const container = document.getElementById('categories-container');
  if (!container) return;
  container.replaceChildren();

  if (currentActiveView === 'system') {
    renderSystemView();
    return;
  }

  updateStatCardActiveState();

  const items = getUnifiedItems();

  if (items.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.append('No matching user services or timers found.');
    if (currentCategoryFilter !== 'all') {
      emptyDiv.appendChild(document.createElement('br'));
      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn btn-secondary btn-sm';
      resetBtn.style.marginTop = '10px';
      resetBtn.dataset.uiAction = 'clear-service-category';
      resetBtn.textContent = 'Show All Categories';
      emptyDiv.appendChild(resetBtn);
    }
    container.appendChild(emptyDiv);
    return;
  }

  // Group by Category (preserve CATEGORY_ORDER first, then any custom categories)
  const grouped = new Map();
  CATEGORY_ORDER.forEach(cat => grouped.set(cat, []));

  items.forEach(item => {
    const cat = item.category || "Local Utilities & Daemons";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(item);
  });

  const fragment = document.createDocumentFragment();
  let isFirstCategory = true;

  for (const [categoryName, categoryItems] of grouped.entries()) {
    if (categoryItems.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'category-section';

    const isFilteredCategory = (currentCategoryFilter !== 'all');
    if (isFilteredCategory) {
      section.classList.add('is-filtered');
    }

    let filterPillHtml = '';
    if (isFilteredCategory) {
      filterPillHtml = `
        <button type="button" class="category-filter-pill" data-ui-action="clear-service-category" title="Clear category filter and show all">
          <span>Filtered</span>
          <span class="pill-close">&times;</span>
        </button>
      `;
    }

    const header = document.createElement('div');
    header.className = 'category-header';

    let lastScanHtml = '';
    if (isFirstCategory) {
      lastScanHtml = `<span class="last-scan-label" id="last-scan-time">${escapeHtml(currentLastScanText)}</span>`;
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

    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'table-container';
    tableWrapper.innerHTML = renderTableHTML(categoryItems);
    section.appendChild(tableWrapper);

    fragment.appendChild(section);
  }

  container.appendChild(fragment);
}

function renderTableHTML(items) {
  let rows = '';
  items.forEach(item => {
    const isRunning = item.activeState === 'active';
    const isFailed = item.activeState === 'failed';
    let statusClass = 'inactive';
    let statusLabel = item.activeState || 'inactive';

    if (isRunning) {
      statusClass = 'active';
      statusLabel = 'Running';
    } else if (isFailed) {
      statusClass = 'failed';
      statusLabel = 'Failed';
    } else if (item.timer) {
      const timerActive = item.timer.active_state === 'active';
      statusClass = timerActive ? 'timer-active' : 'inactive';
      statusLabel = timerActive ? 'Timer Active' : 'Timer Inactive';
    }

    // Port link
    let webLink = '-';
    if (item.port) {
      const safePort = Number.parseInt(item.port, 10);
      if (!Number.isNaN(safePort)) {
        webLink = `<a href="http://localhost:${safePort}" target="_blank" rel="noopener noreferrer" class="port-badge">:${safePort} &nearr;</a>`;
      }
    }

    // Timer info
    let timerInfo = '-';
    if (item.timer) {
      const nextStr = (item.timer.next_str && item.timer.next_str !== 'n/a')
        ? item.timer.next_str
        : (item.timer.left_str && item.timer.left_str !== 'None' ? item.timer.left_str : 'Scheduled');
      const rule = item.timer.schedule ? ` (${item.timer.schedule})` : '';
      const subParts = [];
      if (item.timer.left_str && item.timer.next_str) subParts.push(item.timer.left_str);
      if (item.timer.passed_str) subParts.push(`Last: ${item.timer.passed_str}`);
      const subInfo = subParts.length > 0
        ? `<div style="font-size:0.74rem; color:var(--text-secondary);">${escapeHtml(subParts.join(' · '))}</div>`
        : '';
      timerInfo = `<span style="color:var(--blue); font-size:0.8rem;">${escapeHtml(nextStr)}${escapeHtml(rule)}</span>${subInfo}`;
    }

    const escapedUnit = escapeHtml(item.name);

    // Actions
    let actionButtons = '';
    if (item.itemType === 'service' || item.itemType === 'quadlet') {
      actionButtons = `
        <div class="table-actions">
          ${isRunning
            ? `<button type="button" class="btn btn-sm btn-danger-soft" data-ui-action="service-action" data-unit="${escapedUnit}" data-action="stop">Stop</button>`
            : `<button type="button" class="btn btn-sm btn-success-soft" data-ui-action="service-action" data-unit="${escapedUnit}" data-action="start">Start</button>`
          }
          <button type="button" class="btn btn-sm btn-secondary" data-ui-action="service-action" data-unit="${escapedUnit}" data-action="restart">Restart</button>
          <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-logs" data-unit="${escapedUnit}" data-scope="user">Logs</button>
          <button type="button" class="btn btn-sm btn-primary" data-ui-action="open-editor" data-unit="${escapedUnit}">Edit</button>
        </div>
      `;
    } else {
      const safePort = item.port ? Number.parseInt(item.port, 10) : NaN;
      actionButtons = `
        <div class="table-actions">
          <span class="file-path-badge">${escapeHtml(item.subState)}</span>
          ${!Number.isNaN(safePort) ? `<a class="btn btn-sm btn-primary" href="http://localhost:${safePort}" target="_blank" rel="noopener noreferrer">Open UI</a>` : ''}
        </div>
      `;
    }

    const engineBadge = item.engine
      ? `<span class="engine-badge engine-${escapeHtml(item.engine)}">${item.engine === 'docker' ? 'Docker' : 'Podman'}</span>`
      : '';

    rows += `
      <tr>
        <td style="width: 140px;">
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${escapeHtml(statusLabel)}
          </span>
        </td>
        <td>
          <div class="table-service-name">
            ${escapeHtml(item.displayName)}
            ${engineBadge}
          </div>
          <div class="table-service-file">${escapedUnit}</div>
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

function renderSystemView() {
  const container = document.getElementById('categories-container');
  if (!container) return;

  updateSystemStatCardActiveState();

  if (!systemTasksData) {
    container.innerHTML = '<div class="loading-state">Loading system tasks...</div>';
    return;
  }

  const { system_timers = [], cron_jobs = [], watchers = [], failed_units = [] } = systemTasksData;

  const filterBySearchAndStatus = (items, type) => {
    return items.filter(item => {
      if (currentFilter === 'running') {
        if (type === 'failed') return false;
        if (type !== 'cron') {
          const state = (item.active_state || item.active || '').toLowerCase();
          const sub = (item.sub_state || item.sub || '').toLowerCase();
          const isRunning = state === 'active' || state === 'running' || sub === 'running' || sub === 'listening' || sub === 'waiting';
          if (!isRunning) return false;
        }
      } else if (currentFilter === 'inactive') {
        if (type === 'cron') return false;
        if (type !== 'failed') {
          const state = (item.active_state || item.active || '').toLowerCase();
          const sub = (item.sub_state || item.sub || '').toLowerCase();
          const isInactive = state === 'inactive' || state === 'failed' || sub === 'dead' || sub === 'failed';
          if (!isInactive) return false;
        }
      }

      if (currentSearch) {
        const nameMatch = (item.display_name || item.name || '').toLowerCase().includes(currentSearch);
        const rawMatch = (item.name || '').toLowerCase().includes(currentSearch);
        const descMatch = (item.description || '').toLowerCase().includes(currentSearch);
        const actMatch = (item.activates || '').toLowerCase().includes(currentSearch);
        const cmdMatch = (item.command || '').toLowerCase().includes(currentSearch);
        const schedMatch = (item.schedule || '').toLowerCase().includes(currentSearch);
        const srcMatch = (item.source || '').toLowerCase().includes(currentSearch);
        return nameMatch || rawMatch || descMatch || actMatch || cmdMatch || schedMatch || srcMatch;
      }
      return true;
    });
  };

  const filteredFailed = (currentSysCategoryFilter === 'all' || currentSysCategoryFilter === 'failed')
    ? filterBySearchAndStatus(failed_units, 'failed') : [];
  const filteredTimers = (currentSysCategoryFilter === 'all' || currentSysCategoryFilter === 'timers')
    ? filterBySearchAndStatus(system_timers, 'timer') : [];
  const filteredCron = (currentSysCategoryFilter === 'all' || currentSysCategoryFilter === 'cron')
    ? filterBySearchAndStatus(cron_jobs, 'cron') : [];
  const filteredWatchers = (currentSysCategoryFilter === 'all' || currentSysCategoryFilter === 'watchers')
    ? filterBySearchAndStatus(watchers, 'watcher') : [];

  const totalFiltered = filteredFailed.length + filteredTimers.length + filteredCron.length + filteredWatchers.length;

  if (totalFiltered === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.append('No matching system tasks, timers, or watchers found.');
    if (currentSysCategoryFilter !== 'all') {
      emptyDiv.appendChild(document.createElement('br'));
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-secondary btn-sm';
      clearBtn.style.marginTop = '10px';
      clearBtn.dataset.uiAction = 'clear-system-category';
      clearBtn.textContent = 'Show All System Tasks';
      emptyDiv.appendChild(clearBtn);
    }
    container.appendChild(emptyDiv);
    return;
  }

  const fragment = document.createDocumentFragment();
  let isFirst = true;

  if (filteredFailed.length > 0) {
    const sec = createSystemSection("Failed / Degraded Units", filteredFailed.length, 'danger', isFirst);
    isFirst = false;
    sec.appendChild(renderFailedUnitsTable(filteredFailed));
    fragment.appendChild(sec);
  }

  if (filteredTimers.length > 0) {
    const sec = createSystemSection("System Timers", filteredTimers.length, '', isFirst);
    isFirst = false;
    sec.appendChild(renderSystemTimersTable(filteredTimers));
    fragment.appendChild(sec);
  }

  if (filteredCron.length > 0) {
    const editPillHtml = `
      <button type="button" class="cron-quick-pill" data-ui-action="copy-cmd" data-copy="crontab -e" title="Click to copy 'crontab -e' to clipboard">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>Edit User Crontab: <code>crontab -e</code></span>
      </button>
    `;
    const sec = createSystemSection("Cron Jobs & Scheduled Scripts", filteredCron.length, '', isFirst, '', editPillHtml);
    isFirst = false;
    sec.appendChild(renderCronJobsTable(filteredCron));
    fragment.appendChild(sec);
  }

  if (filteredWatchers.length > 0) {
    const sec = createSystemSection("Sockets & Path Watchers", filteredWatchers.length, '', isFirst);
    isFirst = false;
    sec.appendChild(renderWatchersTable(filteredWatchers));
    fragment.appendChild(sec);
  }

  container.appendChild(fragment);
}

function createSystemSection(title, count, badgeTheme = '', isFirst = false, extraHeaderHtml = '', rightSideHtml = '') {
  const sec = document.createElement('section');
  sec.className = 'category-section';

  const isFiltered = (currentSysCategoryFilter !== 'all');
  if (isFiltered) {
    sec.classList.add('is-filtered');
  }

  const badgeClass = badgeTheme === 'danger' ? 'category-badge category-badge-danger' : 'category-badge';

  let filterPillHtml = '';
  if (isFiltered) {
    filterPillHtml = `
      <button type="button" class="category-filter-pill" data-ui-action="clear-system-category" title="Clear filter and show all system tasks">
        <span>Filtered</span>
        <span class="pill-close">&times;</span>
      </button>
    `;
  }

  let lastScanHtml = '';
  if (isFirst) {
    const scanTime = (systemTasksData && systemTasksData.last_scan) ? `Last scan: ${systemTasksData.last_scan}` : currentLastScanText;
    lastScanHtml = `<span class="last-scan-label" id="last-scan-time">${escapeHtml(scanTime)}</span>`;
  }

  const header = document.createElement('div');
  header.className = 'category-header';
  header.innerHTML = `
    <div class="category-title-area">
      <h2 class="category-title">${escapeHtml(title)}</h2>
      <span class="${badgeClass}">${count}</span>
      ${extraHeaderHtml || ''}
      ${filterPillHtml}
    </div>
    <div class="category-header-right" style="display: flex; align-items: center; gap: 10px;">
      ${rightSideHtml || ''}
      ${lastScanHtml}
    </div>
  `;

  sec.appendChild(header);
  return sec;
}

function renderSystemTimersTable(items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-container';

  let rows = '';
  items.forEach(item => {
    const isWaiting = item.sub_state === 'waiting' || item.active_state === 'active';
    const statusClass = isWaiting ? 'active' : 'inactive';
    const statusLabel = escapeHtml(item.sub_state || item.active_state || 'waiting');
    const scopeClass = item.scope === 'system' ? 'scope-system' : 'scope-user';
    const scopeVal = escapeHtml(item.scope || 'system');

    const targetService = item.activates ? `<div class="table-service-file">Activates: <code>${escapeHtml(item.activates)}</code></div>` : '';
    const hasNext = Boolean(item.next_str && item.next_str !== 'n/a');
    const nextRun = hasNext
      ? `<span style="color:var(--blue); font-size:0.8rem;">${escapeHtml(item.next_str)}</span>${item.left_str ? `<div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(item.left_str)}</div>` : ''}`
      : '-';
    const hasLast = Boolean(item.last_str && item.last_str !== '-');
    const lastRun = hasLast
      ? `<span style="font-size:0.8rem; color:var(--text-main);">${escapeHtml(item.last_str)}</span>${item.passed_str ? `<div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(item.passed_str)}</div>` : ''}`
      : 'Never';

    const logsTarget = escapeHtml(item.activates || item.name);
    const timerName = escapeHtml(item.name);

    rows += `
      <tr>
        <td style="width: 130px;">
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${statusLabel}
          </span>
        </td>
        <td>
          <div class="table-service-name font-mono">${escapeHtml(item.display_name || item.name)}</div>
          ${targetService}
        </td>
        <td style="width: 80px;"><span class="scope-badge ${scopeClass}">${scopeVal}</span></td>
        <td style="width: 170px;">${nextRun}</td>
        <td style="width: 170px;">${lastRun}</td>
        <td class="table-desc" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '-')}</td>
        <td style="width: 160px; text-align: right;">
          <div class="table-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-logs" data-unit="${logsTarget}" data-scope="${scopeVal}">Logs</button>
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-inspect" data-unit="${timerName}" data-scope="${scopeVal}">Inspect</button>
          </div>
        </td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <table class="services-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Timer & Target Unit</th>
          <th>Scope</th>
          <th>Next Run</th>
          <th>Last Run</th>
          <th>Description</th>
          <th style="text-align: right; width: 160px;">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  return wrapper;
}

function renderCronJobsTable(items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-container';

  let rows = '';
  items.forEach(item => {
    const scopeClass = item.scope === 'system' ? 'scope-system' : 'scope-user';
    const sourceText = item.source ? `<div class="table-service-file">${escapeHtml(item.source)}</div>` : '';

    rows += `
      <tr>
        <td style="width: 110px;">
          <span class="status-badge active">
            <span class="status-dot"></span>
            Active
          </span>
        </td>
        <td>
          <div class="table-service-name font-mono">${escapeHtml(item.name)}</div>
          ${sourceText}
        </td>
        <td style="width: 80px;"><span class="scope-badge ${scopeClass}">${escapeHtml(item.scope || 'system')}</span></td>
        <td style="width: 140px;"><code class="badge badge-primary font-mono" style="font-size:0.8rem;">${escapeHtml(item.schedule || '-')}</code></td>
        <td><code class="system-cmd-code">${escapeHtml(item.command || '-')}</code></td>
        <td class="table-desc" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '-')}</td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <table class="services-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Job Name & Source</th>
          <th>Scope</th>
          <th>Schedule</th>
          <th>Command / Script</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  return wrapper;
}

function copyEditCommand(cmd) {
  if (!cmd) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(() => {
      showToast(`Copied to clipboard: ${cmd}`);
    }).catch(() => {
      fallbackCopyText(cmd);
    });
  } else {
    fallbackCopyText(cmd);
  }
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(`Copied to clipboard: ${text}`);
  } catch (err) {
    showToast(`Command: ${text}`, 'info');
  }
  document.body.removeChild(ta);
}

function renderWatchersTable(items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-container';

  let rows = '';
  items.forEach(item => {
    const isActive = item.active_state === 'active';
    const statusClass = isActive ? 'active' : 'inactive';
    const statusLabel = escapeHtml(item.sub_state || item.active_state || 'active');
    const scopeClass = item.scope === 'system' ? 'scope-system' : 'scope-user';
    const scopeVal = escapeHtml(item.scope || 'system');
    const typeLabel = (item.type || 'watcher').toUpperCase();
    const rawUnit = escapeHtml(item.name);

    rows += `
      <tr>
        <td style="width: 130px;">
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${statusLabel}
          </span>
        </td>
        <td>
          <div class="table-service-name font-mono">${escapeHtml(item.display_name || item.name)}</div>
        </td>
        <td style="width: 90px;"><span class="engine-badge engine-podman">${escapeHtml(typeLabel)}</span></td>
        <td style="width: 80px;"><span class="scope-badge ${scopeClass}">${scopeVal}</span></td>
        <td class="table-desc" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '-')}</td>
        <td style="width: 160px; text-align: right;">
          <div class="table-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-logs" data-unit="${rawUnit}" data-scope="${scopeVal}">Logs</button>
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-inspect" data-unit="${rawUnit}" data-scope="${scopeVal}">Inspect</button>
          </div>
        </td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <table class="services-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Unit Name</th>
          <th>Type</th>
          <th>Scope</th>
          <th>Description</th>
          <th style="text-align: right; width: 160px;">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  return wrapper;
}

function renderFailedUnitsTable(items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-container';

  let rows = '';
  items.forEach(item => {
    const scopeClass = item.scope === 'system' ? 'scope-system' : 'scope-user';
    const scopeVal = escapeHtml(item.scope || 'system');
    const subLabel = escapeHtml(item.sub || item.active || 'failed');
    const rawUnit = escapeHtml(item.name);

    rows += `
      <tr>
        <td style="width: 130px;">
          <span class="status-badge failed">
            <span class="status-dot"></span>
            FAILED
          </span>
        </td>
        <td>
          <div class="table-service-name font-mono" style="color:var(--danger); font-weight:600;">${escapeHtml(item.display_name || item.name)}</div>
        </td>
        <td style="width: 80px;"><span class="scope-badge ${scopeClass}">${scopeVal}</span></td>
        <td style="width: 100px;"><span class="file-path-badge" style="color:var(--danger);">${subLabel}</span></td>
        <td class="table-desc" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '-')}</td>
        <td style="width: 160px; text-align: right;">
          <div class="table-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-logs" data-unit="${rawUnit}" data-scope="${scopeVal}">Logs</button>
            <button type="button" class="btn btn-sm btn-secondary" data-ui-action="open-inspect" data-unit="${rawUnit}" data-scope="${scopeVal}">Inspect</button>
          </div>
        </td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <table class="services-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Failed Unit Name</th>
          <th>Scope</th>
          <th>Sub State</th>
          <th>Description</th>
          <th style="text-align: right; width: 160px;">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  return wrapper;
}

// Service Actions (Start / Stop / Restart)
async function performAction(unitName, action) {
  try {
    showToast(`Sending ${action} command to ${unitName}...`);
    const res = await fetch(`/api/service/${encodeURIComponent(unitName)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Action failed');
    }
    showToast(`Successfully performed ${action} on ${unitName}!`);
    loadData({ servicesOnly: true });
  } catch (err) {
    console.error('Service action error:', err);
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Editor / Inspect Modal
function resetEditorModalState() {
  if (editorCloseTimer) {
    clearTimeout(editorCloseTimer);
    editorCloseTimer = null;
  }
  if (editorFetchController) {
    editorFetchController.abort();
    editorFetchController = null;
  }
  const textarea = document.getElementById('editor-textarea');
  const saveBtn = document.getElementById('btn-save-editor');
  const saveRestartBtn = document.getElementById('btn-save-restart-editor');
  const cancelBtn = document.getElementById('btn-cancel-editor');
  if (textarea) textarea.readOnly = false;
  if (saveBtn) {
    saveBtn.style.display = '';
    saveBtn.disabled = false;
  }
  if (saveRestartBtn) {
    saveRestartBtn.style.display = '';
    saveRestartBtn.disabled = false;
  }
  if (cancelBtn) cancelBtn.textContent = 'Cancel';
}

async function openEditorModal(unitName) {
  resetEditorModalState();
  currentEditingUnit = unitName;
  editorFetchController = new AbortController();
  const { signal } = editorFetchController;

  const modal = document.getElementById('editor-modal');
  const title = document.getElementById('editor-title');
  const pathBadge = document.getElementById('editor-file-path');
  const textarea = document.getElementById('editor-textarea');
  const banner = document.getElementById('editor-banner');

  banner.className = 'banner hidden';
  title.textContent = `Edit ${unitName}`;
  pathBadge.textContent = 'Loading path...';
  textarea.value = 'Loading file contents...';
  modal.classList.add('open');

  try {
    const res = await fetch(`/api/service/${encodeURIComponent(unitName)}/file`, { signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Could not load unit file (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (signal.aborted) return;
    pathBadge.textContent = data.file_path;
    textarea.value = data.content;
    textarea.focus();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error('Error fetching unit file:', err);
    textarea.value = `Error loading file: ${err.message}`;
  }
}

function closeEditorModal() {
  document.getElementById('editor-modal').classList.remove('open');
  currentEditingUnit = null;
  resetEditorModalState();
}

async function openInspectModal(unitName, scope = 'system') {
  resetEditorModalState();
  currentEditingUnit = null;
  editorFetchController = new AbortController();
  const { signal } = editorFetchController;

  const modal = document.getElementById('editor-modal');
  const title = document.getElementById('editor-title');
  const pathBadge = document.getElementById('editor-file-path');
  const textarea = document.getElementById('editor-textarea');
  const banner = document.getElementById('editor-banner');
  const saveBtn = document.getElementById('btn-save-editor');
  const saveRestartBtn = document.getElementById('btn-save-restart-editor');
  const cancelBtn = document.getElementById('btn-cancel-editor');

  banner.className = 'banner hidden';
  title.textContent = `Inspect ${unitName}`;
  pathBadge.textContent = `systemctl cat (${scope} scope)`;
  textarea.value = 'Loading unit definition via systemctl cat...';
  textarea.readOnly = true;

  if (saveBtn) saveBtn.style.display = 'none';
  if (saveRestartBtn) saveRestartBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.textContent = 'Close';

  modal.classList.add('open');

  try {
    const res = await fetch(
      `/api/system-unit/${encodeURIComponent(unitName)}/cat?scope=${encodeURIComponent(scope)}`,
      { signal }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP error ${res.status}`);
    }
    const data = await res.json();
    if (signal.aborted) return;
    textarea.value = data.content || 'No definition returned.';
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error('Error fetching unit inspection:', err);
    textarea.value = `Error loading unit definition: ${err.message}`;
  }
}

async function saveUnitFile(restartAfter) {
  if (!currentEditingUnit) return;
  const targetUnit = currentEditingUnit;
  const textarea = document.getElementById('editor-textarea');
  const banner = document.getElementById('editor-banner');
  const saveBtn = document.getElementById('btn-save-editor');
  const saveRestartBtn = document.getElementById('btn-save-restart-editor');

  saveBtn.disabled = true;
  saveRestartBtn.disabled = true;
  banner.className = 'banner hidden';

  try {
    const res = await fetch(`/api/service/${encodeURIComponent(targetUnit)}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: textarea.value,
        restart: restartAfter
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Save failed');
    }
    const result = await res.json();
    banner.className = 'banner success';
    banner.textContent = `File saved successfully! (Backup: ${result.backup})${result.restarted ? ' Service restarted.' : ''}`;
    banner.classList.remove('hidden');
    showToast(`Saved ${targetUnit}!`);
    loadData({ servicesOnly: true });
    if (editorCloseTimer) clearTimeout(editorCloseTimer);
    editorCloseTimer = setTimeout(() => {
      editorCloseTimer = null;
      if (currentEditingUnit === targetUnit) {
        closeEditorModal();
      }
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
async function openLogsModal(unitName, scope = 'user') {
  currentLogsUnit = unitName;
  currentLogsScope = scope;
  const modal = document.getElementById('logs-modal');
  const title = document.getElementById('logs-title');
  const unitBadge = document.getElementById('logs-unit-name');
  const terminal = document.getElementById('logs-terminal');

  title.textContent = `Journal Logs: ${unitName}`;
  unitBadge.textContent = `${unitName} (${scope})`;
  terminal.textContent = 'Loading logs...';
  modal.classList.add('open');

  await refreshLogs();
}

function closeLogsModal() {
  if (logsFetchController) {
    logsFetchController.abort();
    logsFetchController = null;
  }
  document.getElementById('logs-modal').classList.remove('open');
  currentLogsUnit = null;
}

async function refreshLogs() {
  if (!currentLogsUnit) return;
  if (logsFetchController) {
    logsFetchController.abort();
  }
  logsFetchController = new AbortController();
  const { signal } = logsFetchController;

  const terminal = document.getElementById('logs-terminal');
  try {
    const res = await fetch(
      `/api/service/${encodeURIComponent(currentLogsUnit)}/logs?lines=100&scope=${encodeURIComponent(currentLogsScope)}`,
      { signal }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Could not fetch logs (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (signal.aborted) return;
    terminal.textContent = data.logs || 'No journal log entries found for this service.';
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    terminal.textContent = `Error fetching logs: ${err.message}`;
  }
}

function copyLogsToClipboard() {
  const terminal = document.getElementById('logs-terminal');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(terminal.textContent).then(() => {
      showToast('Logs copied to clipboard!');
    }).catch(() => {
      fallbackCopyText(terminal.textContent);
    });
  } else {
    fallbackCopyText(terminal.textContent);
  }
}

// Toast
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toast.textContent = message;
  toast.style.borderColor = type === 'error' ? 'var(--danger)' : 'var(--primary)';
  toast.style.display = 'block';
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
    toastTimer = null;
  }, 3000);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   Settings, Themes & Integration System
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
  { inputId: "color-accent-purple", hexId: "hex-accent-purple", varName: "--accent-purple" }
];

const THEME_STYLE_VARS = [
  "--bg-primary", "--bg-secondary", "--bg-card", "--bg-card-hover", "--border-color",
  "--text-primary", "--text-secondary", "--text-muted",
  "--accent-blue", "--accent-purple", "--accent-orange", "--accent-green", "--accent-red",
  "--bg-base", "--bg-surface", "--text-main", "--primary", "--primary-hover",
  "--accent", "--accent-hover", "--success", "--warning", "--danger",
  "--on-primary", "--on-accent"
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
let cachedAppVersion = "v1.2.5";
let cachedGithubRepo = "PlasmaDrifter/Services-dashboard";

function sanitizeHttpUrl(rawUrl, fallback = "http://localhost:8765") {
  if (!rawUrl || typeof rawUrl !== "string") return fallback;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString().replace(/\/$/, "") === rawUrl.trim() ? rawUrl.trim() : parsed.href;
    }
  } catch (_) {
    // Fall back on invalid URL
  }
  return fallback;
}

function getContrastTextColor(hexColor) {
  const hex = normalizeHex(hexColor).slice(1);
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const toLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return lum > 0.34 ? "#181926" : "#ffffff";
}

function shiftHexColor(hexColor, delta) {
  const hex = normalizeHex(hexColor).slice(1);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(parseInt(hex.slice(0, 2), 16) + delta).toString(16).padStart(2, "0");
  const g = clamp(parseInt(hex.slice(2, 4), 16) + delta).toString(16).padStart(2, "0");
  const b = clamp(parseInt(hex.slice(4, 6), 16) + delta).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function computeHoverColor(cardHex) {
  const contrast = getContrastTextColor(cardHex);
  return contrast === "#ffffff" ? shiftHexColor(cardHex, 12) : shiftHexColor(cardHex, -12);
}

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
        appIndexUrl: sanitizeHttpUrl(parsed.appIndexUrl),
        showGitHubBtn: parsed.showGitHubBtn !== undefined ? Boolean(parsed.showGitHubBtn) : true,
        checkForUpdates: parsed.checkForUpdates !== undefined ? Boolean(parsed.checkForUpdates) : true
      };
    }
  } catch (err) {
    console.warn("Could not load settings from localStorage:", err);
  }

  // Sync companion/update settings and app version with backend
  fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && data.status === "ok") {
        if (data.app_version) {
          cachedAppVersion = data.app_version;
          const formattedVer = cachedAppVersion.startsWith("v") ? cachedAppVersion : `v${cachedAppVersion}`;
          const headerVer = document.getElementById("header-app-version");
          if (headerVer) headerVer.textContent = formattedVer;
        }
        if (data.github_repo) cachedGithubRepo = data.github_repo;
        const s = data.settings || {};

        let needsSaveToLocal = false;
        let needsSaveToBackend = false;

        if (s.show_appindex_link === true && !userSettings.showAppIndexLink) {
          userSettings.showAppIndexLink = true;
          needsSaveToLocal = true;
        } else if (userSettings.showAppIndexLink && s.show_appindex_link !== true) {
          needsSaveToBackend = true;
        }

        if (s.open_appindex_same_tab === true && !userSettings.openAppIndexInSameTab) {
          userSettings.openAppIndexInSameTab = true;
          needsSaveToLocal = true;
        } else if (userSettings.openAppIndexInSameTab && s.open_appindex_same_tab !== true) {
          needsSaveToBackend = true;
        }

        if (s.appindex_url && s.appindex_url !== "http://localhost:8765" && userSettings.appIndexUrl === "http://localhost:8765") {
          userSettings.appIndexUrl = sanitizeHttpUrl(s.appindex_url);
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
          saveLocalSettings();
        }
        if (needsSaveToBackend) {
          saveBackendSettings();
        }

        if (data.update_info) {
          appUpdateData = data.update_info;
          renderUpdateUI(appUpdateData);
        } else {
          renderUpdateUI(null);
        }
        applyAllActiveSettings();
        syncSettingsUI();
      }
    })
    .catch(() => {});
}

function saveLocalSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
  } catch (err) {
    console.warn("Could not save settings to localStorage:", err);
  }
}

function saveBackendSettings() {
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      show_github_btn: userSettings.showGitHubBtn,
      check_for_updates: userSettings.checkForUpdates,
      show_appindex_link: userSettings.showAppIndexLink,
      open_appindex_same_tab: userSettings.openAppIndexInSameTab,
      appindex_url: sanitizeHttpUrl(userSettings.appIndexUrl)
    })
  }).catch((err) => {
    console.warn("Could not save settings to backend:", err);
  });
}

function saveSettingsToStorage(syncBackend = true) {
  saveLocalSettings();
  if (syncBackend) {
    saveBackendSettings();
  }
}

function applyAllActiveSettings() {
  if (userSettings.themeId === "custom" && userSettings.customColors) {
    applyThemeColors(userSettings.customColors);
  } else if (PRESET_THEMES[userSettings.themeId]) {
    applyThemeColors(PRESET_THEMES[userSettings.themeId].colors);
  } else if (userSettings.savedCustomThemes && userSettings.savedCustomThemes[userSettings.themeId]) {
    applyThemeColors(userSettings.savedCustomThemes[userSettings.themeId]);
  } else {
    applyThemeColors(PRESET_THEMES["catppuccin"].colors);
  }

  applyDensity(userSettings.density);
  applyFontScale(userSettings.fontScale);
  applyAppIndexNav();
  applyGitHubNav();
}

function applyThemeColors(colorsObj) {
  if (!colorsObj) return;
  const root = document.documentElement;
  THEME_STYLE_VARS.forEach((prop) => root.style.removeProperty(prop));

  for (const [key, val] of Object.entries(colorsObj)) {
    root.style.setProperty(key, val);
  }

  if (colorsObj["--bg-primary"]) root.style.setProperty("--bg-base", colorsObj["--bg-primary"]);
  if (colorsObj["--bg-secondary"]) root.style.setProperty("--bg-surface", colorsObj["--bg-secondary"]);
  if (colorsObj["--text-primary"]) root.style.setProperty("--text-main", colorsObj["--text-primary"]);
  if (colorsObj["--bg-card"] && !colorsObj["--bg-card-hover"]) {
    root.style.setProperty("--bg-card-hover", computeHoverColor(colorsObj["--bg-card"]));
  }
  if (colorsObj["--accent-blue"]) {
    root.style.setProperty("--primary", colorsObj["--accent-blue"]);
    root.style.setProperty("--primary-hover", colorsObj["--accent-blue"]);
    root.style.setProperty("--on-primary", getContrastTextColor(colorsObj["--accent-blue"]));
  }
  if (colorsObj["--accent-purple"]) {
    root.style.setProperty("--accent", colorsObj["--accent-purple"]);
    root.style.setProperty("--accent-hover", colorsObj["--accent-purple"]);
    root.style.setProperty("--on-accent", getContrastTextColor(colorsObj["--accent-purple"]));
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
  link.href = sanitizeHttpUrl(userSettings.appIndexUrl);

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
    .then((r) => (r.ok ? r.json() : null))
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
  const base = cleaned.split(/-(?:alpha|beta|rc|dev|pre)/i)[0];
  return base.split(/[-.+_]/).map((p) => parseInt(p, 10)).filter((n) => !isNaN(n));
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
  const bannerCodeLink = document.getElementById("update-banner-code-link");
  const btnSettings = document.getElementById("btn-settings");

  const headerVer = document.getElementById("header-app-version");
  const settingsVer = document.getElementById("settings-app-version");
  const curVer = (info && info.current_version) ? info.current_version : (cachedAppVersion || "v1.2.5");
  const formattedVer = curVer.startsWith("v") ? curVer : `v${curVer}`;
  if (settingsVer) settingsVer.textContent = formattedVer;
  if (headerVer) headerVer.textContent = formattedVer;

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
      ghLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/Services-dashboard'}`;
      ghLink.title = `GitHub Repository (${formattedVer})`;
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
        statusBadge.onclick = info.release_url
          ? () => window.open(sanitizeHttpUrl(info.release_url, "https://github.com/PlasmaDrifter/Services-dashboard/releases"), "_blank", "noopener,noreferrer")
          : null;
      }
      if (banner) {
        banner.style.display = "flex";
        if (bannerVer) bannerVer.textContent = cleanVer;
        if (bannerLink && info.release_url) {
          bannerLink.href = sanitizeHttpUrl(info.release_url, "https://github.com/PlasmaDrifter/Services-dashboard/releases");
        }
        if (bannerCodeLink) {
          bannerCodeLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/Services-dashboard'}/tree/${encodeURIComponent(cleanVer)}`;
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

  if (btnSettings) btnSettings.title = "Application Settings";
  if (ghLink) {
    ghLink.classList.remove("has-update");
    ghLink.href = `https://github.com/${cachedGithubRepo || 'PlasmaDrifter/Services-dashboard'}`;
    ghLink.title = `GitHub Repository (${cachedAppVersion || 'v1.2.5'})`;
  }
  if (navBadge) {
    navBadge.classList.add("hidden");
    navBadge.style.display = "none";
  }
  if (statusBadge) {
    statusBadge.style.display = "none";
    statusBadge.onclick = null;
  }
  if (banner) banner.style.display = "none";
}

async function executeSelfUpdate() {
  const versionStr = appUpdateData && appUpdateData.latest_version ? ` to ${appUpdateData.latest_version}` : "";
  const confirmed = window.confirm(`Update Services-dashboard${versionStr}? The server will automatically download changes and restart.`);
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
  if (btnDismiss) btnDismiss.style.display = "none";

  const progressModal = document.getElementById("update-progress-modal");
  const progressTitle = document.getElementById("update-progress-title");
  const progressDesc = document.getElementById("update-progress-desc");

  if (progressModal) progressModal.style.display = "flex";

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
        const ping = await fetch("/api/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(2500)
        });
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
        if (btnDismiss) btnDismiss.style.display = "";
      }, 5000);
    }
  } catch (err) {
    if (progressModal) progressModal.style.display = "none";
    if (btnApply) {
      btnApply.disabled = false;
      btnApply.innerHTML = origBtnContent;
      btnApply.style.cursor = "pointer";
    }
    if (btnDismiss) btnDismiss.style.display = "";
    showToast(`Update failed: ${err.message}`, 'error');
  }
}

function initSettingsUI() {
  renderPresetThemeGrid();
  renderSavedCustomThemes();
  syncSettingsUI();
  bindSettingsInteractiveEvents();
}

function syncSettingsUI() {
  const selector = document.getElementById("density-selector");
  if (selector) {
    selector.querySelectorAll(".density-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.density === userSettings.density);
    });
  }

  const slider = document.getElementById("font-scale-slider");
  const valBadge = document.getElementById("font-scale-value");
  if (slider) slider.value = userSettings.fontScale;
  if (valBadge) valBadge.textContent = userSettings.fontScale + "%";

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

  const presetsGrid = document.getElementById("theme-presets-grid");
  if (presetsGrid) {
    presetsGrid.querySelectorAll(".theme-preset-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.themeId === userSettings.themeId);
    });
  }

  const toggleAppIndex = document.getElementById("toggle-appindex-link");
  const toggleSameTab = document.getElementById("toggle-appindex-same-tab");
  const sameTabWrapper = document.getElementById("companion-same-tab-wrapper");
  const appIndexUrlConfig = document.getElementById("appindex-url-config");
  const appIndexUrlInput = document.getElementById("appindex-url-input");
  const toggleGitHub = document.getElementById("toggle-github-btn");
  const toggleUpdates = document.getElementById("toggle-check-updates");

  if (toggleGitHub) toggleGitHub.checked = Boolean(userSettings.showGitHubBtn);
  if (toggleUpdates) toggleUpdates.checked = Boolean(userSettings.checkForUpdates);

  renderUpdateUI(appUpdateData);

  if (toggleAppIndex) toggleAppIndex.checked = Boolean(userSettings.showAppIndexLink);
  if (toggleSameTab) toggleSameTab.checked = Boolean(userSettings.openAppIndexInSameTab);
  if (sameTabWrapper) {
    sameTabWrapper.classList.toggle("toggle-disabled", !userSettings.showAppIndexLink);
    if (toggleSameTab) toggleSameTab.disabled = !userSettings.showAppIndexLink;
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
  presetsGrid.replaceChildren();

  Object.entries(PRESET_THEMES).forEach(([themeId, theme]) => {
    const card = document.createElement("div");
    card.className = "theme-preset-card" + (userSettings.themeId === themeId ? " active" : "");
    card.dataset.themeId = themeId;

    const swatchesHtml = theme.swatches
      .map((hex) => `<span class="theme-swatch-circle" style="background-color: ${escapeHtml(hex)};"></span>`)
      .join("");

    card.innerHTML = `
      <div class="theme-swatches">${swatchesHtml}</div>
      <span class="theme-name" title="${escapeHtml(theme.name)}">${escapeHtml(theme.name)}</span>
    `;

    card.addEventListener("click", () => {
      userSettings.themeId = themeId;
      userSettings.customColors = null;
      applyThemeColors(theme.colors);
      updateColorPickersUI(theme.colors);
      saveSettingsToStorage(false);
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
    list.replaceChildren();
    return;
  }

  customSection.style.display = "block";
  list.replaceChildren();

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
      saveSettingsToStorage(false);
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
      saveSettingsToStorage(false);
      syncSettingsUI();
      renderSavedCustomThemes();
      showToast(`Deleted theme: ${name}`);
    });

    list.appendChild(chip);
  });
}

function bindSettingsInteractiveEvents() {
  // Density selector buttons (local only)
  const selector = document.getElementById("density-selector");
  if (selector) {
    selector.querySelectorAll(".density-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const density = btn.dataset.density;
        userSettings.density = density;
        applyDensity(density);
        saveSettingsToStorage(false);
        syncSettingsUI();
      });
    });
  }

  // Font scale slider (local only, avoid spamming /api/settings while dragging)
  const slider = document.getElementById("font-scale-slider");
  const valBadge = document.getElementById("font-scale-value");
  if (slider) {
    slider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      userSettings.fontScale = val;
      applyFontScale(val);
      if (valBadge) valBadge.textContent = val + "%";
    });
    slider.addEventListener("change", () => {
      saveSettingsToStorage(false);
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
      saveSettingsToStorage(false);
    });
  });

  // Color pickers input (local only; persist on change)
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
        const hoverHex = computeHoverColor(val);
        userSettings.customColors["--bg-card-hover"] = hoverHex;
        document.documentElement.style.setProperty("--bg-card-hover", hoverHex);
      }

      if (varName === "--bg-primary") document.documentElement.style.setProperty("--bg-base", val);
      if (varName === "--bg-secondary") document.documentElement.style.setProperty("--bg-surface", val);
      if (varName === "--text-primary") document.documentElement.style.setProperty("--text-main", val);
      if (varName === "--accent-blue") {
        document.documentElement.style.setProperty("--primary", val);
        document.documentElement.style.setProperty("--primary-hover", val);
        document.documentElement.style.setProperty("--on-primary", getContrastTextColor(val));
      }
      if (varName === "--accent-purple") {
        document.documentElement.style.setProperty("--accent", val);
        document.documentElement.style.setProperty("--accent-hover", val);
        document.documentElement.style.setProperty("--on-accent", getContrastTextColor(val));
      }

      const presetsGrid = document.getElementById("theme-presets-grid");
      if (presetsGrid) {
        presetsGrid.querySelectorAll(".theme-preset-card").forEach((c) => c.classList.remove("active"));
      }
    });

    input.addEventListener("change", () => {
      saveSettingsToStorage(false);
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
      if (colors["--bg-card"]) {
        colors["--bg-card-hover"] = computeHoverColor(colors["--bg-card"]);
      }

      userSettings.savedCustomThemes[name] = colors;
      userSettings.themeId = name;
      userSettings.customColors = null;
      nameInput.value = "";

      saveSettingsToStorage(false);
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
      saveSettingsToStorage(true);
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
      if (appUpdateData && appUpdateData.latest_version) {
        localStorage.setItem("dashboard_dismissed_update_version", appUpdateData.latest_version);
      }
      clearUpdateIndicator();
      showToast("Update notifications cleared");
    });
  }

  // Settings Update Banner Apply (Self-Update)
  const btnApplyUpdate = document.getElementById("btn-apply-update");
  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener("click", executeSelfUpdate);
  }

  // Navigation Links & Updates (persisted on backend)
  const toggleGitHub = document.getElementById("toggle-github-btn");
  const toggleUpdates = document.getElementById("toggle-check-updates");

  if (toggleGitHub) {
    toggleGitHub.addEventListener("change", (e) => {
      userSettings.showGitHubBtn = e.target.checked;
      applyGitHubNav();
      saveSettingsToStorage(true);
    });
  }

  if (toggleUpdates) {
    toggleUpdates.addEventListener("change", (e) => {
      userSettings.checkForUpdates = e.target.checked;
      saveSettingsToStorage(true);
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
        sameTabWrapper.classList.toggle("toggle-disabled", !e.target.checked);
        if (toggleSameTab) toggleSameTab.disabled = !e.target.checked;
      }
      applyAppIndexNav();
      saveSettingsToStorage(true);
    });
  }

  if (toggleSameTab) {
    toggleSameTab.addEventListener("change", (e) => {
      userSettings.openAppIndexInSameTab = e.target.checked;
      applyAppIndexNav();
      saveSettingsToStorage(true);
    });
  }

  if (appIndexUrlInput) {
    const handleUrlChange = () => {
      const rawVal = appIndexUrlInput.value.trim();
      const safeUrl = sanitizeHttpUrl(rawVal);
      if (rawVal && safeUrl !== rawVal) {
        showToast("AppIndex URL must use http:// or https://", "error");
      }
      if (appIndexUrlInput.value !== safeUrl) {
        appIndexUrlInput.value = safeUrl;
      }
      if (userSettings.appIndexUrl !== safeUrl) {
        userSettings.appIndexUrl = safeUrl;
        applyAppIndexNav();
        saveSettingsToStorage(true);
      }
    };
    appIndexUrlInput.addEventListener("change", handleUrlChange);
    appIndexUrlInput.addEventListener("blur", handleUrlChange);
  }

  if (btnResetUrl && appIndexUrlInput) {
    btnResetUrl.addEventListener("click", () => {
      appIndexUrlInput.value = "http://localhost:8765";
      userSettings.appIndexUrl = "http://localhost:8765";
      applyAppIndexNav();
      saveSettingsToStorage(true);
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
  if (modal && modal.classList.contains("open")) {
    document.querySelectorAll(".help-popover").forEach((p) => (p.style.display = "none"));
    document.querySelectorAll(".help-circle-btn").forEach((b) => b.classList.remove("active"));

    saveLocalSettings();
    applyAllActiveSettings();

    modal.classList.remove("open");
    modal.style.display = "none";
  }
}
