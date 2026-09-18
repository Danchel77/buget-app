let Cache = null;
let brokerChartObj = null;
let monthlyChartObj = null;
let categoryChartObj = null;

let currentAuthMode = 'login'; // 'login' или 'register'

let selectionMode = false;
let selectedTxIds = new Set();


// Превращает никнейм в безопасный виртуальный email для Firebase
function normalizeAuthEmail(input) {
  const clean = input.trim().toLowerCase();
  // Если пользователь ввел реальную почту с @ — оставляем как есть
  if (clean.includes('@')) {
    return clean;
  }
  // Иначе отсекаем спецсимволы и создаем виртуальный email @budget.local
  const safeNickname = clean.replace(/[^a-z0-9._-]/g, '');
  return `${safeNickname || 'user'}@budget.local`;
}

// Показываем экран загрузки сразу при старте
document.getElementById('loading-screen').classList.remove('hidden');

auth.onAuthStateChanged(async user => {
  document.getElementById('loading-screen').classList.add('hidden');
  
  if (user) {
    document.getElementById('login-screen').classList.add('hidden');
    switchTab('budget');

    // Обновляем никнейм в шапке
    const nameEl = document.getElementById('header-user-name');
    if (nameEl) {
      const name = user.displayName || (user.email?.includes('@budget.local') ? user.email.replace('@budget.local', '') : user.email?.split('@')[0]) || 'Профиль';
      nameEl.textContent = name;
    }

    await initNewUserIfNeeded(user);
    await loadUserSettings(user);
    fetchAllData();
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

function processTransactions(txs) {
  const grouped = {};
  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  txs.forEach(tx => {
    const txDate = tx.date ? new Date(tx.date) : new Date();
    const key = formatDateStr(tx.date, 'yyyy-MM');
    if (!grouped[key]) {
      grouped[key] = {
        id: key,
        label: months[txDate.getMonth()] + ' ' + txDate.getFullYear(),
        income: 0,
        expense: 0,
        items: []
      };
    }
    const amount = parseFloat(tx.amount) || 0;
    if (tx.type === 'Расход') grouped[key].expense += amount;
    else if (tx.type === 'Доход') grouped[key].income += amount;
    grouped[key].items.push({
      id: tx.id,
      type: tx.type,
      category: tx.category,
      amount,
      comment: tx.comment || '',
      formattedDate: formatDateStr(tx.date, 'dd.MM.yyyy'),
      rawDate: tx.date,
      timestamp: txDate.getTime()
    });
  });
  return Object.values(grouped)
    .sort((a, b) => b.id.localeCompare(a.id))
    .map(m => {
      m.items.sort((a, b) => b.timestamp - a.timestamp);
      return m;
    });
}

function processCategories(cats) {
  const defaultExpense = [
    { name: 'Продукты', icon: 'shopping-cart' },
    { name: 'Кафе и рестораны', icon: 'utensils' },
    { name: 'Маркетплейсы', icon: 'shopping-bag' },
    { name: 'Транспорт', icon: 'car' },
    { name: 'Жилье', icon: 'home' },
    { name: 'Одежда', icon: 'shirt' },
    { name: 'Здоровье', icon: 'heart-pulse' },
    { name: 'Развлечения', icon: 'gamepad-2' },
    { name: 'Другое', icon: 'package' }
  ];
  const defaultIncome = [
    { name: 'Зарплата', icon: 'wallet' },
    { name: 'Возврат', icon: 'undo-2' },
    { name: 'Кэшбек', icon: 'coins' },
    { name: 'Другое', icon: 'package' }
  ];

  const expense = [...defaultExpense];
  const income = [...defaultIncome];
  cats.forEach(c => {
    let rawIcon = c.icon && c.icon.length < 5 ? 'tag' : c.icon;
    if (c.type === 'Расход') { if (!expense.some(item => item.name === c.name)) expense.push({ name: c.name, icon: rawIcon || 'tag' }); } 
    else if (c.type === 'Доход') { if (!income.push({ name: c.name, icon: rawIcon || 'tag' })) income.push({ name: c.name, icon: rawIcon || 'tag' }); }
  });
  return { expense, income };
}

function showAddCategoryDialog(type, selectEl) {
  currentCategoryType = type;
  currentCategorySelect = selectEl;
  selectedCategoryIcon = 'package';
  document.getElementById('category-dialog-title').innerText = `Новая категория (${type})`;
  document.getElementById('category-name-input').value = '';
  renderIconGrid();
  document.getElementById('category-dialog').classList.remove('hidden');
}

function renderIconGrid() {
  const grid = document.getElementById('category-icon-grid');
  
  // Вставляем векторные иконки через i
  grid.innerHTML = availableIcons.map(icon => `
    <button type="button" class="icon-option flex items-center justify-center h-[42px] rounded-xl transition-all border ${icon === selectedCategoryIcon ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] border-[#6C5DD3]/30 scale-105 shadow-sm' : 'bg-[#181B24] border-[rgba(255,255,255,0.06)] text-[#848D99] hover:bg-[#212430]'}" data-icon="${icon}">
      <i data-lucide="${icon}" class="w-5 h-5"></i>
    </button>
  `).join('');

  // Заставляем Lucide нарисовать векторы в добавленном HTML
  if(typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Обновляем логику выбора иконки (изменение цветов Tailwind при тапе)
  grid.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategoryIcon = btn.dataset.icon;
      
      // Сбрасываем все кнопки в неактивное состояние
      grid.querySelectorAll('.icon-option').forEach(b => {
         b.classList.remove('bg-[#6C5DD3]/15', 'text-[#6C5DD3]', 'border-[#6C5DD3]/30', 'scale-105', 'shadow-sm');
         b.classList.add('bg-[#181B24]', 'border-[rgba(255,255,255,0.06)]', 'text-[#848D99]');
      });

      // Делаем нажатую кнопку активной
      btn.classList.remove('bg-[#181B24]', 'border-[rgba(255,255,255,0.06)]', 'text-[#848D99]');
      btn.classList.add('bg-[#6C5DD3]/15', 'text-[#6C5DD3]', 'border-[#6C5DD3]/30', 'scale-105', 'shadow-sm');
    });
  });
}

document.getElementById('category-cancel-btn').addEventListener('click', () => {
  document.getElementById('category-dialog').classList.add('hidden');
});

document.getElementById('category-save-btn').addEventListener('click', async () => {
  const name = document.getElementById('category-name-input').value.trim();
  if (!name) {
    showToast('Введите название', true);
    return;
  }
  try {
    await getUserCol('Categories').add({ name, type: currentCategoryType, icon: selectedCategoryIcon });
    const arr = currentCategoryType === 'Доход' ? Cache.categories.income : Cache.categories.expense;
    arr.push({ name, icon: selectedCategoryIcon });
    updateCategorySelect(currentCategorySelect, currentCategoryType);
    document.getElementById('category-dialog').classList.add('hidden');
  } catch (e) {
    showToast('Ошибка', true);
  }
});

function showManageCategoriesDialog() {
  renderManageCategories();
  document.getElementById('manage-categories-dialog').classList.remove('hidden');
}

