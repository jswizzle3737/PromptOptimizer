/**
 * PromptOptimizer Design System — Select
 * Accessible custom listbox. Replaces native <select>, which cannot be
 * styled consistently and renders differently on every OS.
 */

import { icon } from './icons.js';

/**
 * @param {object} cfg
 * @param {Array<{value:string,label:string,desc?:string,icon?:string,swatch?:string[],disabled?:boolean}>} cfg.options
 * @param {string} cfg.value
 * @param {(value:string)=>void} [cfg.onChange]
 * @param {string} [cfg.label]      Accessible name for the trigger
 * @param {'auto'|'up'|'down'} [cfg.placement]
 * @param {boolean} [cfg.showCheck]
 * @param {boolean} [cfg.compact]   Trigger shows only the swatch/icon; the name moves to the accessible label.
 * @returns {{ element: HTMLElement, setValue:(v:string, opts?)=>void, getValue:()=>string, setOptions:(o:Array)=>void, destroy:()=>void }}
 */
export function createSelect({
  options = [],
  value = '',
  onChange,
  label = '',
  placement = 'auto',
  showCheck = true,
  compact = false
} = {}) {
  const el = document.createElement('div');
  el.className = compact ? 'pc-select pc-select--compact' : 'pc-select';
  el.dataset.value = value;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'pc-select__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (label) trigger.setAttribute('aria-label', label);

  const valueEl = document.createElement('span');
  valueEl.className = 'pc-select__value';
  trigger.appendChild(valueEl);
  trigger.insertAdjacentHTML('beforeend', icon('chevronDown', { size: 14, className: 'pc-select__chevron' }));

  const menu = document.createElement('div');
  menu.className = 'pc-select__menu';
  menu.setAttribute('role', 'listbox');
  if (label) menu.setAttribute('aria-label', label);

  el.append(trigger, menu);

  let items = options.slice();
  let current = value;
  let open = false;
  let highlight = 0;
  let optionEls = [];

  function optionMarkup(opt) {
    const selected = String(opt.value === current);
    const visual = opt.swatch
      ? `<span class="pc-swatch" aria-hidden="true">${opt.swatch.map(c => `<span class="pc-swatch__chip" style="background:${c}"></span>`).join('')}</span>`
      : opt.icon
        ? `<span class="pc-select__option-icon">${icon(opt.icon, { size: 14 })}</span>`
        : '';
    return `
      ${visual}
      <span class="pc-select__option-body">
        ${escapeHtml(opt.label)}
        ${opt.desc ? `<span class="pc-select__option-desc">${escapeHtml(opt.desc)}</span>` : ''}
      </span>
      ${showCheck ? icon('check', { size: 14, className: 'pc-select__check' }) : ''}
    `;
  }

  function buildMenu() {
    menu.innerHTML = '';
    optionEls = items.map((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-select__option';
      btn.setAttribute('role', 'option');
      btn.dataset.value = opt.value;
      btn.dataset.index = String(i);
      btn.setAttribute('aria-selected', String(opt.value === current));
      if (opt.disabled) btn.setAttribute('aria-disabled', 'true');
      btn.innerHTML = optionMarkup(opt);

      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (opt.disabled) return;
        setValue(opt.value);
        setOpen(false);
        trigger.focus();
      });
      btn.addEventListener('mouseenter', () => {
        highlight = i;
        paintHighlight();
      });
      menu.appendChild(btn);
      return btn;
    });
  }

  function renderTrigger() {
    const opt = items.find(o => o.value === current);
    const visual = opt?.swatch
      ? `<span class="pc-swatch" aria-hidden="true">${opt.swatch.map(c => `<span class="pc-swatch__chip" style="background:${c}"></span>`).join('')}</span>`
      : opt?.icon
        ? icon(opt.icon, { size: 14 })
        : '';
    valueEl.innerHTML = `${visual}<span class="pc-select__label">${opt ? escapeHtml(opt.label) : ''}</span>`;
    // With the text hidden, the accessible name must still say what is chosen.
    if (compact && label) trigger.setAttribute('aria-label', `${label}: ${opt ? opt.label : ''}`);
  }

  function setValue(next, { silent = false } = {}) {
    current = next;
    el.dataset.value = next;
    optionEls.forEach(o => o.setAttribute('aria-selected', String(o.dataset.value === current)));
    renderTrigger();
    if (!silent && typeof onChange === 'function') onChange(current);
  }

  function setOptions(next) {
    items = next.slice();
    buildMenu();
    renderTrigger();
  }

  function paintHighlight() {
    optionEls.forEach((o, i) => o.classList.toggle('is-highlighted', i === highlight));
  }

  /* The menu is positioned FIXED against the viewport while open. Inside
     scrollable containers (the in-page modal body has overflow-y: auto) an
     absolutely-positioned menu gets clipped to a sliver of its options, and
     overflow: hidden on the modal frame cuts the rest. A fixed menu escapes
     both, follows the trigger on scroll, and clamps to the real space the
     viewport has — flipping up or down as room dictates. */
  function positionFixedMenu() {
    const rect = trigger.getBoundingClientRect();
    const MARGIN = 8;
    /* Wide enough that a label and its description sit on one line; at
       trigger width they wrapped and doubled every row's height. */
    const width = Math.min(window.innerWidth - 2 * MARGIN, Math.max(rect.width, compact ? 248 : 232));

    /* The stylesheet anchors the menu absolutely (right: 0, min-width: 100%,
       and bottom: 100% for drop-up). Against the viewport those offsets
       collapsed the menu to a 10px strip as wide as the page, so every
       option was clipped. Pin the box explicitly, and size it before
       measuring so the natural height is the height at this width. */
    menu.style.position = 'fixed';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.minWidth = '0';
    menu.style.width = `${Math.round(width)}px`;
    menu.style.maxHeight = 'none';
    const naturalH = menu.offsetHeight || 0;   // border box: max-height includes the border
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;

    /* Open toward the preferred side only if every option fits there; else the
       side where they all fit; else the roomier side. Opening into a short side
       used to leave a 120px menu showing three options, scrolled to the
       selected one, so the rest looked missing. */
    const fitsUp = spaceAbove >= naturalH;
    const fitsDown = spaceBelow >= naturalH;
    let openUp;
    if (placement === 'up') openUp = fitsUp || (!fitsDown && spaceAbove >= spaceBelow);
    else openUp = !fitsDown && (fitsUp || spaceAbove > spaceBelow);

    const maxH = Math.max(96, Math.min(naturalH, openUp ? spaceAbove : spaceBelow));
    let left = compact ? rect.right - width : rect.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    const shownH = Math.min(naturalH, maxH);
    const top = openUp
      ? Math.max(MARGIN, rect.top - shownH - 4)
      : Math.min(window.innerHeight - MARGIN - shownH, rect.bottom + 4);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.maxHeight = `${Math.round(maxH)}px`;
    menu.classList.toggle('pc-select__menu--up', openUp);
  }

  function clearFixedMenu() {
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.minWidth = '';
    menu.style.width = '';
    menu.style.maxHeight = '';
  }

  /* While the menu is open, follow the trigger across any scroll (capture:
     the modal body's own scroll never reaches window otherwise) and close if
     the trigger leaves the viewport entirely. */
  const onViewportChange = () => {
    if (!open) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) { setOpen(false); return; }
    positionFixedMenu();
  };
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange);

  function setOpen(next) {
    open = next;
    menu.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      const idx = items.findIndex(o => o.value === current);
      highlight = idx >= 0 ? idx : 0;
      positionFixedMenu();
      paintHighlight();
      optionEls[highlight]?.scrollIntoView({ block: 'nearest' });
    } else {
      clearFixedMenu();
      paintHighlightClear();
    }
  }

  function paintHighlightClear() {
    optionEls.forEach(o => o.classList.remove('is-highlighted'));
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(!open);
  });

  trigger.addEventListener('keydown', e => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        highlight = (highlight + 1) % Math.max(1, optionEls.length);
        paintHighlight();
        optionEls[highlight]?.scrollIntoView({ block: 'nearest' });
        break;
      case 'ArrowUp':
        e.preventDefault();
        highlight = (highlight - 1 + optionEls.length) % Math.max(1, optionEls.length);
        paintHighlight();
        optionEls[highlight]?.scrollIntoView({ block: 'nearest' });
        break;
      case 'Home':
        e.preventDefault();
        highlight = 0;
        paintHighlight();
        break;
      case 'End':
        e.preventDefault();
        highlight = optionEls.length - 1;
        paintHighlight();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        {
          const opt = items[highlight];
          if (opt && !opt.disabled) setValue(opt.value);
        }
        setOpen(false);
        break;
      case 'Escape':
        // Closes the listbox only; an enclosing dialog must not also close.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  });

  // Uses composedPath so the check survives Shadow DOM event retargeting.
  const onDocClick = e => {
    if (!open) return;
    if (e.composedPath && e.composedPath().includes(el)) return;
    if (el.contains(e.target)) return;
    setOpen(false);
  };
  document.addEventListener('click', onDocClick, true);

  buildMenu();
  renderTrigger();

  return {
    element: el,
    setValue,
    setOptions,
    getValue: () => current,
    destroy: () => {
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
    }
  };
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
