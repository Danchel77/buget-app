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

function openCardContextMenu(e, id, table, amount) // без изменений

function closeCardContextMenu() // без изменений

function hideAllChartTooltips() // без изменений


// ==========================================
// 3. Custom DatePicker (Кастомный календарь)
// ==========================================

function setupCustomDatePickers() // без изменений

function openCustomDatePicker(inputEl) // без изменений

function closeCustomDatePicker() // без изменений

function renderCustomDatePicker() // без изменений

function applyCustomDate(d, m, y) // без изменений

function formatManualDateInput(val) // без изменений

function applyManualDateInput() // без изменений


// ==========================================
// 4. PDF Import (Модалка и загрузка)
// ==========================================

function openPdfInfoModal() // без изменений

function closePdfInfoModal() // без изменений

function triggerPdfFileInput() // без изменений

/**
 * ИСПРАВЛЕННАЯ ФУНКЦИЯ:
 * Оставлена только одна версия (вторая удалена).
 * Открывает информационную модалку, запоминая, 
 * что мы пришли из Мастера настройки (Wizard Step 2).
 */
function triggerPdfImportFromWizard() {
  window._returnToWizardStep = 2;
  openPdfInfoModal();
}


// ==========================================
// 5. Global Document Event Listeners
// ==========================================

/**
 * ИСПРАВЛЕННЫЙ СЛУШАТЕЛЬ КЛИКОВ:
 * Удален дублирующийся код, который вызывал баг "двойного переключения"
 * при выборе карточек. Теперь слушатель только закрывает меню и календарь.
 */
document.addEventListener('click', (e) => {
  // Закрытие контекстного меню при клике мимо
  if (activeContextCard && !e.target.closest('.context-menu-btn') && !e.target.closest('.context-menu')) {
    closeCardContextMenu();
  }
  
  // Закрытие DatePicker при клике мимо
  const picker = document.getElementById('custom-datepicker');
  if (picker && picker.style.display === 'flex') {
    if (!e.target.closest('.datepicker-content') && !e.target.closest('.date-input-wrap')) {
      closeCustomDatePicker();
    }
  }
});


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

window.openPdfInfoModal = openPdfInfoModal;
window.closePdfInfoModal = closePdfInfoModal;
window.triggerPdfFileInput = triggerPdfFileInput;
window.triggerPdfImportFromWizard = triggerPdfImportFromWizard;