const DEFAULT_SYSTEM_CATEGORIES = [
  'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье',
  'Одежда', 'Здоровье', 'Развлечения', 'Другое', 'Зарплата', 'Возврат', 'Кэшбек'
];

function renderManageCategories() {
  const container = document.getElementById('categories-list-container');
  let html = `<p class="text-[11px] uppercase tracking-wider text-gray-500 font-bold mb-2">Расходы</p>`;
  Cache.categories.expense.forEach(cat => {
    const isDefault = DEFAULT_SYSTEM_CATEGORIES.includes(cat.name);
    const iconName = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    html += `
      <div class="flex justify-between items-center py-2.5 border-b border-[rgba(255,255,255,0.06)]">
        <span class="flex items-center gap-2.5 text-sm font-medium text-gray-200">
          <i data-lucide="${iconName}" class="w-4 h-4 text-[#848D99]"></i>
          ${escapeHtml(cat.name)}
        </span>
        ${!isDefault ? `<button type="button" class="text-gray-500 hover:text-[#FF453A] p-1 cursor-pointer transition-colors" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Расход')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
      </div>`;
  });
  html += `<p class="text-[11px] uppercase tracking-wider text-gray-500 font-bold mt-5 mb-2">Доходы</p>`;
  Cache.categories.income.forEach(cat => {
    const isDefault = DEFAULT_SYSTEM_CATEGORIES.includes(cat.name);
    const iconName = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    html += `
      <div class="flex justify-between items-center py-2.5 border-b border-[rgba(255,255,255,0.06)]">
        <span class="flex items-center gap-2.5 text-sm font-medium text-gray-200">
          <i data-lucide="${iconName}" class="w-4 h-4 text-[#848D99]"></i>
          ${escapeHtml(cat.name)}
        </span>
        ${!isDefault ? `<button type="button" class="text-gray-500 hover:text-[#FF453A] p-1 cursor-pointer transition-colors" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Доход')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
      </div>`;
  });
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function deleteCategory(name, type) {
  showDialog('Удаление', `Удалить категорию "${name}"?`, true, async () => {
    try {
      // Найти документ по name и type
      const snapshot = await getUserCol('Categories')
        .where('name', '==', name)
        .where('type', '==', type)
        .get();
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();

      // Обновить Cache
      const arr = type === 'Доход' ? Cache.categories.income : Cache.categories.expense;
      const index = arr.findIndex(c => c.name === name);
      if (index !== -1) arr.splice(index, 1);
      renderManageCategories();
      // Обновить все селекты категорий на странице
      document.querySelectorAll('.tx-category').forEach(select => {
        const row = select.closest('.tx-item');
        if (row) {
          const rowType = row.querySelector('.tx-type:checked').value;
          if (rowType === type) updateCategorySelect(select, type);
        }
      });
      showToast('Категория удалена');
    } catch (e) {
      showToast('Ошибка', true);
    }
  });
}

  document.getElementById('close-manage-categories').addEventListener('click', () => {
  document.getElementById('manage-categories-dialog').classList.add('hidden');
  
  // Возврат в кабинет, если открывали оттуда
  if (window._returnToProfile) {
    window._returnToProfile = false;
    openProfileModal();
  }
});

function updateCategorySelect(containerOrRow, type) {
  if (!Cache || !Cache.categories) return;
  
  const row = containerOrRow.closest ? (containerOrRow.closest('.tx-item') || containerOrRow) : containerOrRow;
  const menu = row.querySelector('.tx-category-menu');
  const input = row.querySelector('.tx-category');
  const btn = row.querySelector('.tx-category-btn');
  const label = row.querySelector('.tx-category-label');
  
  if (!menu || !input || !btn || !label) return;

  const cats = type === 'Доход' ? Cache.categories.income : Cache.categories.expense;

  // Генерируем пункты: список категорий (системные категории защищены от удаления)
  let itemsHtml = cats.map(c => {
    const isCustom = !DEFAULT_SYSTEM_CATEGORIES.includes(c.name);
    const icon = c.icon && c.icon !== '📦' ? c.icon : 'tag';
    return `
      <div class="flex items-center justify-between hover:bg-[#2A2D3C] rounded-xl px-2.5 py-1.5 transition-colors group">
        <button type="button" class="flex-1 text-left text-[13px] font-medium text-gray-200 flex items-center gap-2.5 cursor-pointer truncate min-w-0" data-cat="${escapeHtml(c.name)}" data-icon="${icon}">
          <i data-lucide="${icon}" class="w-[18px] h-[18px] text-[#848D99]"></i>
          <span class="truncate">${escapeHtml(c.name)}</span>
        </button>
        ${isCustom ? `
          <button type="button" onclick="event.stopPropagation(); deleteCategory('${escapeHtml(c.name)}', '${type}')" class="text-gray-500 hover:text-[#FF453A] p-1.5 flex-shrink-0 cursor-pointer"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        ` : ''}
      </div>
    `;
  }).join('');

  // Кнопка "+" в самом низу списка
  itemsHtml += `
    <div class="border-t border-gray-700/80 pt-1 mt-1">
      <button type="button" class="btn-add-cat-in-menu w-full text-left px-2.5 py-1.5 text-xs text-blue-400 hover:bg-gray-700/60 rounded-lg flex items-center gap-1.5 font-semibold cursor-pointer transition-colors">
        <span>+</span> <span>Добавить категорию</span>
      </button>
    </div>
  `;

  menu.innerHTML = itemsHtml;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Открытие меню со смарт-позиционированием (вниз / вверх)
  btn.onclick = (e) => {
    e.stopPropagation();
    const isClosed = menu.classList.contains('hidden');
    
    // Закрываем все остальные меню и сбрасываем z-index
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.tx-item').forEach(r => r.style.zIndex = '');

    if (isClosed) {
      row.style.zIndex = '30';
      smartPositionDropdown(menu, btn);
      menu.classList.remove('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      row.style.zIndex = '';
    }
  };

  // Клик по пункту категории
  menu.querySelectorAll('button[data-cat]').forEach(itemBtn => {
    itemBtn.onclick = (e) => {
      e.stopPropagation();
      const catName = itemBtn.dataset.cat;
      const catIcon = itemBtn.dataset.icon;
      input.value = catName;
      label.innerHTML = `<i data-lucide="${catIcon}" class="w-4 h-4 mr-1.5 inline-block align-text-bottom"></i> ${escapeHtml(catName)}`;
      if(typeof lucide !== 'undefined') lucide.createIcons();
      label.classList.remove('text-gray-400');
      label.classList.add('text-white');
      menu.classList.add('hidden');
      row.style.zIndex = '';
    };
  });

  // Клик по кнопке "+ Добавить категорию"
  const addBtn = menu.querySelector('.btn-add-cat-in-menu');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      row.style.zIndex = '';
      showAddCategoryDialog(type, row);
    };
  }
}

// Умное позиционирование: открывается вниз, а если снизу нет места — вверх
function smartPositionDropdown(menu, triggerBtn) {
  const rect = triggerBtn.getBoundingClientRect();
  const menuHeight = 220; // примерная высота открытого списка
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceBelow < menuHeight && rect.top > menuHeight) {
    menu.style.bottom = 'calc(100% + 4px)';
    menu.style.top = 'auto';
  } else {
    menu.style.top = 'calc(100% + 4px)';
    menu.style.bottom = 'auto';
  }
}


