// Reviewed family definitions. Candidate anchors describe the original static
// census, while the selector below resolves the full app-owned mounted DOM.
const dom = (selector, attribute, from, to) => ({ selector, attribute, transitions: [{ from, to }] });
const request = operation => ({ request: { path: '/mcp', method: 'POST', operation } });
export const families = [
  { id: 'more-navigation', source: 'js/navigation.js:46', candidate: 'body:nth-of-type(1) > button:nth-of-type(1)', name: 'More', selector: '.app-shell-more-toggle',
    setup: (f, state) => { if (state) f.window.document.querySelector('.app-shell-more-toggle').click(); },
    observations: (f, state) => [dom('.app-shell-more-list', 'hidden', state ? null : '', state ? '' : null), dom('.app-shell-more-toggle', 'aria-expanded', String(!!state), String(!state))] },
  { id: 'theme', source: 'js/navigation.js:50', candidate: 'body:nth-of-type(1) > button:nth-of-type(1)', name: 'Dark mode', selector: '[data-pref="theme"]',
    observations: f => [dom('html', 'data-theme', f.window.document.documentElement.dataset.theme, f.window.document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')] },
  { id: 'color-assist', source: 'js/navigation.js:52', candidate: '#colorAssistButton', name: 'Color assist', selector: '#colorAssistButton',
    observations: f => [dom('html', 'data-color-assist', f.window.document.documentElement.dataset.colorAssist, f.window.document.documentElement.dataset.colorAssist === 'off' ? 'on' : 'off')] },
  { id: 'account-menu', source: 'js/navigation.js:53', candidate: '#selfAvatar', name: 'Account and settings', selector: '#selfAvatar',
    setup: (f, state) => { if (state) f.window.document.querySelector('#selfAvatar').click(); },
    observations: (f, state) => [dom('#accountMenu', 'hidden', state ? null : '', state ? '' : null), dom('#selfAvatar', 'aria-expanded', String(!!state), String(!state))] },
  { id: 'account-theme', source: 'js/navigation.js:57', candidate: '#accountTheme', name: 'Theme', selector: '#accountTheme',
    setup: f => f.window.document.querySelector('#selfAvatar').click(),
    observations: f => [dom('html', 'data-theme', f.window.document.documentElement.dataset.theme, f.window.document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')] },
  { id: 'open-profile', source: 'js/navigation.js:56', candidate: '#accountProfile', name: 'Profile', selector: '#accountProfile',
    setup: f => f.window.document.querySelector('#selfAvatar').click(),
    observations: () => [dom('.app-shell-profile[open]', '$presence', false, true)] },
  { id: 'close-profile', source: 'js/app-shell.js:45', candidate: 'body:nth-of-type(1) > button:nth-of-type(1)', name: 'Close profile', selector: '.app-shell-profile [aria-label="Close profile"]',
    setup: f => { f.window.document.querySelector('#selfAvatar').click(); f.window.document.querySelector('#accountProfile').click(); },
    observations: () => [dom('.app-shell-profile', '$presence', true, false)] },
  { id: 'open-doc', source: 'js/doc-presence.js:24', candidate: '#docOpen', name: 'Open Doc', selector: '#docOpen',
    observations: () => [dom('#docDetail', 'open', null, '')] },
  { id: 'close-doc', source: 'js/doc-presence.js:27', candidate: '#docClose', name: 'Close Doc', selector: '#docClose',
    setup: f => f.window.document.querySelector('#docOpen').click(), observations: () => [dom('#docDetail', 'open', '', null)] },
  { id: 'open-morning-brief', source: 'js/doc-presence.js:27', candidate: '#docMorning', name: 'Morning brief', selector: '#docMorning',
    setup: f => f.window.document.querySelector('#docOpen').click(), observations: () => [dom('#docMorningBrief', 'open', null, '')] },
  { id: 'doc-query', source: 'js/doc-command-bar.js:15', candidate: '#docCommandInput', name: 'Search anything or ask Doc', selector: '#docCommandInput',
    setup: f => f.window.document.querySelector('#docOpen').click(), observations: () => [dom('#docDetail .doc-detail-grid', 'hidden', null, '')] },
  { id: 'refresh-doc', source: 'js/doc-presence.js:29', candidate: '#docRefresh', name: 'Refresh Doc', selector: '#docRefresh',
    setup: f => f.window.document.querySelector('#docOpen').click(), observations: () => [request('list-doc-suggestions')] },
  { id: 'refresh-morning-brief', source: 'js/morning-brief.js:8', candidate: '#morningRefresh', name: 'Refresh morning brief', selector: '#morningRefresh',
    setup: f => f.window.document.querySelector('#docMorningBrief').showModal(), observations: () => [request('morning-brief')] },
  { id: 'refresh-workspace', source: 'js/app-layout.js:23', candidate: '#appSyncRefresh', name: 'Refresh workspace', selector: '#appSyncRefresh',
    observations: () => [request('deal-room-board')] },
  { id: 'close-morning-brief', source: 'js/morning-brief.js:8', candidate: '#morningClose', name: 'Dismiss morning brief', selector: '#morningClose',
    setup: (f, state) => { f.window.document.querySelector('#docMorningBrief').showModal(); if (state) f.window.document.querySelector('#morningTitle').textContent = 'Morning brief · ' + (f.actor === 'dell' ? 'Dell' : 'Joe'); },
    observations: () => [dom('#docMorningBrief', 'open', '', null)] },
  { id: 'close-workspace', source: 'js/app-layout.js:17', candidate: 'body:nth-of-type(1) > button:nth-of-type(1)', name: 'Close workspace', selector: '[data-layout-close="sidebar"]',
    setup: f => { if (f.window.document.querySelector('#appSidebarToggle').getAttribute('aria-expanded') !== 'true') f.window.document.querySelector('#appSidebarToggle').click(); },
    observations: () => [dom('#appSidebarToggle', 'aria-expanded', 'true', 'false')] },
  { id: 'workspace-sidebar', source: 'js/app-layout.js:18', candidate: '#appSidebarToggle', name: 'Workspace sidebar', selector: '#appSidebarToggle',
    setup: (f, state) => { if (state) f.window.document.querySelector('#appSidebarToggle').click(); },
    observations: f => { const from = f.window.document.querySelector('#appSidebarToggle').getAttribute('aria-expanded'); return [dom('#appSidebarToggle', 'aria-expanded', from, String(from !== 'true'))]; } },
  { id: 'today-sidebar', source: 'js/app-layout.js:18', candidate: '#appTodayToggle', name: 'Today sidebar', selector: '#appTodayToggle',
    setup: (f, state) => { if (state) f.window.document.querySelector('#appTodayToggle').click(); },
    observations: f => { const from = f.window.document.querySelector('#appTodayToggle').getAttribute('aria-expanded'); return [dom('#appTodayToggle', 'aria-expanded', from, String(from !== 'true'))]; } },
  { id: 'close-today', source: 'js/app-layout.js:19', candidate: 'body:nth-of-type(1) > button:nth-of-type(1)', name: 'Close Today', selector: '[data-layout-close="today"]',
    setup: f => { if (f.window.document.querySelector('#appTodayToggle').getAttribute('aria-expanded') !== 'true') f.window.document.querySelector('#appTodayToggle').click(); },
    observations: () => [dom('#appTodayToggle', 'aria-expanded', 'true', 'false')] },
  { id: 'close-sidebar-drawer', source: 'js/app-layout.js:20', candidate: '#appDrawerScrim', name: 'Close sidebar', selector: '#appDrawerScrim', phoneOnly: true,
    setup: (f, state) => f.window.document.querySelector(state ? '#appTodayToggle' : '#appSidebarToggle').click(),
    observations: f => [dom('#appLayout', 'data-drawer', f.window.document.querySelector('#appLayout').dataset.drawer, ''), dom('#appDrawerScrim', 'hidden', null, '')] },
  { id: 'close-call-mode', source: 'js/global-call-mode.js:11', candidate: '#callModeClose', name: 'Close Call Mode', selector: '#callModeClose',
    setup: f => f.window.document.querySelector('#callModeDialog').showModal(), observations: () => [dom('#callModeDialog', 'open', '', null)] },
];

// A review citation names the line that defines the reviewed control. It is
// wrong when that line no longer carries the control's own selector anchor,
// which is how a moved handler shows up even while its file digest is rebound.
const anchor = selector => {
  const simple = selector.match(/#[\w-]+|\[[\w-]+="[^"]*"\]|\.[\w-]+/g)?.at(-1) || '';
  if (simple.startsWith('#')) return `id="${simple.slice(1)}"`;
  if (simple.startsWith('[')) return simple.slice(1, -1);
  return simple.slice(1);
};
export function citationMismatches(controls, read) {
  const lines = new Map();
  const fileLines = file => {
    if (!lines.has(file)) { try { lines.set(file, read(file).split('\n')); } catch { lines.set(file, null); } }
    return lines.get(file);
  };
  const problems = [];
  const check = (who, family, source) => {
    const [, file, line] = source.match(/^([^:]+)(?::(\d+))?$/) || [];
    const text = file && fileLines(file);
    if (!text) return problems.push(`${who}: ${source} is not a source file`);
    if (file !== family.source.split(':')[0]) return problems.push(`${who}: ${source} is not in ${family.id}'s file ${family.source.split(':')[0]}`);
    if (line && !text[Number(line) - 1]?.includes(anchor(family.selector)))
      problems.push(`${who}: ${source} does not define ${family.selector}`);
  };
  for (const family of families) check(`family ${family.id}`, family, family.source);
  for (const row of controls) {
    const family = families.find(candidate => candidate.id === row.review.family);
    if (!family) problems.push(`${row.identity}: unknown family ${row.review.family}`);
    else check(row.identity, family, row.review.source);
  }
  return problems;
}
