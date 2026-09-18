// ==========================================
// Variables & State
// ==========================================

// Мультиселект
let selectionMode = false;
let selectedItems = new Set();
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;

// Кастомный DatePicker
let activeDateInput = null;
let currentPickerDate = new Date();

// Контекстное меню
let activeContextCard = null;

// ==========================================
// 1. Selection Mode (Мультивыбор)
// ==========================================
function enableSelectionMode() {
  selectionMode = true;
  document.body.classList.add('selection-mode');

  let panel = document.getElementById('selection-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'selection-panel';
    panel.className = 'selection-panel';
    panel.innerHTML = `
      <div class="selection-panel__info">
        <span class="selection-panel__dot"></span>
        <span id="selected-count">Выбрано: 0</span>
      </div>
      <div class="selection-panel__actions">
        <button id="cancel-selection" type="button">Отмена</button>
        <button id="delete-selected" type="button">Удалить</button>
      </div>
    `;
    document.body.appendChild(panel);
  }
  panel.style.display = 'flex';
  document.getElementById('selected-count').textContent = `Выбрано: ${selectedItems.size}`;
  attachSelectionPanelDirectEvents();
}

function disableSelectionMode() {
  selectionMode = false;
  selectedItems.clear();
  document.body.classList.remove('selection-mode');
  const panel = document.getElementById('selection-panel');
  if (panel) panel.style.display = 'none';
  document.querySelectorAll('.card.selected').forEach(card => card.classList.remove('selected'));
  document.querySelectorAll('.select-checkbox').forEach(cb => cb.checked = false);
}

function toggleItemSelection(id, table) {
  const key = `${table}:${id}`;
  if (selectedItems.has(key)) {
    selectedItems.delete(key);
  } else {
    selectedItems.add(key);
  }
  
  const card = document.querySelector(`.card[data-id="${id}"][data-table="${table}"]`);
  if (card) {
    card.classList.toggle('selected', selectedItems.has(key));
    const checkbox = card.querySelector('.select-checkbox');
    if (checkbox) checkbox.checked = selectedItems.has(key);
  }
  
  const countEl = document.getElementById('selected-count');
  if (countEl) countEl.textContent = `Выбрано: ${selectedItems.size}`;
  
  if (selectedItems.size === 0 && selectionMode) {
    disableSelectionMode();
  }
}

async function deleteSelectedItems() {
  if (selectedItems.size === 0) return;
  showDialog('Удаление', `Удалить выбранные записи (${selectedItems.size})?`, true, async () => {
    showToast("Удаление...", false, true);
    try {
      const batch = db.batch();
      selectedItems.forEach(key => {
        const [table, id] = key.split(':');
        batch.delete(getUserCol(table).doc(id));
      });
      await batch.commit();
      disableSelectionMode();
      await fetchAllData();
      showToast("Выбранные записи удалены");
    } catch (e) {
      showToast("Ошибка удаления", true);
    }
  });
}

function attachSelectionPanelDirectEvents() {
  const cancelBtn = document.getElementById('cancel-selection');
  const deleteBtn = document.getElementById('delete-selected');
  if (!cancelBtn || !deleteBtn) return;

  cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cancelSelection(); };
  cancelBtn.ontouchend = (e) => { e.preventDefault(); e.stopPropagation(); cancelSelection(); };
  deleteBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); deleteSelectedItems(); };
  deleteBtn.ontouchend = (e) => { e.preventDefault(); e.stopPropagation(); deleteSelectedItems(); };
}

function cancelSelection() {
  longPressTriggered = false;
  suppressClick = false;
  disableSelectionMode();
}

function startLongPress(card) {
  longPressTriggered = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    
    // Снимаем возможное системное выделение текста в мобильном браузере
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }

    if (!selectionMode) enableSelectionMode();
    toggleItemSelection(card.dataset.id, card.dataset.table);
  }, 500);
}