// --- ЛОГИКА ЦЕЛЕЙ (АВТОНОМНЫЕ ВИРТУАЛЬНЫЕ КОПИЛКИ) ---


// =============================================================
// ДВИЖОК ЭКРАНА БЮДЖЕТА: ОНБОРДИНГ, ПУЛЬС, АВТОСВЯЗКА ЧЕКОВ И ЦЕЛИ
// =============================================================
let wizardSelectedIncomeSources = new Set(['Зарплата', 'Кэшбек']);

// Вызов загрузки выписки прямо из мастера онбординга
function triggerPdfImportFromWizard() {
  window._returnToWizardStep = 2;
  openPdfInfoModal();
}
window.triggerPdfImportFromWizard = triggerPdfImportFromWizard;

// Компактный формат сумм для календаря (40 тыс., 8.5 тыс., 600 ₽)
function formatCompactThousands(amount) {
  const num = parseFloat(amount) || 0;
  if (num >= 1000) {
    const k = num / 1000;
    return `${k % 1 === 0 ? k : k.toFixed(1)} тыс.`;
  }
  return `${num} ₽`;
}

// -------------------------------------------------------------
// МАСТЕР ПЕРВОГО ЗАПУСКА БЮДЖЕТА (БЕЗ СБРОСА ШАГОВ И СКРОЛЛА)
// -------------------------------------------------------------
let wizardData = {
  income: 0,
  categoryLimits: {}
};

// =============================================================
// ВОССТАНОВЛЕННЫЕ ФУНКЦИИ МАСТЕРА И КАЛЕНДАРЯ ДНЕЙ
// =============================================================

// 3. Поддержка долгого тапа по дню в календаре
let dayLongPressTimer = null;

function startDayLongPress(day) {
  clearTimeout(dayLongPressTimer);
  dayLongPressTimer = setTimeout(() => {
    openDayBillsModal(day);
  }, 500);
}

function cancelDayLongPress() {
  clearTimeout(dayLongPressTimer);
}

// 4. Открытие модального окна добавления счета на выбранное число
function openAddBillOnDay(day) {
  openAddBillModal(day);
}

// 7. Подстановка исторического среднего значения в поле лимита (Шаг 4)
function applyCatAvgToInput(catName, avg) {
  applyWizCategoryAvg(catName, avg);
}

// Текущий шаг мастера сохраняется в localStorage
let currentWizardStep = parseInt(localStorage.getItem('budget_wizard_step'), 10) || 1;

// Текущий выбранный день в мастере для счетов
let currentWizSelectedDay = 10;
let wizGoalIcon = '💻';


// Переключение активности источников дохода в мастере (Шаг 2)
let wizardActiveIncomeSources = new Set(['Зарплата', 'Кэшбек']);



// ============================================================
// ВОССТАНОВЛЕННЫЙ БЛОК: ИМПОРТ ВЫПИСОК, КАЛЕНДАРЬ И ДОХОД В МАСТЕРЕ
// ============================================================



// Алиас для обратной совместимости, если где-то остался старый вызов
window.selectWizCalendarDay = handleWizardDayClick;
window.handleWizardDayClick = handleWizardDayClick;

// 3. Вызов загрузки выписки прямо из мастера онбординга
function triggerPdfImportFromWizard() {
  const fileInput = document.getElementById('pdf-file-input');
  if (fileInput) {
    // Сохраняем флаг, что импорт вызван из мастера
    window.isImportingFromWizard = true;
    fileInput.click();
  } else {
    showToast('Ошибка: элемент выбора файла не найден', true);
  }
}

// =============================================================
// ОБНОВЛЕННЫЙ КАЛЕНДАРЬ И ЛИМИТЫ (ШАГИ 3 И 4)
// =============================================================

// Алиасы для защиты от ошибок отсутствия функции
window.renderWizardCalendar = renderWizCalendar;
window.renderWizCalendar = renderWizCalendar;



// 2. Умный клик по дню: пустой -> сразу добавление, со счетом -> красивый тултип
function handleWizardDayClick(day) {
  currentWizSelectedDay = parseInt(day, 10) || 1;
  const bills = (Cache?.calendarBills || []).filter(b => parseInt(b.day, 10) === currentWizSelectedDay);

  if (bills.length === 0) {
    // ДЕНЬ ПУСТОЙ: Сразу открываем модалку добавления с подставленным днем!
    closeWizDayTooltip();
    openAddBillModal(currentWizSelectedDay);
  } else {
    // В ДНЕ ЕСТЬ СЧЕТА: Показываем аккуратный всплывающий тултип
    showWizDayTooltip(currentWizSelectedDay, bills);
  }
  renderWizCalendar();
}
window.handleWizardDayClick = handleWizardDayClick;



window.closeWizDayTooltip = closeWizDayTooltip;

window.addAnotherBillFromTooltip = addAnotherBillFromTooltip;

// Хранилище категорий, добавленных пользователем вручную на шаге 4
let wizardCustomCategories = new Set();



