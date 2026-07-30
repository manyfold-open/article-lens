// Page-owned form controls.
//
// A native <select> hands its open list to the operating system: that list cannot
// be styled, does not follow this page's language toggle, and looks nothing like
// the pixel office it sits beside. A native checkbox hands over its tick mark the
// same way — `accent-color` only tints an OS control, it does not replace it. So
// the two controls this page needs are rebuilt here out of plain buttons.
//
// They keep the native contract deliberately. Each upgraded element exposes a
// `value` (listbox) or `checked` (switch) property and emits a bubbling `change`
// event, so call sites read `event.target.value` and assign `element.checked`
// exactly as they did against the real elements.
(function (root) {
  'use strict';

  const openLists = new Set();

  function optionsOf(host) {
    return Array.from(host.querySelectorAll('[role="option"]'));
  }

  function labelFor(host, value) {
    const match = optionsOf(host).find(option => option.dataset.value === value);
    return match ? match.textContent : '';
  }

  function paintSelect(host) {
    const label = host.querySelector('[data-ui-select-label]');
    if (label) label.textContent = labelFor(host, host.dataset.value || '');
    for (const option of optionsOf(host)) {
      const selected = option.dataset.value === host.dataset.value;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', String(selected));
    }
  }

  function closeSelect(host) {
    const list = host.querySelector('[data-ui-select-list]');
    const button = host.querySelector('[data-ui-select-button]');
    if (list) list.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    host.classList.remove('open');
    openLists.delete(host);
  }

  function openSelect(host) {
    for (const other of Array.from(openLists)) if (other !== host) closeSelect(other);
    const list = host.querySelector('[data-ui-select-list]');
    const button = host.querySelector('[data-ui-select-button]');
    if (list) list.hidden = false;
    if (button) button.setAttribute('aria-expanded', 'true');
    host.classList.add('open');
    openLists.add(host);
    const current = optionsOf(host).find(option => option.dataset.value === host.dataset.value);
    (current || optionsOf(host)[0])?.focus();
  }

  function commit(host, value) {
    const changed = host.dataset.value !== value;
    host.dataset.value = value;
    paintSelect(host);
    closeSelect(host);
    host.querySelector('[data-ui-select-button]')?.focus();
    if (changed) host.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Arrow keys move through the list, Enter and Space take the focused option,
  // Escape abandons it. Without this the control would be mouse-only, which the
  // element it replaces never was.
  function onListKeydown(host, event) {
    const all = optionsOf(host);
    // The anchor falls back to the selected option, then to the first one. Focus
    // is not guaranteed to be on an option: the list can be opened by mouse, and a
    // window that does not have focus never moves activeElement at all. Without
    // the fallback, Enter would resolve to index -1 and quietly commit nothing.
    const focusedIndex = all.indexOf(document.activeElement);
    const index = focusedIndex >= 0
      ? focusedIndex
      : Math.max(0, all.findIndex(option => option.dataset.value === host.dataset.value));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown'
        ? Math.min(all.length - 1, index + 1)
        : Math.max(0, index - 1);
      all[next]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const focused = all[index];
      if (focused) commit(host, focused.dataset.value);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      closeSelect(host);
      if (event.key === 'Escape') {
        event.preventDefault();
        host.querySelector('[data-ui-select-button]')?.focus();
      }
    }
  }

  function upgradeSelect(host) {
    if (host.dataset.uiReady) return;
    host.dataset.uiReady = 'true';
    if (!host.dataset.value) host.dataset.value = optionsOf(host)[0]?.dataset.value || '';
    Object.defineProperty(host, 'value', {
      configurable: true,
      get() { return host.dataset.value || ''; },
      set(next) { commit(host, String(next)); },
    });
    const button = host.querySelector('[data-ui-select-button]');
    button?.addEventListener('click', () => {
      if (host.classList.contains('open')) closeSelect(host);
      else openSelect(host);
    });
    button?.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openSelect(host);
      }
    });
    for (const option of optionsOf(host)) {
      option.tabIndex = -1;
      option.addEventListener('click', () => commit(host, option.dataset.value));
    }
    host.querySelector('[data-ui-select-list]')
      ?.addEventListener('keydown', event => onListKeydown(host, event));
    paintSelect(host);
  }

  function paintSwitch(host) {
    const on = host.dataset.checked === 'true';
    host.setAttribute('aria-checked', String(on));
    host.classList.toggle('on', on);
  }

  function upgradeSwitch(host) {
    if (host.dataset.uiReady) return;
    host.dataset.uiReady = 'true';
    if (!host.dataset.checked) host.dataset.checked = 'false';
    Object.defineProperty(host, 'checked', {
      configurable: true,
      get() { return host.dataset.checked === 'true'; },
      // Assigning `checked` mirrors the native element: it updates the control
      // without emitting `change`, so a programmatic correction cannot re-enter
      // the handler that made it.
      set(next) { host.dataset.checked = next ? 'true' : 'false'; paintSwitch(host); },
    });
    host.addEventListener('click', () => {
      host.dataset.checked = host.dataset.checked === 'true' ? 'false' : 'true';
      paintSwitch(host);
      host.dispatchEvent(new Event('change', { bubbles: true }));
    });
    paintSwitch(host);
  }

  // ── Tooltips ───────────────────────────────────────────────────────────────
  // `title` is drawn by the OS: it appears after a delay the page cannot set, it
  // cannot be styled, and on a touch screen it never appears at all. Hints are
  // carried in `data-tip` instead and drawn here, on hover and on keyboard focus.
  function tipText(element) {
    return element.getAttribute('data-tip') || '';
  }

  function hideTip() {
    const tip = document.getElementById('ui-tip');
    if (tip) tip.hidden = true;
  }

  function showTip(element) {
    const tip = document.getElementById('ui-tip');
    const text = tipText(element);
    if (!tip || !text) return;
    tip.textContent = text;
    tip.hidden = false;
    const box = element.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const left = Math.max(6, Math.min(
      box.left + box.width / 2 - size.width / 2,
      document.documentElement.clientWidth - size.width - 6,
    ));
    // Above the element when there is room, below it when there is not.
    const above = box.top > size.height + 10;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(above ? box.top - size.height - 7 : box.bottom + 7)}px)`;
  }

  function tipTarget(node) {
    return node instanceof Element ? node.closest('[data-tip]') : null;
  }

  function bindTips() {
    document.addEventListener('pointerover', event => {
      const target = tipTarget(event.target);
      if (target) showTip(target);
      else hideTip();
    });
    document.addEventListener('pointerdown', hideTip);
    document.addEventListener('focusin', event => {
      const target = tipTarget(event.target);
      if (target) showTip(target);
      else hideTip();
    });
    document.addEventListener('focusout', hideTip);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTip(); });
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  function upgrade() {
    document.querySelectorAll('[data-ui-select]').forEach(upgradeSelect);
    document.querySelectorAll('[data-ui-switch]').forEach(upgradeSwitch);
  }

  // Option text is rewritten by the page's language toggle, so the closed
  // control's label has to be repainted after every flip.
  function refresh() {
    document.querySelectorAll('[data-ui-select]').forEach(paintSelect);
  }

  document.addEventListener('click', event => {
    for (const host of Array.from(openLists)) {
      if (!host.contains(event.target)) closeSelect(host);
    }
  });

  bindTips();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', upgrade);
  } else {
    upgrade();
  }

  root.UiControls = { upgrade, refresh, hideTip };
})(typeof window !== 'undefined' ? window : globalThis);
