// ─── State ───
let selectedTabs = new Set();
let allTabs = [];
let selectedColor = 'blue';

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  loadTabs();
  loadGroups();
  loadAutoGroupStatus();
  setupListeners();
});

// ─── Auto-group toggle ───
function loadAutoGroupStatus() {
  chrome.runtime.sendMessage({ action: 'getAutoGroupStatus' }, (enabled) => {
    const toggle = document.getElementById('autoGroupToggle');
    const dot = document.getElementById('autoDot');
    toggle.checked = enabled;
    dot.classList.toggle('off', !enabled);
  });
}


// ─── Data Loading ───
function loadTabs() {
  chrome.runtime.sendMessage({ action: 'getTabs' }, (tabs) => {
    if (!tabs) return;
    allTabs = tabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
    document.getElementById('tabCount').textContent = `${allTabs.length} tab${allTabs.length !== 1 ? 's' : ''}`;
    renderTabs();
  });
}

function loadGroups() {
  chrome.runtime.sendMessage({ action: 'getGroups' }, (groups) => {
    if (!groups) return;
    const section = document.getElementById('groupsSection');
    const list = document.getElementById('groupsList');

    if (groups.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = '';

    // Count tabs per group
    chrome.runtime.sendMessage({ action: 'getTabs' }, (tabs) => {
      const groupCounts = {};
      if (tabs) {
        tabs.forEach(t => {
          if (t.groupId !== -1) {
            groupCounts[t.groupId] = (groupCounts[t.groupId] || 0) + 1;
          }
        });
      }

      groups.forEach(g => {
        const item = document.createElement('div');
        item.className = 'group-item';
        item.innerHTML = `
          <div class="group-info">
            <div class="group-dot" style="background:var(--g-${g.color})"></div>
            <span class="group-name">${escapeHtml(g.title || 'Unnamed')}</span>
            <span class="group-badge">${groupCounts[g.id] || 0}</span>
          </div>
          <div class="group-actions">
            <button class="icon-btn del" data-group-id="${g.id}" title="Ungroup">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            </button>
          </div>
        `;
        list.appendChild(item);
      });

      // Attach ungroup handlers
      list.querySelectorAll('.icon-btn.del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const groupId = parseInt(btn.dataset.groupId);
          chrome.runtime.sendMessage({ action: 'removeGroup', groupId }, () => {
            showToast('Group removed');
            loadGroups();
            loadTabs();
          });
        });
      });
    });
  });
}

// ─── Rendering ───
function renderTabs() {
  const list = document.getElementById('tabList');
  list.innerHTML = '';

  if (allTabs.length === 0) {
    list.innerHTML = '<div class="empty">No groupable tabs found</div>';
    return;
  }

  allTabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = `tab-item${selectedTabs.has(tab.id) ? ' selected' : ''}`;
    item.dataset.tabId = tab.id;

    const faviconHtml = tab.favIconUrl
      ? `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl)}" onerror="this.outerHTML='<div class=\\'tab-favicon-placeholder\\'>${escapeHtml(tab.domain[0].toUpperCase())}</div>'">`
      : `<div class="tab-favicon-placeholder">${escapeHtml(tab.domain[0]?.toUpperCase() || '?')}</div>`;

    item.innerHTML = `
      <div class="tab-checkbox"></div>
      ${faviconHtml}
      <span class="tab-title">${escapeHtml(tab.title)}</span>
      <span class="tab-domain">${escapeHtml(tab.domain)}</span>
    `;

    item.addEventListener('click', () => toggleTab(tab.id));
    list.appendChild(item);
  });

  updateSelectionUI();
}

function toggleTab(tabId) {
  if (selectedTabs.has(tabId)) {
    selectedTabs.delete(tabId);
  } else {
    selectedTabs.add(tabId);
  }
  renderTabs();
}

function updateSelectionUI() {
  const count = selectedTabs.size;
  const info = document.getElementById('selectionInfo');
  const panel = document.getElementById('createPanel');
  const btn = document.getElementById('btnCreate');
  const selectAllBtn = document.getElementById('btnSelectAll');

  info.textContent = count > 0 ? `${count} selected` : '';
  panel.classList.toggle('visible', count > 0);
  btn.disabled = count === 0;
  selectAllBtn.textContent = count === allTabs.length ? 'Deselect All' : 'Select All';
}

// ─── Event Listeners ───
function setupListeners() {
  // Auto-group toggle
  document.getElementById('autoGroupToggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    const dot = document.getElementById('autoDot');
    dot.classList.toggle('off', !enabled);
    chrome.runtime.sendMessage({ action: 'setAutoGroup', enabled }, () => {
      showToast(enabled ? 'Auto-grouping enabled' : 'Auto-grouping paused');
      if (enabled) {
        setTimeout(() => { loadGroups(); loadTabs(); }, 500);
      }
    });
  });

  // Quick actions
  document.getElementById('btnGroupByDomain').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'groupByDomain' }, () => {
      showToast('Grouped by domain');
      loadGroups();
      loadTabs();
    });
  });

  document.getElementById('btnCollapseAll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'collapseAll' }, () => {
      showToast('All groups collapsed');
    });
  });

  document.getElementById('btnExpandAll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'expandAll' }, () => {
      showToast('All groups expanded');
    });
  });

  document.getElementById('btnUngroupAll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'ungroupAll' }, () => {
      showToast('All tabs ungrouped');
      selectedTabs.clear();
      loadGroups();
      loadTabs();
    });
  });

  // Select all
  document.getElementById('btnSelectAll').addEventListener('click', () => {
    if (selectedTabs.size === allTabs.length) {
      selectedTabs.clear();
    } else {
      allTabs.forEach(t => selectedTabs.add(t.id));
    }
    renderTabs();
  });

  // Color picker
  document.getElementById('colorPicker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (!swatch) return;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    selectedColor = swatch.dataset.color;
  });

  // Create group
  document.getElementById('btnCreate').addEventListener('click', () => {
    const name = document.getElementById('groupNameInput').value.trim() || 'Custom Group';
    const tabIds = Array.from(selectedTabs);
    chrome.runtime.sendMessage({
      action: 'groupSelected',
      tabIds,
      groupName: name,
      color: selectedColor
    }, () => {
      showToast(`Created "${name}"`);
      selectedTabs.clear();
      document.getElementById('groupNameInput').value = '';
      loadGroups();
      loadTabs();
    });
  });

  // Enter key to create
  document.getElementById('groupNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && selectedTabs.size > 0) {
      document.getElementById('btnCreate').click();
    }
  });
}

// ─── Utilities ───
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}