// НОВЫЕ ФУНКЦИИ: Кнопка «+ Категория» на Шаге 4
function openAddCategoryLimitPicker() {
  const allExpenseCats = Cache?.categories?.expense || [];
  const standardNames = ['Продукты', 'Кафе и рестораны', 'Развлечения', 'Прочие расходы'];
  
  const available = allExpenseCats.filter(c => !standardNames.includes(c.name) && !wizardCustomCategories.has(c.name));

  if (available.length === 0) {
    showAddCategoryDialog('Расход', null);
    return;
  }

  const optionsHtml = available.map(c => `
    <button type="button" onclick="addCategoryToWizard('${escapeHtml(c.name)}')" class="w-full flex items-center justify-between p-3 rounded-xl bg-[#12151C] hover:bg-[#212430] border border-[rgba(255,255,255,0.04)] text-xs text-gray-200 transition-colors cursor-pointer">
      <div class="flex items-center gap-2.5">
        <i data-lucide="${c.icon || 'tag'}" class="w-4 h-4 text-[#848D99]"></i>
        <span>${escapeHtml(c.name)}</span>
      </div>
      <span class="text-[#727cff] font-bold">+ Добавить</span>
    </button>
  `).join('');

  showDialog('Добавить категорию в лимиты', `
    <div class="space-y-2 max-h-60 overflow-y-auto pt-2">
      ${optionsHtml}
    </div>
  `, false);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.openAddCategoryLimitPicker = openAddCategoryLimitPicker;


function selectWizCalendarDay(day) {
  currentWizSelectedDay = day;
  renderWizCalendar();
}

let activeEditCategory = null;






window.goToWizardStep = goToWizardStep;
window.toggleWizardIncomeSource = toggleWizardIncomeSource;
window.handleWizardDayClick = handleWizardDayClick;
window.startDayLongPress = startDayLongPress;
window.cancelDayLongPress = cancelDayLongPress;
window.openAddBillOnDay = openAddBillOnDay;
window.openDayBillsModal = openDayBillsModal;
window.closeDayBillsModal = closeDayBillsModal;
window.deleteCalendarBill = deleteCalendarBill;
window.applyCatAvgToInput = applyCatAvgToInput;
window.finishBudgetOnboarding = finishBudgetOnboarding;
window.openCategoryLimitModal = openCategoryLimitModal;
window.closeCategoryLimitModal = closeCategoryLimitModal;
window.submitCategoryLimit = submitCategoryLimit;
window.deleteBudgetGoal = deleteBudgetGoal;

// Быстрое пополнение виртуальной копилки цели
let activeTopupGoalId = null;
let currentTopupMode = 'add';

// --- НАВИГАЦИЯ, ФОРМЫ, РЕНДЕР ---
function switchTab(tab) {
  if (selectionMode) disableSelectionMode();
  ['budget', 'transactions', 'deposits', 'broker'].forEach(t => {
    const el = document.getElementById(t + '-tab');
    const navBtn = document.getElementById('nav-' + t);
    if (el) el.classList.add('hidden');
    if (navBtn) navBtn.classList.replace('text-blue-400', 'text-gray-500');
  });
  const activeTabEl = document.getElementById(tab + '-tab');
  const activeNavBtn = document.getElementById('nav-' + tab);
  if (activeTabEl) activeTabEl.classList.remove('hidden');
  if (activeNavBtn) activeNavBtn.classList.replace('text-gray-500', 'text-blue-400');
  
  if (tab === 'budget') renderBudgetTab();
  if (tab === 'broker' && Cache) setTimeout(drawBrokerChart, 100);
}

function toggleForm(containerId, btnId, btnText, formId, type) {
  const formContainer = document.getElementById(containerId);
  formContainer.classList.toggle('hidden');
  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    document.getElementById(btnId).innerText = btnText;
  }
  if (!formContainer.classList.contains('hidden')) {
    document.getElementById(formId).reset();
    const today = new Date().toISOString().split('T')[0];
    if (type === 'tx') {
      document.getElementById('tx-items-list').innerHTML = '';
      addTxRow();
    } else if (type === 'dep') {
      document.getElementById('dep-start').value = today;
      // Автоматически выбираем первую незавершенную цель
      const firstGoal = Cache?.goals?.find(g => !g.isAchieved);
      if (firstGoal) {
        document.getElementById('dep-goal').value = firstGoal.id;
      }
    } else if (type === 'broker-add') {
      document.getElementById('broker-type').value = 'Пополнение';
      document.getElementById('broker-date').value = today;
      document.getElementById('broker-form-title').innerText = 'Пополнение счета';
      document.getElementById('broker-deposit-group').classList.remove('hidden');
      document.getElementById('broker-amount').required = true;
      document.getElementById('broker-balance-label').innerText = 'Баланс после пополнения (₽)';
    } else if (type === 'broker-bal') {
      document.getElementById('broker-type').value = 'Баланс';
      document.getElementById('broker-date').value = today;
      document.getElementById('broker-form-title').innerText = 'Отметка баланса';
      document.getElementById('broker-deposit-group').classList.add('hidden');
      document.getElementById('broker-amount').required = false;
      document.getElementById('broker-balance-label').innerText = 'Баланс на дату (₽)';
    }
  }
}

function closeForm(containerId, btnId, btnText, formId) {
  document.getElementById(containerId).classList.add('hidden');
  if (formId) document.getElementById(formId).reset();
  if (formId === 'tx-form') document.getElementById('tx-items-list').innerHTML = '';
  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    document.getElementById(btnId).innerText = btnText;
  }
}