function handleTouchStart(e) {
  // Касания по плавающей панели выбора и ее кнопкам не должны инициировать события карточек
  if (e.target.closest('#selection-panel')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  startLongPress(card);
}

function handleTouchEnd(e) {
  clearTimeout(longPressTimer);
  if (longPressTriggered) {
    e.preventDefault();
    longPressTriggered = false;
  }
}

function handleTouchMove(e) {
  clearTimeout(longPressTimer);
  longPressTriggered = false;
}

function handleMouseDown(e) {
  if (e.target.closest('#selection-panel')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  startLongPress(card);
}

function handleMouseUp(e) {
  clearTimeout(longPressTimer);
  longPressTriggered = false;
}

function handleMouseMove(e) {
  clearTimeout(longPressTimer);
}

// ==========================================
// 2. Context Menu (Контекстное меню)
// ==========================================
function openCardContextMenu(e, title, onEdit, onDelete) {
  if (selectionMode) {
    if (e) e.stopPropagation();
    const card = e ? (e.currentTarget || (e.target && e.target.closest('.card'))) : null;
    if (card) {
      toggleItemSelection(card.dataset.id, card.dataset.table);
    }
    return;
  }

  if (e) e.stopPropagation();
  const menu = document.getElementById('card-context-menu');
  const titleEl = document.getElementById('context-menu-title');
  const editBtn = document.getElementById('context-btn-edit');
  const deleteBtn = document.getElementById('context-btn-delete');
  if (!menu) return;

  const card = e ? (e.currentTarget || (e.target && e.target.closest('.card'))) : null;
  if (!card) return;

  // Тоггл: повторный клик по той же карточке закрывает меню
  if (activeContextCard === card && !menu.classList.contains('hidden')) {
    closeCardContextMenu();
    return;
  }
  activeContextCard = card;

  titleEl.innerText = title || 'Действия';
  editBtn.onclick = () => { closeCardContextMenu(); onEdit(); };
  deleteBtn.onclick = () => { closeCardContextMenu(); onDelete(); };

  const rect = card.getBoundingClientRect();
  menu.classList.remove('hidden');

  const menuHeight = 110;
  const menuWidth = 190;
  const spaceBelow = window.innerHeight - rect.bottom;

  let top = (spaceBelow < menuHeight + 20) ? (rect.top - menuHeight - 4) : (rect.bottom + 4);
  let left = Math.min(window.innerWidth - menuWidth - 16, Math.max(16, rect.right - menuWidth));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  if (typeof lucide !== 'undefined') lucide.createIcons({ root: menu });
}

function closeCardContextMenu() {
  const menu = document.getElementById('card-context-menu');
  if (menu) menu.classList.add('hidden');
  activeContextCard = null;
}

// Скрытие тултипов графиков при клике в пустое место страницы или скролле
function hideAllChartTooltips(e) {
  const isTargetInside = (selector) => e && e.target && e.target.closest(selector);

  // 1. График брокера
  if (brokerChartObj && !isTargetInside('#brokerChart') && brokerChartObj.tooltip && brokerChartObj.tooltip.getActiveElements().length > 0) {
    brokerChartObj.setActiveElements([]);
    brokerChartObj.tooltip.setActiveElements([], { x: 0, y: 0 });
    brokerChartObj.update('none');
    const balEl = document.getElementById('broker-balance');
    if (balEl && Cache?.broker) balEl.innerText = formatMoney(Cache.broker.balance);
  }

  // 2. Столбчатый график динамики трат
  if (monthlyChartObj && !isTargetInside('#monthlyExpensesChart') && monthlyChartObj.getActiveElements().length > 0) {
    monthlyChartObj.setActiveElements([]);
    monthlyChartObj.tooltip.setActiveElements([], { x: 0, y: 0 });
    monthlyChartObj.update();
  }

  // 3. Круговая диаграмма структуры категорий
  if (categoryChartObj && !isTargetInside('#categoryExpensesChart') && categoryChartObj.getActiveElements().length > 0) {
    categoryChartObj.setActiveElements([]);
    categoryChartObj.tooltip.setActiveElements([], { x: 0, y: 0 });
    categoryChartObj.update();
  }
}

// ==========================================
// 3. Custom DatePicker (Кастомный календарь)
// ==========================================
function setupCustomDatePickers() {
  document.querySelectorAll('input[type="date"]').forEach(input => {
    input.readOnly = true;
    input.setAttribute('inputmode', 'none');
    input.style.cursor = 'pointer';
  });
}

function openCustomDatePicker(inputEl) {
  activeDateInput = inputEl;
  const picker = document.getElementById('custom-datepicker');
  if (!picker) return;

  const currentVal = inputEl.value ? new Date(inputEl.value) : new Date();
  currentPickerDate = isNaN(currentVal.getTime()) ? new Date() : currentVal;

  renderCustomDatePicker();

  // Предзаполняем поле ручного ввода текущей датой
  const manualInput = document.getElementById('datepicker-manual-input');
  if (manualInput) {
    const yyyy = currentPickerDate.getFullYear();
    const mm = String(currentPickerDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentPickerDate.getDate()).padStart(2, '0');
    manualInput.value = `${dd}.${mm}.${yyyy}`;
    manualInput.classList.remove('border-[#FF453A]');
  }

  // Позиционируем прямо под полем (или над ним, если снизу нет места)
  const rect = inputEl.getBoundingClientRect();
  picker.classList.remove('hidden');

  const spaceBelow = window.innerHeight - rect.bottom;
  let top = (spaceBelow < 330) ? (rect.top - 335) : (rect.bottom + 6);
  let left = Math.min(window.innerWidth - 295, Math.max(12, rect.left));

  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeCustomDatePicker() {
  const picker = document.getElementById('custom-datepicker');
  if (picker) picker.classList.add('hidden');
  activeDateInput = null;
}

function renderCustomDatePicker() {
  const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const label = document.getElementById('datepicker-month-year');
  const grid = document.getElementById('datepicker-days-grid');
  if (!label || !grid) return;

  const year = currentPickerDate.getFullYear();
  const month = currentPickerDate.getMonth();
  label.innerText = `${monthNames[month]} ${year}`;

  const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < firstDayIndex; i++) {
    html += `<span></span>`;
  }

  const selectedDateStr = activeDateInput ? activeDateInput.value : '';

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = String(day).padStart(2, '0');
    const monthStr = String(month + 1).padStart(2, '0');
    const fullDate = `${year}-${monthStr}-${dayStr}`;
    const isSelected = selectedDateStr === fullDate;

    html += `
      <button type="button" onclick="applyCustomDate('${fullDate}')" class="h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer font-medium ${isSelected ? 'bg-[#6C5DD3] text-white font-bold' : 'hover:bg-[#212430] text-gray-300'}">
        ${day}
      </button>
    `;
  }
  grid.innerHTML = html;
}

function applyCustomDate(dateStr) {
  if (activeDateInput) {
    activeDateInput.value = dateStr;
    activeDateInput.dispatchEvent(new Event('change'));
  }
  closeCustomDatePicker();
}

function formatManualDateInput(el) {
  let val = el.value.replace(/[^\d]/g, '');
  if (val.length > 8) val = val.slice(0, 8);

  let formatted = '';
  if (val.length > 4) {
    formatted = val.slice(0, 2) + '.' + val.slice(2, 4) + '.' + val.slice(4);
  } else if (val.length > 2) {
    formatted = val.slice(0, 2) + '.' + val.slice(2);
  } else {
    formatted = val;
  }
  el.value = formatted;

  // Если дата введена полностью, сразу синхронизируем сетку календаря
  if (formatted.length === 10) {
    const iso = parseManualDate(formatted);
    if (iso) {
      currentPickerDate = new Date(iso);
      renderCustomDatePicker();
    }
  }
}

function applyManualDateInput() {
  const manualInput = document.getElementById('datepicker-manual-input');
  if (!manualInput) return;

  const iso = parseManualDate(manualInput.value);
  if (!iso) {
    manualInput.classList.add('border-[#FF453A]');
    showToast('Неверная дата (формат ДД.ММ.ГГГГ)', true);
    setTimeout(() => manualInput.classList.remove('border-[#FF453A]'), 2000);
    return;
  }

  applyCustomDate(iso);
}

function handleManualDateKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyManualDateInput();
  }
}

