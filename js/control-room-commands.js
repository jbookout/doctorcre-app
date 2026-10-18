import { escapeText } from './change-receipts.mjs';
import { ignoreKey } from './control-room-list.js';

const TAB_KEYS = { inbox: 'i', waiting: 'w', triage: 't', queue: 'q', views: 'v', boards: 'b',
  automations: 'u', connections: 'c', agents: 'a', 'system-map': 'm', sessions: 's' };
const LINK_COMMANDS = [
  ['Project progress', '#switch-project'], ['All repositories', '#switch-all'],
  ['Project activity', '#board-activity'], ['Automation list', '#panelAutomations a[href]'],
  ['Agent task board', '#panelModelRoom a[href]'],
];
const keysHtml = keys => keys.map(key => `<kbd>${escapeText(key)}</kbd>`).join(' ');

export function mountControlRoomCommands({ tabs, onEscape }) {
  const root = tabs.ownerDocument, win = root.defaultView;
  const trigger = root.getElementById('crCommandsOpen');
  const commands = [...tabs.querySelectorAll('[data-tab-key]')].map(tab => ({
    label: tab.querySelector('.cr-nav-label').textContent,
    keys: ['g', TAB_KEYS[tab.dataset.tabKey]],
    run: () => { tab.click(); tab.focus({ preventScroll: true }); },
  }));
  for (const [label, selector] of LINK_COMMANDS) {
    const link = root.querySelector(selector);
    if (link) commands.push({ label, keys: [], run: () => link.click() });
  }
  commands.push({ label: 'Keyboard shortcuts', keys: ['?'], run: () => open('shortcuts') });
  const dialog = root.createElement('dialog');
  dialog.id = 'crCommands';
  dialog.className = 'cr-command-dialog';
  dialog.setAttribute('aria-labelledby', 'crCommandsTitle');
  dialog.innerHTML = `<header class="cr-command-head"><h2 id="crCommandsTitle">Control Room commands</h2><button type="button" data-command-close aria-label="Close commands">×</button></header>
    <section data-command-search><label class="sr-only" for="crCommandInput">Find a command</label><input id="crCommandInput" type="search" placeholder="Jump to…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="crCommandResults" aria-expanded="true"><div id="crCommandResults" role="listbox" aria-label="Navigation commands"></div><p class="cr-command-empty" role="status" hidden>No commands match.</p></section>
    <section class="cr-shortcut-sheet" data-command-sheet hidden></section>
    <footer class="cr-command-footer"><span class="cr-keyboard-hint">${keysHtml(['↑', '↓'])} Select ${keysHtml(['Enter'])} Open</span><button type="button" data-command-help>Keyboard shortcuts</button></footer>`;
  root.body.append(dialog);
  const input = dialog.querySelector('input'), results = dialog.querySelector('[role="listbox"]');
  const search = dialog.querySelector('[data-command-search]'), sheet = dialog.querySelector('[data-command-sheet]');
  const help = dialog.querySelector('[data-command-help]');
  let filtered = commands, selected = 0, mode = 'commands', focusBefore = null, prefixTimer;
  const paint = () => {
    filtered = commands.filter(command => command.label.toLowerCase().includes(input.value.trim().toLowerCase()));
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    results.innerHTML = filtered.map((command, index) => `<div class="cr-command-row" id="cr-command-${index}" role="option" aria-label="${escapeText(command.keys[0] === 'g' ? `Go to ${command.label}` : command.label)}" aria-selected="${index === selected}" data-command-index="${index}"><span aria-hidden="true" class="cr-command-symbol">${command.keys[0] === 'g' ? '↗' : '·'}</span><span>${escapeText(command.label)}</span><span class="cr-keyboard-hint" aria-hidden="true">${keysHtml(command.keys)}</span></div>`).join('');
    dialog.querySelector('[role="status"]').hidden = filtered.length > 0;
    input.setAttribute('aria-expanded', String(filtered.length > 0));
    if (filtered.length) input.setAttribute('aria-activedescendant', `cr-command-${selected}`);
    else input.removeAttribute('aria-activedescendant');
    results.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  function open(nextMode = 'commands') {
    win.clearTimeout(prefixTimer); prefixTimer = null;
    mode = nextMode;
    search.hidden = mode !== 'commands'; sheet.hidden = mode !== 'shortcuts';
    root.getElementById('crCommandsTitle').textContent = mode === 'commands' ? 'Control Room commands' : 'Keyboard shortcuts';
    help.textContent = mode === 'commands' ? 'Keyboard shortcuts' : 'Back to commands';
    if (mode === 'commands') { input.value = ''; selected = 0; paint(); }
    else sheet.innerHTML = `<p>Use shortcuts outside text fields.</p><dl>${[
      ['Open command menu', ['⌘ / Ctrl', 'K']], ['Move selection', ['j', 'k', '↑', '↓']],
      ['Open selected detail', ['Enter']], ['Close menu or detail', ['Esc']],
      ...commands.filter(command => command.keys[0] === 'g').map(command => [command.label, command.keys]),
    ].map(([label, keys]) => `<div><dt>${escapeText(label)}</dt><dd>${keysHtml(keys)}</dd></div>`).join('')}</dl>`;
    if (!dialog.open) { focusBefore = root.activeElement; dialog.showModal(); }
    (mode === 'commands' ? input : dialog.querySelector('[data-command-close]')).focus();
  }
  const execute = command => {
    if (!command) return;
    if (command === commands.at(-1)) { open('shortcuts'); return; }
    dialog.close(); command.run(); focusBefore = root.activeElement;
  };
  trigger.addEventListener('click', () => open());
  dialog.querySelector('[data-command-close]').addEventListener('click', () => dialog.close());
  help.addEventListener('click', () => open(mode === 'commands' ? 'shortcuts' : 'commands'));
  dialog.addEventListener('close', () => { focusBefore?.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => {
    const row = event.target.closest('[data-command-index]');
    if (row) execute(filtered[Number(row.dataset.commandIndex)]);
    else if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button,input')].filter(node => node.checkVisibility() && !node.disabled);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  input.addEventListener('input', () => { selected = 0; paint(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); execute(filtered[selected]); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && filtered.length) {
      event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length; paint();
    }
  });
  const shortcut = event => {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    const otherModal = root.querySelector('dialog[open]');
    if (otherModal && otherModal !== dialog) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) { if (dialog.open) dialog.close(); else open(); }
      return;
    }
    if (dialog.open || ignoreKey(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (prefixTimer) {
      win.clearTimeout(prefixTimer); prefixTimer = null;
      const command = commands.find(command => command.keys[0] === 'g' && command.keys[1] === event.key);
      if (command) { event.preventDefault(); command.run(); return; }
    }
    if (event.key === 'g' && !event.repeat) {
      prefixTimer = win.setTimeout(() => { prefixTimer = null; }, 1000); return;
    }
    if (event.key === '?') { event.preventDefault(); open('shortcuts'); }
    else if (event.key === 'Escape' && onEscape()) { event.preventDefault(); event.stopImmediatePropagation(); }
    else if (event.key === 'j' || event.key === 'k') {
      const list = [...root.querySelectorAll('[role="tabpanel"] [role="listbox"]')].find(node => node.checkVisibility());
      if (!list || event.target === list) return;
      event.preventDefault();
      const hadSelection = Boolean(list.querySelector('[aria-selected="true"]'));
      list.focus({ preventScroll: true });
      if (hadSelection) list.dispatchEvent(new win.KeyboardEvent('keydown', { key: event.key, bubbles: true }));
    }
  };
  // Window capture owns Cmd-K before Doc's document listener. Cmd-D still opens Doc.
  win.addEventListener('keydown', shortcut, true);
  return { dispose() { win.clearTimeout(prefixTimer); win.removeEventListener('keydown', shortcut, true); dialog.remove(); } };
}