function updateGoalDropdowns() {
  if (!Cache) return;
  let html = '<option value="">Без привязки к цели</option>';
  Cache.goals.forEach(g => {
    if (!g.isAchieved) html += `<option value="${g.id}">${g.name}</option>`;
  });
  const depGoal = document.getElementById('dep-goal');
  if (depGoal) depGoal.innerHTML = html;

  // Меню быстрого выбора цели в брокере
  const brokerMenu = document.getElementById('broker-goal-dropdown');
  if (brokerMenu) {
    let bHtml = `
      <button type="button" onclick="selectBrokerGoal('')" class="w-full text-left px-3 py-2 text-xs rounded-xl text-gray-400 hover:bg-[#212430] hover:text-white transition-colors cursor-pointer">
        Без привязки к цели
      </button>
    `;
    Cache.goals.forEach(g => {
      const isCur = Cache.broker?.goalId === g.id;
      bHtml += `
        <button type="button" onclick="selectBrokerGoal('${g.id}')" class="w-full text-left px-3 py-2 text-xs rounded-xl flex items-center justify-between transition-colors cursor-pointer ${isCur ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] font-semibold' : 'text-gray-200 hover:bg-[#212430]'}">
          <span class="truncate">${escapeHtml(g.name)}</span>
          ${isCur ? '<i data-lucide="check" class="w-3.5 h-3.5"></i>' : ''}
        </button>
      `;
    });
    brokerMenu.innerHTML = bHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}


function addTxRow() {
  const clone = document.getElementById('tx-row-template').content.cloneNode(true);
  const uid = 'type_' + Math.random().toString(36).substr(2, 9);
  const radios = clone.querySelectorAll('.tx-type');
  radios[0].name = uid;
  radios[1].name = uid;

  const row = clone.querySelector('.tx-item');

  // Проверяем, есть ли уже добавленные строки транзакций
  const existingRows = document.querySelectorAll('#tx-items-list .tx-item');
  const prevRow = existingRows.length > 0 ? existingRows[existingRows.length - 1] : null;

  // Дата: берем из предыдущей строки, иначе ставим сегодняшнюю
  const prevDate = prevRow ? prevRow.querySelector('.tx-date').value : '';
  row.querySelector('.tx-date').value = prevDate || new Date().toISOString().split('T')[0];

  // Тип (Расход/Доход): копируем из предыдущей строки
  const prevType = prevRow ? prevRow.querySelector('.tx-type:checked')?.value : null;
  if (prevType) {
    const radioToSelect = row.querySelector(`.tx-type[value="${prevType}"]`);
    if (radioToSelect) radioToSelect.checked = true;
  }

  // Обработчики переключения типа для обновления категорий
  row.querySelectorAll('.tx-type').forEach(input => {
    input.addEventListener('change', (e) => {
      const select = row.querySelector('.tx-category');
      updateCategorySelect(select, e.target.value);
    });
  });

  // Инициализация категорий
  const currentType = row.querySelector('.tx-type:checked').value;
  const select = row.querySelector('.tx-category');
  updateCategorySelect(select, currentType);

  // Категория: копируем из предыдущей строки
  if (prevRow && prevType === currentType) {
    const prevCat = prevRow.querySelector('.tx-category').value;
    if (prevCat) select.value = prevCat;
  }

  document.getElementById('tx-items-list').appendChild(row);
}

function submitTransactions(e) {
  e.preventDefault();
  const rows = document.querySelectorAll('.tx-item');
  if (rows.length === 0) return showDialog('Ошибка', 'Добавьте хотя бы одну операцию', false);
  if (currentEditId) {
    submitAction('tx-submit-btn', 'Transactions', {
      type: rows[0].querySelector('.tx-type:checked').value,
      amount: getUnformattedVal(rows[0].querySelector('.tx-amount')),
      date: rows[0].querySelector('.tx-date').value,
      category: rows[0].querySelector('.tx-category').value,
      comment: rows[0].querySelector('.tx-comment').value
    });
  } else {
    submitAction('tx-submit-btn', 'Transactions', Array.from(rows).map(row => ({
      type: row.querySelector('.tx-type:checked').value,
      amount: getUnformattedVal(row.querySelector('.tx-amount')),
      date: row.querySelector('.tx-date').value,
      category: row.querySelector('.tx-category').value,
      comment: row.querySelector('.tx-comment').value
    })));
  }
}

function editTx(id, type, amount, cat, comment, rawDate) {
  currentEditId = id;
  currentEditTable = 'Transactions';
  document.getElementById('tx-form-container').classList.remove('hidden');
  document.getElementById('tx-items-list').innerHTML = '';
  addTxRow();
  const row = document.querySelector('.tx-item');
  row.querySelector('.tx-type[value="' + type + '"]').checked = true;
  row.querySelector('.tx-amount').value = amount;
  formatSumInput(row.querySelector('.tx-amount'));
  row.querySelector('.tx-date').value = rawDate;
  
  updateCategorySelect(row.querySelector('.tx-category'), type);
  
  // Корректно подставляем значение и визуальный лейбл выбранной категории
  const catInput = row.querySelector('.tx-category');
  const catLabel = row.querySelector('.tx-category-label');
  catInput.value = cat;
  
  const catArr = Cache.categories[type === 'Расход' ? 'expense' : 'income'] || [];
  const foundCat = catArr.find(c => c.name === cat);
  const icon = foundCat && foundCat.icon && foundCat.icon !== '📦' ? foundCat.icon : 'tag';
  if (catLabel) {
    catLabel.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 mr-1.5 inline-block align-text-bottom"></i> ${escapeHtml(cat)}`;
    catLabel.classList.remove('text-gray-400');
    catLabel.classList.add('text-white');
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();

  row.querySelector('.tx-comment').value = (comment && comment !== 'undefined') ? comment : '';
  document.getElementById('tx-submit-btn').innerText = 'Сохранить изменения';
  window.scrollTo(0, 0);
}


let currentFilterMonth = 'all';
let currentFilterCategory = 'all';

function toggleCustomFilterMenu(type) {
  const monthMenu = document.getElementById('menu-filter-month');
  const catMenu = document.getElementById('menu-filter-cat');

  if (type === 'month') {
    monthMenu.classList.toggle('hidden');
    catMenu.classList.add('hidden');
  } else {
    catMenu.classList.toggle('hidden');
    monthMenu.classList.add('hidden');
  }
}

// Закрываем меню при клике снаружи
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wrap-filter-month') && !e.target.closest('#wrap-filter-cat')) {
    const mm = document.getElementById('menu-filter-month');
    const cm = document.getElementById('menu-filter-cat');
    if (mm) mm.classList.add('hidden');
    if (cm) cm.classList.add('hidden');
  }
});

function selectFilterValue(type, value, label) {
  if (type === 'month') {
    currentFilterMonth = value;
    document.getElementById('label-filter-month').textContent = label;
    document.getElementById('menu-filter-month').classList.add('hidden');
  } else {
    currentFilterCategory = value;
    document.getElementById('label-filter-cat').textContent = label;
    document.getElementById('menu-filter-cat').classList.add('hidden');
  }
  renderTransactions();
}