function parseManualDate(str) {
  if (!str) return null;
  const clean = str.trim().replace(/[^\d.]/g, '');
  const parts = clean.split('.').filter(Boolean);
  const now = new Date();
  let day, month, year;

  if (parts.length === 3) {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
  } else if (parts.length === 2) {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = currentPickerDate.getFullYear() || now.getFullYear();
  } else if (parts.length === 1 && clean.length <= 2) {
    day = parseInt(parts[0], 10);
    month = (currentPickerDate.getMonth() + 1) || (now.getMonth() + 1);
    year = currentPickerDate.getFullYear() || now.getFullYear();
  } else if (clean.length === 8) {
    day = parseInt(clean.slice(0, 2), 10);
    month = parseInt(clean.slice(2, 4), 10);
    year = parseInt(clean.slice(4, 8), 10);
  } else {
    return null;
  }

  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;

  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;

  const yyyy = String(year);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}`;
}

function changeCustomDatePickerMonth(delta) {
  currentPickerDate.setMonth(currentPickerDate.getMonth() + delta);
  renderCustomDatePicker();
}

function selectCustomDatePickerToday() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  if (activeDateInput) {
    activeDateInput.value = `${yyyy}-${mm}-${dd}`;
    activeDateInput.dispatchEvent(new Event('change'));
  }
  closeCustomDatePicker();
}

// ==========================================
// 4. PDF Import (Модалка и загрузка)
// ==========================================
// Управление информационным окном импорта PDF
function openPdfInfoModal() {
  const dlg = document.getElementById('pdf-info-dialog');
  if (dlg) {
    dlg.classList.remove('hidden');
    if (typeof renderBankIcons === 'function') renderBankIcons();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function closePdfInfoModal() {
  const dlg = document.getElementById('pdf-info-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function triggerPdfFileInput() {
  closePdfInfoModal();
  const fileInput = document.getElementById('pdf-file-input');
  if (fileInput) fileInput.click();
}

function triggerPdfImportFromWizard() {
  window._returnToWizardStep = 2;
  openPdfInfoModal();
}

// ==========================================
// 5. Global Document Event Listeners
// ==========================================

// Инициализация кастомных дейтпикеров
document.addEventListener('DOMContentLoaded', setupCustomDatePickers);
setTimeout(setupCustomDatePickers, 500);

// При скролле страницы скрываются меню, календарь и всплывающие тултипы
window.addEventListener('scroll', () => {
  closeCardContextMenu();
  closeCustomDatePicker();
  hideAllChartTooltips();
}, { passive: true, capture: true });

// Перехват нативного календаря Android / iOS (Capture phase)
document.addEventListener('click', (e) => {
  const dateInput = e.target.closest('input[type="date"]');
  if (dateInput) {
    e.preventDefault();
    e.stopPropagation();
    dateInput.readOnly = true;
    dateInput.setAttribute('inputmode', 'none');
    dateInput.blur();
    openCustomDatePicker(dateInput);
  }
}, true);

document.addEventListener('pointerdown', (e) => {
  const dateInput = e.target.closest('input[type="date"]');
  if (dateInput) {
    dateInput.readOnly = true;
    dateInput.setAttribute('inputmode', 'none');
  }
}, true);

// Глобальный клик: мультиселект, закрытие меню и тултипов
document.addEventListener('click', (e) => {
  // 1. Кнопки плавающей панели мультивыбора
  if (e.target.id === 'cancel-selection' || e.target.closest('#cancel-selection')) {
    e.stopPropagation();
    cancelSelection();
    return;
  }
  if (e.target.id === 'delete-selected' || e.target.closest('#delete-selected')) {
    e.stopPropagation();
    deleteSelectedItems();
    return;
  }

  // 2. Игнорируем «фантомный» клик сразу после срабатывания долгого нажатия
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  // 3. Выбор карточек при активном режиме мультиселекта
  if (selectionMode) {
    const card = e.target.closest('.card');
    if (card) {
      e.preventDefault();
      e.stopPropagation();
      toggleItemSelection(card.dataset.id, card.dataset.table);
      return;
    }
  }

  // 4. Закрытие контекстного мини-меню карточки при клике мимо
  if (activeContextCard && !e.target.closest('#card-context-menu') && !e.target.closest('.context-menu-btn')) {
    closeCardContextMenu();
  }

  // 5. Закрытие DatePicker при клике вне его
  const picker = document.getElementById('custom-datepicker');
  if (picker && !picker.classList.contains('hidden')) {
    if (!e.target.closest('#custom-datepicker') && !e.target.closest('input[type="date"]')) {
      closeCustomDatePicker();
    }
  }

  // 6. Закрытие тултипов на графиках
  if (typeof hideAllChartTooltips === 'function') {
    hideAllChartTooltips(e);
  }

  // 7. Кнопки вызова категорий (если кликнули по ним)
  if (e.target.classList.contains('manage-categories-btn')) {
    if (typeof showManageCategoriesDialog === 'function') showManageCategoriesDialog();
    return;
  }
  if (e.target.classList.contains('add-category-btn')) {
    const row = e.target.closest('.tx-item');
    if (row && typeof showAddCategoryDialog === 'function') {
      const type = row.querySelector('.tx-type:checked')?.value || 'Расход';
      const select = row.querySelector('.tx-category');
      showAddCategoryDialog(type, select);
    }
    return;
  }
});

// Слушатели долгого нажатия и мыши для мультиселекта
document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
document.addEventListener('mousemove', handleMouseMove);

// ==========================================
// Global Scope Exports
// ==========================================
window.enableSelectionMode = enableSelectionMode;
window.disableSelectionMode = disableSelectionMode;
window.toggleItemSelection = toggleItemSelection;
window.deleteSelectedItems = deleteSelectedItems;
window.cancelSelection = cancelSelection;
window.startLongPress = startLongPress;
window.handleTouchStart = handleTouchStart;
window.handleTouchEnd = handleTouchEnd;
window.handleTouchMove = handleTouchMove;

window.openCardContextMenu = openCardContextMenu;
window.closeCardContextMenu = closeCardContextMenu;
window.hideAllChartTooltips = hideAllChartTooltips;

window.setupCustomDatePickers = setupCustomDatePickers;
window.openCustomDatePicker = openCustomDatePicker;
window.closeCustomDatePicker = closeCustomDatePicker;
window.renderCustomDatePicker = renderCustomDatePicker;
window.applyCustomDate = applyCustomDate;
window.formatManualDateInput = formatManualDateInput;
window.applyManualDateInput = applyManualDateInput;
window.handleManualDateKeydown = handleManualDateKeydown;
window.changeCustomDatePickerMonth = changeCustomDatePickerMonth;
window.selectCustomDatePickerToday = selectCustomDatePickerToday;

window.openPdfInfoModal = openPdfInfoModal;
window.closePdfInfoModal = closePdfInfoModal;
window.triggerPdfFileInput = triggerPdfFileInput;
window.triggerPdfImportFromWizard = triggerPdfImportFromWizard;
