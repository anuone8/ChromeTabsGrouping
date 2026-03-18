// Background service worker for Tab Grouper
// Auto-groups tabs by domain as they are opened or navigated

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// ─── Domain color cache (keeps domain → color consistent per session) ───
const domainColorMap = {};
let colorCounter = 0;

function getColorForDomain(domain) {
  if (!domainColorMap[domain]) {
    domainColorMap[domain] = GROUP_COLORS[colorCounter % GROUP_COLORS.length];
    colorCounter++;
  }
  return domainColorMap[domain];
}

// ─── Auto-group setting (defaults to ON) ───
async function isAutoGroupEnabled() {
  const result = await chrome.storage.local.get({ autoGroup: true });
  return result.autoGroup;
}

async function setAutoGroup(enabled) {
  await chrome.storage.local.set({ autoGroup: enabled });
}

// ─── Core: assign a single tab to its domain group ───
async function autoGroupTab(tabId) {
  const enabled = await isAutoGroupEnabled();
  if (!enabled) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab was closed
  }

  // Skip internal chrome pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url === 'about:blank' || tab.url.startsWith('edge://')) {
    return;
  }

  const domain = extractDomain(tab.url);
  if (!domain || domain === 'other') return;

  const windowId = tab.windowId;

  // Check if a group with this domain title already exists in the same window
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const domainTitle = friendlyName(domain);
  const existingGroup = existingGroups.find(g => g.title === domainTitle);

  try {
    if (existingGroup) {
      // Add tab to existing group (only if not already in it)
      if (tab.groupId !== existingGroup.id) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroup.id });
      }
    } else {
      // Create a new group for this domain
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: domainTitle,
        color: getColorForDomain(domain),
        collapsed: false
      });
    }
  } catch (e) {
    console.warn('[Tab Grouper] Could not group tab:', e.message);
  }
}

// ─── Listeners for auto-grouping ───

// When a tab's URL changes (new navigation, redirect, page load)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Trigger on URL change
  if (changeInfo.url) {
    setTimeout(() => autoGroupTab(tabId), 300);
  }
  // Also trigger on 'complete' status for new tabs that started as about:blank
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://') && tab.url !== 'about:blank') {
    setTimeout(() => autoGroupTab(tabId), 300);
  }
});

// ─── On install/startup: group all existing ungrouped tabs ───
chrome.runtime.onInstalled.addListener(() => {
  groupAllExistingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  groupAllExistingTabs();
});

async function groupAllExistingTabs() {
  const enabled = await isAutoGroupEnabled();
  if (!enabled) return;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    if (tab.groupId === -1) {
      await autoGroupTab(tab.id);
    }
  }
}

// ─── Message handler for popup ───
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'getTabs': () => getAllTabs(),
    'getGroups': () => getExistingGroups(),
    'getAutoGroupStatus': () => isAutoGroupEnabled(),
    'setAutoGroup': () => setAutoGroup(message.enabled).then(() => {
      if (message.enabled) groupAllExistingTabs();
      return { success: true };
    }),
    'groupByDomain': () => groupTabsByDomain(),
    'groupSelected': () => groupSelectedTabs(message.tabIds, message.groupName, message.color),
    'ungroupAll': () => ungroupAllTabs(),
    'collapseAll': () => collapseAllGroups(),
    'expandAll': () => expandAllGroups(),
    'removeGroup': () => removeGroup(message.groupId),
  };

  const handler = handlers[message.action];
  if (handler) {
    handler().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ─── Tab data helpers ───
async function getAllTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(t => ({
    id: t.id,
    title: t.title,
    url: t.url,
    favIconUrl: t.favIconUrl,
    groupId: t.groupId,
    domain: extractDomain(t.url)
  }));
}

async function getExistingGroups() {
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  return groups.map(g => ({
    id: g.id,
    title: g.title,
    color: g.color,
    collapsed: g.collapsed
  }));
}

// ─── Domain utilities ───

// Returns the full hostname (minus www.), preserving subdomains
// e.g. "buildtools1.service-now.com", "mail.google.com"
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'other';
  }
}