function renderTransactions() {
  const data = Cache.transactions || [];

  // 1. Формируем меню выбора месяцев
  const monthMenu = document.getElementById('menu-filter-month');
  if (monthMenu && data.length > 0) {
    let mHtml = `
      <button type="button" onclick="selectFilterValue('month', 'all', 'Все месяцы')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${currentFilterMonth === 'all' ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
        Все месяцы
      </button>
    `;
    data.forEach(m => {
      const active = (currentFilterMonth === m.id);
      mHtml += `
        <button type="button" onclick="selectFilterValue('month', '${m.id}', '${escapeHtml(m.label)}')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${active ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
          ${escapeHtml(m.label)}
        </button>
      `;
    });
    monthMenu.innerHTML = mHtml;
  }

  // 2. Формируем меню выбора категорий (с новыми иконками Lucide)
  const catMenu = document.getElementById('menu-filter-cat');
  if (catMenu && Cache.categories) {
    const allCats = [
      ...Cache.categories.expense.map(c => ({ name: c.name, icon: c.icon || 'tag' })),
      ...Cache.categories.income.map(c => ({ name: c.name, icon: c.icon || 'tag' }))
    ];
    // Оставляем только уникальные категории
    const map = new Map();
    allCats.forEach(c => { if (!map.has(c.name)) map.set(c.name, c.icon); });

    let cHtml = `
      <button type="button" onclick="selectFilterValue('cat', 'all', 'Все категории')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${currentFilterCategory === 'all' ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
        Все категории
      </button>
    `;
    Array.from(map.entries()).sort((a,b) => a[0].localeCompare(b[0])).forEach(([name, icon]) => {
      const active = (currentFilterCategory === name);
      cHtml += `
        <button type="button" onclick="selectFilterValue('cat', '${escapeHtml(name)}', '${escapeHtml(name)}')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors flex items-center gap-2 ${active ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
          <i data-lucide="${icon}" class="w-4 h-4"></i>
          <span class="truncate">${escapeHtml(name)}</span>
        </button>
      `;
    });
    catMenu.innerHTML = cHtml;
  }

  // 3. Фильтруем данные согласно выбранным пунктам из меню
  let filteredMonths = data.map(m => {
    if (currentFilterMonth !== 'all' && m.id !== currentFilterMonth) return null;

    let items = m.items;
    if (currentFilterCategory !== 'all') {
      items = items.filter(tx => tx.category === currentFilterCategory);
    }

    if (items.length === 0) return null;

    // Пересчитываем итоги конкретно для отфильтрованных данных
    const expense = items.filter(i => i.type === 'Расход').reduce((sum, i) => sum + i.amount, 0);
    const income = items.filter(i => i.type === 'Доход').reduce((sum, i) => sum + i.amount, 0);

    return { ...m, items, expense, income };
  }).filter(Boolean);

  // 4. Обновляем виджеты «Расходы / Доходы» в шапке и поясняем, что именно рассчитано
  let periodText = 'Тек. мес';
  if (currentFilterMonth === 'all') {
    periodText = 'Все время';
  } else {
    const selectedMonthObj = data.find(m => m.id === currentFilterMonth);
    if (selectedMonthObj) periodText = selectedMonthObj.label;
  }
  if (currentFilterCategory !== 'all') {
    periodText += ` • ${currentFilterCategory}`;
  }

  const expLabel = document.getElementById('month-expense-label');
  const incLabel = document.getElementById('month-income-label');
  if (expLabel) expLabel.innerText = `Расходы (${periodText})`;
  if (incLabel) incLabel.innerText = `Доходы (${periodText})`;

  document.getElementById('month-expense').innerText = formatMoney(filteredMonths.reduce((a, b) => a + b.expense, 0));
  document.getElementById('month-income').innerText = formatMoney(filteredMonths.reduce((a, b) => a + b.income, 0));

  // 5. Отрисовка списка (Пустое состояние)
  if (filteredMonths.length === 0) {
    document.getElementById('transactions-list').innerHTML = '<div class="text-center text-gray-500 py-10 text-[13px]">Операции не найдены</div>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // Хелпер: переводит дату (28.09.2023) в понятный день (Вчера / Сегодня / 28 сентября)
  const getRelativeDayName = (dateStr) => {
    const d = new Date(dateStr.split('.').reverse().join('-'));
    const tday = new Date(); tday.setHours(0, 0, 0, 0);
    const yday = new Date(tday); yday.setDate(tday.getDate() - 1);
    
    if (d.getTime() === tday.getTime()) return 'Сегодня';
    if (d.getTime() === yday.getTime()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };

  // 6. Основная сборка DOM (группировка по дням)
  document.getElementById('transactions-list').innerHTML = filteredMonths.map(month => {
    const daysObj = {};
    month.items.forEach(tx => { 
       if(!daysObj[tx.formattedDate]) daysObj[tx.formattedDate] = [];
       daysObj[tx.formattedDate].push(tx);
    });

    return Object.keys(daysObj).map(day => `
      <div class="mb-5">
        <h3 class="font-semibold text-[#848D99] text-[13px] mb-2 px-1 tracking-wide">${getRelativeDayName(day)}</h3>
        <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl overflow-hidden divide-y divide-[rgba(255,255,255,0.03)] shadow-sm">
          ${daysObj[day].map(tx => {
            const isExp = tx.type === 'Расход';
            const catArr = isExp ? Cache.categories.expense : Cache.categories.income;
            const catInfo = catArr.find(c => c.name === tx.category);
            
            // Если иконки нет (старая запись с удаленной категории) — ставим 'tag' по умолчанию
            const iconStr = catInfo && catInfo.icon ? catInfo.icon : 'tag';
            // Нейтральная премиальная подложка для расходов вместо кислотно-красной
            const iconBg = isExp 
              ? 'bg-[#212430] text-[#9EA7B3] border border-[rgba(255,255,255,0.04)]' 
              : 'bg-[#30D158]/10 text-[#30D158] border border-[#30D158]/20';

            return `
              <div class="card cursor-pointer w-full py-[13px] px-4 flex items-center justify-between"
                   data-id="${tx.id}"
                   data-table="Transactions"
                   onclick="openCardContextMenu(event, '${escapeHtml(tx.category)}', () => editTx('${tx.id}', '${tx.type}', ${tx.amount}, '${escapeHtml(tx.category)}', '${escapeHtml(tx.comment)}', '${tx.rawDate}'), () => deleteRecord('Transactions', '${tx.id}'))">
                
                <!-- Чекбокс для мультиселекта долгого нажатия -->
                <input type="checkbox" class="select-checkbox hidden" data-id="${tx.id}">

                <div class="flex items-center gap-3.5 min-w-0">
                   <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}">
                      <i data-lucide="${iconStr}" class="w-[22px] h-[22px] stroke-[1.75px]"></i>
                   </div>
                   <div class="min-w-0 flex flex-col justify-center">
                     <span class="text-[15px] font-semibold text-gray-200 truncate leading-snug">${escapeHtml(tx.category)}</span>
                     ${tx.comment ? `<span class="text-[12px] text-gray-500 truncate leading-tight">${escapeHtml(tx.comment)}</span>` : ''}
                   </div>
                </div>

               <div class="tx-amount flex-shrink-0 text-right font-medium ml-2 ${isExp ? 'text-gray-200' : 'text-[#30D158]'} text-[16px]">
                      ${isExp ? '-' : '+'}${formatMoney(tx.amount)}
                  </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
  }).join('');

  // 7. Конвертируем все сгенерированные теги <i> в красивые SVG
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function switchTransactionView(view) {
  const isChart = view === 'chart';
  const list = document.getElementById('transactions-list-wrap') || document.getElementById('transactions-list');
  const chart = document.getElementById('transactions-chart');
  const listBtn = document.getElementById('view-list-btn');
  const chartBtn = document.getElementById('view-chart-btn');

  list.classList.toggle('hidden', isChart);
  chart.classList.toggle('hidden', !isChart);
  listBtn.classList.toggle('is-active', !isChart);
  chartBtn.classList.toggle('is-active', isChart);
  listBtn.setAttribute('aria-selected', String(!isChart));
  chartBtn.setAttribute('aria-selected', String(isChart));

  if (isChart) {
    requestAnimationFrame(() => buildCharts());
  }
}

let currentAnalyticsMonthIndex = 0;

function buildCharts() {
  if (!Cache || !Cache.transactions) return;
  const months = Cache.transactions;
  if (!months.length) return;

  const chronological = months.slice().reverse();
  const lastMonths = chronological.slice(-8);
  const labels = lastMonths.map(m => m.label);
  const expenses = lastMonths.map(m => Number(m.expense) || 0);
  const incomes = lastMonths.map(m => Number(m.income) || 0);

  const ctx = document.getElementById('monthlyExpensesChart').getContext('2d');
  if (monthlyChartObj) monthlyChartObj.destroy();

  monthlyChartObj = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Доходы',
          data: incomes,
          backgroundColor: 'rgba(48, 209, 88, 0.78)',
          hoverBackgroundColor: '#30D158',
          borderColor: '#30D158',
          hoverBorderColor: '#ffffff',
          borderWidth: 0,
          hoverBorderWidth: 1.5,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        },
        {
          label: 'Расходы',
          data: expenses,
          backgroundColor: 'rgba(255, 69, 58, 0.78)',
          hoverBackgroundColor: '#FF453A',
          borderColor: '#FF453A',
          hoverBorderColor: '#ffffff',
          borderWidth: 0,
          hoverBorderWidth: 1.5,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 450, easing: 'easeOutQuart' },
      transitions: {
        active: {
          animation: {
            duration: 450,
            easing: 'easeOutCubic'
          }
        }
      },
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      onClick: (e, elements, chart) => {
        const items = chart.getElementsAtEventForMode(e.native || e, 'nearest', { intersect: false }, false);
        const y = e.y !== undefined ? e.y : (e.native ? e.native.offsetY : 0);

        // Область клика строго вокруг столбца (+25px сверху и +15px снизу)
        const el = items[0]?.element;
        const isNearBar = el && y >= (Math.min(el.y, el.base) - 25) && y <= (Math.max(el.y, el.base) + 15);

        if (!items.length || !isNearBar) {
          chart._activeMonthIndex = -1;
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
          return;
        }

        const clickedIdx = items[0].index;

        // Повторный клик по тому же столбцу — закрывает тултип (toggle)
        if (chart._activeMonthIndex === clickedIdx) {
          chart._activeMonthIndex = -1;
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
        } else {
          chart._activeMonthIndex = clickedIdx;
          const activeItems = [
            { datasetIndex: 0, index: clickedIdx },
            { datasetIndex: 1, index: clickedIdx }
          ];
          chart.setActiveElements(activeItems);
          chart.tooltip.setActiveElements(activeItems, {
            x: el.x,
            y: el.y
          });
          chart.update();
        }
      },
      scales: {
        x: {
          stacked: false,
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#737d89', font: { size: 10, weight: '600' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,.055)' },
          border: { display: false },
          ticks: { color: '#737d89', font: { size: 10 }, padding: 7, maxTicksLimit: 6, callback: v => formatCompactChartMoney(v) }
        }
      },
      plugins: {
        legend: {
          position: 'top', align: 'start',
          labels: { color: '#aeb6c1', usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { size: 11, weight: '650' } }
        },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a', borderColor: 'rgba(255,255,255,.10)', borderWidth: 1,
          titleColor: '#fff', bodyColor: '#c9ced5', padding: 11, cornerRadius: 12,
          callbacks: { label: context => `${context.dataset.label}: ${formatMoney(context.raw)}` }
        }
      }
    }
  });
  // Запуск отображения текущего выбранного месяца
  updateAnalyticsMonthView();
}

function updateAnalyticsMonthView() {
  const months = Cache?.transactions || [];
  if (!months.length) return;

  currentAnalyticsMonthIndex = Math.max(0, Math.min(months.length - 1, currentAnalyticsMonthIndex));
  const cur = months[currentAnalyticsMonthIndex];

  document.getElementById('analytics-month-label').textContent = cur.label;
  document.getElementById('prev-month-btn').disabled = (currentAnalyticsMonthIndex >= months.length - 1);
  document.getElementById('next-month-btn').disabled = (currentAnalyticsMonthIndex <= 0);

  updateAnalyticsForMonth(cur.id);
}

function changeAnalyticsMonth(direction) {
  const months = Cache?.transactions || [];
  if (!months.length) return;
  currentAnalyticsMonthIndex += direction;
  updateAnalyticsMonthView();
}

function formatCompactChartMoney(value) {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + ' млн';
  if (Math.abs(value) >= 1000) return Math.round(value / 1000) + 'k';
  return value;
}

let currentStructureType = 'Расход'; // 'Расход' или 'Доход'

function switchStructureType(type) {
  currentStructureType = type;
  
  const expBtn = document.getElementById('struct-type-expense');
  const incBtn = document.getElementById('struct-type-income');
  if (expBtn && incBtn) {
    if (type === 'Расход') {
      expBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-gray-700 text-white transition-all';
      incBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg text-gray-400 hover:text-white transition-all';
    } else {
      incBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white transition-all';
      expBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg text-gray-400 hover:text-white transition-all';
    }
  }

  const titleEl = document.getElementById('structure-title');
  if (titleEl) {
    titleEl.textContent = type === 'Расход' ? 'Куда уходят деньги' : 'Источники доходов';
  }

  const months = Cache?.transactions || [];
  if (months.length > 0) {
    const curMonth = months[currentAnalyticsMonthIndex] || months[0];
    updateAnalyticsForMonth(curMonth.id);
  }
}

function updateAnalyticsForMonth(monthId) {
  const month = Cache.transactions.find(m => m.id === monthId);
  if (!month) return;

  const income = Number(month.income) || 0;
  const expense = Number(month.expense) || 0;
  const balance = income - expense;
  const rate = income > 0 ? Math.round((expense / income) * 100) : 0;

  const incomeEl = document.getElementById('analytics-income');
  const expenseEl = document.getElementById('analytics-expense');
  const balanceEl = document.getElementById('analytics-month-balance');
  const rateEl = document.getElementById('analytics-rate');
  if (incomeEl) incomeEl.textContent = formatMoney(income);
  if (expenseEl) expenseEl.textContent = formatMoney(expense);
  if (balanceEl) {
    balanceEl.textContent = `${balance >= 0 ? '+' : ''}${formatMoney(balance)}`;
    balanceEl.classList.toggle('is-negative', balance < 0);
  }
  if (rateEl) rateEl.textContent = income > 0 ? `${rate}% дохода` : 'Нет дохода';

  // Фильтруем категории по выбранному типу (Расход или Доход)
  const catMap = {};
  month.items.filter(tx => tx.type === currentStructureType).forEach(tx => {
    catMap[tx.category] = (catMap[tx.category] || 0) + (Number(tx.amount) || 0);
  });

  const entries = Object.entries(catMap).sort((a,b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const data = entries.map(([,value]) => value);
  // В методе updateAnalyticsForMonth
// Глубокие и строгие тона (Dark Mode HIG Standards)
  const colors = currentStructureType === 'Расход' 
    ? ['#0A84FF', '#FF9F0A', '#FF453A', '#BF5AF2', '#30D158', '#FF375F', '#5E5CE6'] 
    : ['#30D158', '#32ADE6', '#FF9F0A', '#64D2FF'];
  const total = data.reduce((sum, value) => sum + value, 0);

  const totalEl = document.getElementById('category-total');
  const centerLabelEl = document.getElementById('donut-center-label');
  const legendEl = document.getElementById('category-legend');
  
  if (totalEl) totalEl.textContent = formatMoney(total);
  if (centerLabelEl) centerLabelEl.textContent = currentStructureType === 'Расход' ? 'Расходы' : 'Доходы';

  if (legendEl) {
    legendEl.innerHTML = entries.length ? entries.map(([label, value], i) => `
      <div class="category-legend__item">
        <span class="category-legend__dot" style="background:${colors[i % colors.length]}"></span>
        <span class="category-legend__name">${escapeHtml(label)}</span>
        <span class="category-legend__value">${formatMoney(value)}</span>
        <span class="category-legend__percent">${total ? Math.round(value / total * 100) : 0}%</span>
      </div>`).join('') : `<div class="analytics-empty">Нет ${currentStructureType === 'Расход' ? 'расходов' : 'доходов'} за этот месяц</div>`;
  }

  const ctx = document.getElementById('categoryExpensesChart').getContext('2d');
  if (categoryChartObj) categoryChartObj.destroy();
  categoryChartObj = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.length ? labels : ['Нет данных'],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: data.length ? colors.slice(0, data.length) : ['#303740'],
        borderColor: '#171d24',
        borderWidth: 3,
        hoverOffset: 8,
        hoverBorderColor: '#ffffff',
        hoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 350 },
      onClick: (e, elements, chart) => {
        if (!elements || elements.length === 0) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
          return;
        }

        const clickedIdx = elements[0].index;
        const currentActive = chart.getActiveElements();

        // Повторный тап по тому же сегменту закрывает тултип (toggle)
        if (currentActive.length > 0 && currentActive[0].index === clickedIdx) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
        } else {
          chart.setActiveElements([{ datasetIndex: 0, index: clickedIdx }]);
          chart.tooltip.setActiveElements([{ datasetIndex: 0, index: clickedIdx }], {
            x: elements[0].element.x,
            y: elements[0].element.y
          });
          chart.update();
        }
      },
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a', borderColor: 'rgba(255,255,255,.10)', borderWidth: 1,
          titleColor: '#fff', bodyColor: '#c9ced5', padding: 10, cornerRadius: 11,
          callbacks: { label: context => `${context.label}: ${formatMoney(context.raw)}` }
        }
      }
    }
  });
}