// Maps full hostnames → friendly group names.
// Order matters: specific subdomain matches are checked FIRST,
// then root domain fallbacks.
function friendlyName(domain) {
  // 1) Exact subdomain matches (most specific → takes priority)
  const subdomainMap = {
    'mail.google.com':        'Gmail',
    'docs.google.com':        'Google Docs',
    'drive.google.com':       'Google Drive',
    'sheets.google.com':      'Google Sheets',
    'slides.google.com':      'Google Slides',
    'calendar.google.com':    'Google Calendar',
    'meet.google.com':        'Google Meet',
    'maps.google.com':        'Google Maps',
    'photos.google.com':      'Google Photos',
    'chat.google.com':        'Google Chat',
    'news.google.com':        'Google News',
    'translate.google.com':   'Google Translate',
    'colab.research.google.com': 'Google Colab',
    'web.whatsapp.com':       'WhatsApp',
    'web.telegram.org':       'Telegram',
    'gist.github.com':        'GitHub Gists',
  };
  if (subdomainMap[domain]) return subdomainMap[domain];

  // 2) ServiceNow instances — extract instance name from <instance>.service-now.com
  const snowMatch = domain.match(/^([^.]+)\.service-now\.com$/);
  if (snowMatch) {
    // Capitalize first letter of the instance name
    const inst = snowMatch[1];
    return inst.charAt(0).toUpperCase() + inst.slice(1);
  }

  // 3) Root domain fallbacks (strip subdomains for matching)
  const parts = domain.split('.');
  const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain;

  const rootMap = {
    'google.com':        'Google',
    'youtube.com':       'YouTube',
    'github.com':        'GitHub',
    'stackoverflow.com': 'Stack Overflow',
    'reddit.com':        'Reddit',
    'twitter.com':       'Twitter',
    'x.com':             'X',
    'facebook.com':      'Facebook',
    'instagram.com':     'Instagram',
    'linkedin.com':      'LinkedIn',
    'amazon.com':        'Amazon',
    'amazon.in':         'Amazon India',
    'netflix.com':       'Netflix',
    'slack.com':         'Slack',
    'notion.so':         'Notion',
    'figma.com':         'Figma',
    'medium.com':        'Medium',
    'wikipedia.org':     'Wikipedia',
    'servicenow.com':    'ServiceNow',
    'chatgpt.com':       'ChatGPT',
    'claude.ai':         'Claude',
    'whatsapp.com':      'WhatsApp',
    'discord.com':       'Discord',
    'twitch.tv':         'Twitch',
    'spotify.com':       'Spotify',
    'flipkart.com':      'Flipkart',
    'swiggy.com':        'Swiggy',
    'zomato.com':        'Zomato',
    'microsoft.com':     'Microsoft',
    'live.com':          'Microsoft',
    'outlook.com':       'Outlook',
    'apple.com':         'Apple',
    'stackoverflow.com': 'Stack Overflow',
    'npmjs.com':         'npm',
    'vercel.app':        'Vercel',
    'netlify.app':       'Netlify',
  };

  if (rootMap[rootDomain]) return rootMap[rootDomain];

  // 4) For unknown subdomains: use subdomain as group name if present
  //    e.g. "analytics.mycompany.com" → "Analytics"
  if (parts.length > 2) {
    const sub = parts[0];
    return sub.charAt(0).toUpperCase() + sub.slice(1);
  }

  // 5) Final fallback: capitalize the domain name portion
  const name = rootDomain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── Manual grouping actions ───
async function groupTabsByDomain() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const domainMap = {};

  for (const tab of tabs) {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    const domain = extractDomain(tab.url);
    if (!domainMap[domain]) domainMap[domain] = [];
    domainMap[domain].push(tab.id);
  }

  for (const [domain, tabIds] of Object.entries(domainMap)) {
    if (tabIds.length < 1) continue;
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: friendlyName(domain),
      color: getColorForDomain(domain),
      collapsed: false
    });
  }

  return { success: true };
}

async function groupSelectedTabs(tabIds, groupName, color) {
  if (!tabIds || tabIds.length === 0) return { success: false, error: 'No tabs selected' };
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, {
    title: groupName || 'Custom Group',
    color: color || 'blue',
    collapsed: false
  });
  return { success: true };
}

async function ungroupAllTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    if (tab.groupId !== -1) {
      await chrome.tabs.ungroup(tab.id);
    }
  }
  return { success: true };
}

async function collapseAllGroups() {
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  for (const group of groups) {
    await chrome.tabGroups.update(group.id, { collapsed: true });
  }
  return { success: true };
}

async function expandAllGroups() {
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  for (const group of groups) {
    await chrome.tabGroups.update(group.id, { collapsed: false });
  }
  return { success: true };
}

async function removeGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  for (const tab of tabs) {
    await chrome.tabs.ungroup(tab.id);
  }
  return { success: true };
}