// -------------------------------------------------------------
// ГРАФИК БРОКЕРА С ТАЙМФРЕЙМАМИ, ГРАДИЕНТОМ И СКРАББИНГОМ
// -------------------------------------------------------------

function submitBrokerOperation(e) {
  e.preventDefault();
  const type = document.getElementById('broker-type').value;
  const date = document.getElementById('broker-date').value;
  const balance = getUnformattedVal(document.getElementById('broker-balance-input'));
  const amount = type === 'Пополнение' 
    ? getUnformattedVal(document.getElementById('broker-amount')) 
    : balance;

  submitAction('broker-submit-btn', 'Broker', {
    type,
    date,
    amount,
    balance
  });
}

function submitBrokerGoal(e) {
  e.preventDefault();
  const g = document.getElementById('broker-goal-select').value;
  if (!g) return showDialog('Внимание', 'Выберите цель', false);
  submitAction('broker-goal-btn', 'Broker', {
    type: 'Цель',
    date: new Date().toISOString().split('T')[0],
    goalId: g
  });
}

function submitGoal(e) {
  e.preventDefault();
  submitAction('goal-submit-btn', 'Goals', {
    name: document.getElementById('goal-name').value,
    target: getUnformattedVal(document.getElementById('goal-target')),
    saved: 0,
    share: 100,
    deadline: document.getElementById('goal-deadline').value,
    status: 'В процессе'
  });
}

function editGoal(id, name, target, deadline) {
  currentEditId = id;
  currentEditTable = 'Goals';
  document.getElementById('goal-name').value = name;
  setFormattedVal('goal-target', target);
  document.getElementById('goal-deadline').value = deadline;
  document.getElementById('goal-submit-btn').innerText = 'Сохранить изменения';
  document.getElementById('goal-form-container').classList.remove('hidden');
  window.scrollTo(0, 0);
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

// ==================== РЕЖИМ МУЛЬТИВЫДЕЛЕНИЯ ====================
let selectedItems = new Set(); // ключи вида "table:id"
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;
let currentCategoryType = 'Расход';
let currentCategorySelect = null;
let selectedCategoryIcon = 'package';
const availableIcons = [
  'shopping-cart', 'utensils', 'car', 'home', 'film', 'package', 'briefcase', 'baby', 'paw-print', 'pill',
  'shopping-bag', 'plane', 'dumbbell', 'gamepad-2', 'book', 'music', 'gift', 'coffee', 'pizza', 'shirt',
  'lightbulb', 'wrench', 'smartphone', 'laptop', 'monitor', 'camera', 'palette', 'headphones', 'target', 'trophy',
  'bus', 'train', 'navigation', 'zap', 'bath', 'sparkles', 'archive', 'leaf', 'globe', 'credit-card'
];

function attachSelectionPanelDirectEvents() {
  const cancelBtn = document.getElementById('cancel-selection');
  const deleteBtn = document.getElementById('delete-selected');
  if (!cancelBtn || !deleteBtn) return;

  const onCancel = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    cancelSelection();
  };

  const onDelete = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    deleteSelectedItems();
  };

  cancelBtn.onclick = onCancel;
  cancelBtn.ontouchend = onCancel;
  deleteBtn.onclick = onDelete;
  deleteBtn.ontouchend = onDelete;
}

// Регистрация глобальных обработчиков
document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
document.addEventListener('mousemove', handleMouseMove);

document.addEventListener('click', (e) => {
  // Кнопки панели мультивыбора должны срабатывать ВСЕГДА, даже если выделена всего одна карточка
  if (e.target.id === 'cancel-selection' || e.target.closest('#cancel-selection')) {
    if (e) e.stopPropagation();
    cancelSelection();
    return;
  }
  if (e.target.id === 'delete-selected' || e.target.closest('#delete-selected')) {
    if (e) e.stopPropagation();
    deleteSelectedItems();
    return;
  }

  // Игнорируем клик после долгого нажатия только для прочих элементов
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  if (e.target.classList.contains('manage-categories-btn')) {
    showManageCategoriesDialog();
    return;
  }

  if (e.target.classList.contains('add-category-btn')) {
    const row = e.target.closest('.tx-item');
    if (!row) return;
    const type = row.querySelector('.tx-type:checked').value;
    const select = row.querySelector('.tx-category');
    showAddCategoryDialog(type, select);
    return;
  }

  // Обработка кликов по карточкам в режиме выбора
  if (!selectionMode) return;
  const card = e.target.closest('.card');
  if (!card) return;

  e.preventDefault();
  toggleItemSelection(card.dataset.id, card.dataset.table);
});

// Гибридная загрузка: системный словарь из файла + пользовательские оверрайды из Firestore
async function processOrSeedRules(snapshot) {
  const userDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const norm = (str) => typeof StatementCategorizer !== 'undefined' ? StatementCategorizer.normalize(str) : String(str || '').toLowerCase().trim();

  // Маркеры подавленных пользователем системных слов
  const disabledPatterns = new Set(
    userDocs.filter(d => d.disabled).map(d => norm(d.pattern))
  );

  // Пользовательские добавленные правила
  const customRules = userDocs.filter(d => !d.disabled && d.pattern && d.category).map(d => ({
    id: d.id,
    pattern: d.pattern.trim(),
    category: d.category,
    isSystem: false
  }));

  const customMap = new Map();
  customRules.forEach(r => customMap.set(norm(r.pattern), r));

  // Берем системные правила из default-rules.js
  const systemDefaults = window.DEFAULT_CATEGORY_RULES || [];
  const combined = [];

  systemDefaults.forEach((rule, idx) => {
    const patKey = norm(rule.pattern);
    if (disabledPatterns.has(patKey)) return;

    if (customMap.has(patKey)) {
      combined.push(customMap.get(patKey));
      customMap.delete(patKey);
    } else {
      combined.push({
        id: 'sys_' + idx,
        pattern: rule.pattern,
        category: rule.category,
        isSystem: true
      });
    }
  });

  customMap.forEach(rule => combined.push(rule));

  return combined;
}

  // Если пользователь находился во вкладке брокера и выключил её — переключаем на трат
  const brokerTab = document.getElementById('broker-tab');
  if (!show && brokerTab && !brokerTab.classList.contains('hidden')) {
    switchTab('transactions');
  }
}
