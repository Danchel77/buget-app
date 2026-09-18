// ==========================================
// Variables & State
// ==========================================
let currentWizardStep = 1;
let currentWizSelectedDay = null;
let wizardActiveIncomeSources = new Set(['Зарплата', 'Кэшбек']);
let wizardCustomCategories = new Set();
let activeTopupGoalId = null;
let activeEditCategory = null;
let currentTopupMode = 'topup';
let wizGoalIcon = '💻';

// ==========================================
// 1. Budget Dashboard (Дашборд Бюджета)
// ==========================================
function renderBudgetTab() {
  if (!Cache) return;

  const plan = Cache.budgetPlan || {};
  const wizardEl = document.getElementById('budget-wizard');
  const dashboardEl = document.getElementById('budget-dashboard');

  // Если бюджет еще не настроен — держим онбординг
  if (!plan.isConfigured) {
    if (wizardEl) wizardEl.classList.remove('hidden');
    if (dashboardEl) dashboardEl.classList.add('hidden');
    initBudgetWizard(false);
    return;
  }

  // Бюджет настроен — показываем дашборд
  if (wizardEl) wizardEl.classList.add('hidden');
  if (dashboardEl) dashboardEl.classList.remove('hidden');

  const bills = Cache.calendarBills || [];
  const goals = Cache.goals || [];
  const today = new Date();

  // Актуализация текущего месяца в шапке
  const monthLabel = document.getElementById('budget-month-label');
  if (monthLabel) {
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    monthLabel.innerText = `${monthNames[today.getMonth()]} ${today.getFullYear()}`;
  }

  // Расчет недели (Пн-Вс)
  const dayOfWeek = today.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const currentMonthId = formatDateStr(today, 'yyyy-MM');
  const monthData = Cache.transactions?.find(m => m.id === currentMonthId);
  const monthItems = monthData ? (monthData.items || []) : [];

  let weeklySpent = 0;
  let monthlySpent = 0;

  monthItems.forEach(tx => {
    if (tx.type !== 'Расход') return;
    const val = parseFloat(tx.amount) || 0;
    monthlySpent += val;

    const txDate = new Date(tx.rawDate);
    if (!isNaN(txDate.getTime()) && txDate >= startOfWeek && txDate <= endOfWeek) {
      weeklySpent += val;
    }
  });

  // Защита от деления на ноль и пустых лимитов
  const monthlyLimit = parseFloat(plan.monthlyVariableLimit) || 0;
  const weeklyBaseLimit = monthlyLimit > 0 ? Math.round(monthlyLimit / 4.33) : 0;
  const weeklyAvailable = Math.max(0, weeklyBaseLimit - weeklySpent);
  const daysRemainingInWeek = Math.max(1, 7 - diffToMonday);
  const dailyPace = weeklyBaseLimit > 0 ? Math.round(weeklyAvailable / daysRemainingInWeek) : 0;

  // 1. Блок «Недельный пульс»
  const weekAvailEl = document.getElementById('budget-week-available');
  const weekProgLabel = document.getElementById('budget-week-progress-label');
  const weekProgBar = document.getElementById('budget-week-progress-bar');
  const weekBadge = document.getElementById('budget-week-badge');

  if (weekAvailEl) weekAvailEl.innerText = formatMoney(weeklyAvailable);
  if (weekProgLabel) {
    weekProgLabel.innerHTML = `${formatMoney(weeklySpent)} из ${formatMoney(weeklyBaseLimit)} ${dailyPace > 0 ? `<span class="text-[#848D99]">(${formatMoney(dailyPace)}/дн)</span>` : ''}`;
  }

  if (weekProgBar) {
    const weekPct = weeklyBaseLimit > 0 ? Math.min(100, (weeklySpent / weeklyBaseLimit) * 100) : 0;
    weekProgBar.style.width = `${weekPct}%`;
    if (weeklySpent > weeklyBaseLimit && weeklyBaseLimit > 0) {
      weekProgBar.className = 'bg-[#FF453A] h-full rounded-full transition-all duration-300';
    } else if (weekPct >= 80) {
      weekProgBar.className = 'bg-[#FF9F0A] h-full rounded-full transition-all duration-300';
    } else {
      weekProgBar.className = 'bg-[#30D158] h-full rounded-full transition-all duration-300';
    }
  }

  if (weekBadge) {
    if (weeklyBaseLimit > 0 && weeklySpent > weeklyBaseLimit) {
      weekBadge.innerText = 'Перерасход';
      weekBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#FF453A]/15 text-[#FF453A]';
    } else {
      weekBadge.innerText = 'В графике';
      weekBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#30D158]/15 text-[#30D158]';
    }
  }

  // Шкала месяца
  const monthStatEl = document.getElementById('budget-month-stat');
  const monthProgressEl = document.getElementById('budget-month-progress');
  if (monthStatEl) monthStatEl.innerText = `${formatMoney(monthlySpent)} из ${formatMoney(monthlyLimit)}`;
  if (monthProgressEl) {
    const mPct = monthlyLimit > 0 ? Math.min(100, (monthlySpent / monthlyLimit) * 100) : 0;
    monthProgressEl.style.width = `${mPct}%`;
    monthProgressEl.className = mPct >= 95 ? 'bg-[#FF453A] h-full rounded-full transition-all duration-300' : (mPct >= 75 ? 'bg-[#FF9F0A] h-full rounded-full transition-all duration-300' : 'bg-[#30D158] h-full rounded-full transition-all duration-300');
  }

  // 2. Блок «Календарь счетов»
  renderBudgetCalendar(bills, today, monthItems);
  // 3. Блок «Цели накопления»
  renderBudgetGoals(goals, plan, bills);
  // 4. Блок «Лимиты по категориям»
  renderBudgetCategoryLimits(monthItems, plan.categoryLimits || {});

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderBudgetCalendar(bills, today, monthItems) {
  const container = document.getElementById('budget-calendar-list');
  const totalEl = document.getElementById('budget-bills-total');
  if (!container) return;

  const totalBillsSum = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
  if (totalEl) totalEl.innerText = `Обязательные счета: ${formatMoney(totalBillsSum)}`;

  if (bills.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-center text-xs text-[#848D99]">
        Нет запланированных платежей на этот месяц
      </div>
    `;
    return;
  }

  const currentDay = today.getDate();

  container.innerHTML = bills.map(b => {
    const billDay = parseInt(b.day, 10) || 1;
    const isPaid = isBillPaidInCurrentMonth(b, monthItems);
    const isPast = billDay < currentDay && !isPaid;

    let statusText = 'Ожидает';
    let statusClass = 'text-[#848D99] bg-[#212430] border-transparent';

    if (isPaid) {
      statusText = 'Оплачено';
      statusClass = 'text-[#30D158] bg-[#30D158]/15 border-[#30D158]/30 font-semibold';
    } else if (isPast) {
      statusText = 'Просрочено';
      statusClass = 'text-[#FF453A] bg-[#FF453A]/15 border-[#FF453A]/30 font-semibold';
    }

    return `
      <div class="card p-3 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#181B24] hover:border-[rgba(255,255,255,0.12)] flex flex-col justify-between cursor-pointer transition-all relative overflow-hidden"
           data-id="${b.id}"
           data-table="CalendarBills"
           onclick="openEditBillModal('${b.id}')">
        
        <input type="checkbox" class="select-checkbox hidden" data-id="${b.id}">

        <!-- Верхний ряд: дата слева, бейдж справа (никогда не обрезается) -->
        <div class="flex items-center justify-between gap-1 mb-2">
          <div class="flex items-baseline gap-1">
            <span class="text-[9px] font-bold text-[#6C5DD3] uppercase">СЕН</span>
            <span class="text-base font-black text-white font-mono leading-none">${billDay}</span>
          </div>
          <span class="text-[9px] px-2 py-0.5 rounded-full border ${statusClass} flex-shrink-0">${statusText}</span>
        </div>

        <!-- Нижний ряд: название и сумма -->
        <div>
          <h4 class="text-xs font-medium text-gray-300 truncate leading-tight">${escapeHtml(b.name)}</h4>
          <p class="text-sm font-bold text-white font-mono mt-1">${formatMoney(b.amount)}</p>
        </div>
      </div>
    `;
  }).join('');
}

function renderBudgetGoals(goals, plan, bills) {
  const container = document.getElementById('budget-goals-list');
  const surplusEl = document.getElementById('budget-goals-surplus');
  if (!container) return;

  const monthlyIncome = plan.monthlyIncome || 0;
  const monthlyLimit = plan.monthlyVariableLimit || 0;
  const totalBills = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
  const netSurplus = Math.max(0, monthlyIncome - monthlyLimit - totalBills);

  if (surplusEl) surplusEl.innerText = `Накопления по плану: +${formatMoney(netSurplus)}/мес`;

  if (goals.length === 0) {
    container.innerHTML = `
      <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-center text-xs text-[#848D99]">
        Целей пока нет. Нажмите «+», чтобы создать цель.
      </div>
    `;
    return;
  }

  container.innerHTML = goals.map(g => {
    const goalMonthlyAlloc = Math.round(netSurplus * (g.share / 100));
    const remaining = Math.max(0, g.target - g.saved);
    const monthsNeeded = goalMonthlyAlloc > 0 ? Math.ceil(remaining / goalMonthlyAlloc) : 0;
    const timeHint = g.isAchieved ? 'Цель выполнена' : (monthsNeeded > 0 ? `~${monthsNeeded} мес. при текущем плане` : 'Увеличьте профицит');

    return `
      <div class="card bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 shadow-sm cursor-pointer relative hover:border-[rgba(255,255,255,0.12)] transition-all"
           data-id="${g.id}"
           data-table="Goals"
           onclick="openEditGoalModal('${g.id}')">
        
        <input type="checkbox" class="select-checkbox hidden" data-id="${g.id}">

        <div class="flex items-start justify-between mb-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-[#6C5DD3]/15 text-[#6C5DD3] flex items-center justify-center flex-shrink-0">
              <i data-lucide="target" class="w-4 h-4"></i>
            </div>
            <div class="min-w-0">
              <h4 class="text-sm font-bold text-white truncate">${escapeHtml(g.name)}</h4>
              <p class="text-[11px] text-[#848D99]">${timeHint} • Доля: ${g.share}%</p>
            </div>
          </div>
          
          <button type="button" onclick="event.stopPropagation(); openGoalTopupModal('${g.id}', '${escapeHtml(g.name)}')" class="bg-[#212430] hover:bg-[#2A2D3C] text-gray-200 border border-[rgba(255,255,255,0.06)] text-xs font-semibold px-2.5 py-1.5 rounded-xl transition-all cursor-pointer flex items-center gap-1">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            <span>Пополнить</span>
          </button>
        </div>

        <div class="flex justify-between items-end text-xs mb-2">
          <span class="text-white font-bold font-mono text-sm">${formatMoney(g.saved)} <span class="text-[#848D99] font-normal text-xs">/ ${formatMoney(g.target)}</span></span>
          <span class="text-[11px] font-semibold text-[#6C5DD3]">${g.progress}%</span>
        </div>

        <div class="w-full bg-[rgba(255,255,255,0.06)] h-2 rounded-full overflow-hidden">
          <div class="bg-gradient-to-r from-[#6C5DD3] to-[#32ADE6] h-full rounded-full transition-all duration-500" style="width: ${g.progress}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderBudgetCategoryLimits(monthItems = [], categoryLimits = {}) {
  const container = document.getElementById('budget-category-limits-list');
  const sectionWrap = container ? container.closest('.space-y-2\\.5') || container.parentElement : null;
  if (!container || !Cache?.categories) return;

  const cats = Cache.categories.expense || [];
  const safeLimits = categoryLimits && typeof categoryLimits === 'object' ? categoryLimits : {};

  // Расчет фактических трат по категориям за текущий месяц
  const spentMap = {};
  (monthItems || []).forEach(tx => {
    if (tx.type === 'Расход' && tx.category) {
      spentMap[tx.category] = (spentMap[tx.category] || 0) + (parseFloat(tx.amount) || 0);
    }
  });

  // Отбираем только категории с лимитом > 0
  const activeLimits = cats.filter(c => {
    const lim = parseFloat(safeLimits[c.name]);
    return !isNaN(lim) && lim > 0;
  });

  // Если нет настроенных лимитов — аккуратная заглушка без пустых рамок
  if (activeLimits.length === 0) {
    container.innerHTML = `
      <div class="py-4 px-2 text-center">
        <p class="text-xs text-[#848D99]">Отдельные лимиты категорий не заданы</p>
        <button type="button" onclick="openAddCategoryLimitPicker()" class="mt-2 text-xs text-[#6C5DD3] hover:text-[#8274ea] font-semibold transition-colors cursor-pointer">
          + Настроить лимит категории
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = activeLimits.map(cat => {
    const spent = spentMap[cat.name] || 0;
    const limit = parseFloat(safeLimits[cat.name]) || 0;
    const icon = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    const isOver = limit > 0 && spent > limit;

    let barColor = 'bg-[#30D158]';
    if (isOver) barColor = 'bg-[#FF453A]';
    else if (pct >= 80) barColor = 'bg-[#FF9F0A]';

    return `
      <div class="py-3 flex items-center justify-between gap-3 cursor-pointer group hover:opacity-90 transition-opacity"
           onclick="openCategoryLimitModal('${escapeHtml(cat.name)}', ${limit})">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-8 h-8 rounded-xl bg-[#212430] text-gray-300 flex items-center justify-center flex-shrink-0">
            <i data-lucide="${icon}" class="w-4 h-4 text-[#848D99]"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between text-xs mb-1.5">
              <span class="font-semibold text-gray-200 truncate">${escapeHtml(cat.name)}</span>
              <span class="font-mono font-bold ${isOver ? 'text-[#FF453A]' : 'text-gray-200'} ml-2">
                ${formatMoney(spent)} <span class="text-[#848D99] font-normal text-[11px]">/ ${formatMoney(limit)}</span>
              </span>
            </div>
            <div class="w-full bg-[rgba(255,255,255,0.06)] h-1.5 rounded-full overflow-hidden">
              <div class="${barColor} h-full rounded-full transition-all duration-300" style="width: ${pct}%"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function isBillPaidInCurrentMonth(bill, monthItems) {
  if (bill.isPaid) return true;

  const billAmount = parseFloat(bill.amount) || 0;
  const billName = (bill.name || '').toLowerCase();

  return monthItems.some(tx => {
    if (tx.type !== 'Расход') return false;
    const isAmountMatch = Math.abs(tx.amount - billAmount) <= (billAmount * 0.15);
    const isCommentMatch = tx.comment && (tx.comment.toLowerCase().includes(billName) || billName.includes(tx.comment.toLowerCase()));
    const isCategoryMatch = (bill.category && tx.category === bill.category) && isAmountMatch;

    return isCategoryMatch || isCommentMatch;
  });
}

// Управление модальными окнами бюджета
function openBudgetPlanModal() {
  const dlg = document.getElementById('budget-plan-dialog');
  if (!dlg) return;

  const plan = Cache?.budgetPlan || {};
  setFormattedVal('plan-income-input', plan.monthlyIncome || 0);
  setFormattedVal('plan-expense-input', plan.monthlyVariableLimit || 0);

  // Расчет реального среднего дохода за 3 месяца
  const months = Cache?.transactions || [];
  const lastMonths = months.slice(0, 3);
  let totalInc = 0;
  lastMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      if (tx.type === 'Доход') totalInc += tx.amount;
    });
  });
  const avgIncome = Math.round(totalInc / Math.max(1, lastMonths.length));
  const avgEl = document.getElementById('plan-avg-income');
  if (avgEl) avgEl.innerText = `${formatMoney(avgIncome)}/мес`;

  updatePlanForecast();
  dlg.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeBudgetPlanModal() {
  const dlg = document.getElementById('budget-plan-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function updatePlanForecast() {
  const inc = getUnformattedVal(document.getElementById('plan-income-input'));
  const exp = getUnformattedVal(document.getElementById('plan-expense-input'));
  const bills = Cache?.calendarBills || [];
  const totalBills = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);

  const surplus = Math.max(0, inc - exp - totalBills);
  const surplusEl = document.getElementById('plan-forecast-surplus');
  const weekHint = document.getElementById('plan-week-hint');

  if (surplusEl) surplusEl.innerText = `+${formatMoney(surplus)}/мес`;
  if (weekHint) weekHint.innerText = `Базовый лимит недели: ~${formatMoney(Math.round(exp / 4.33))}`;
}

async function submitBudgetPlan(e) {
  e.preventDefault();
  const inc = getUnformattedVal(document.getElementById('plan-income-input'));
  const exp = getUnformattedVal(document.getElementById('plan-expense-input'));

  showToast('Сохранение плана...', false, true);
  try {
    const col = getUserCol('BudgetPlan');
    const snap = await col.get();
    const batch = db.batch();

    const planData = {
      monthlyIncome: inc,
      monthlyVariableLimit: exp,
      updatedAt: Date.now()
    };

    if (snap.empty) {
      batch.set(col.doc(), planData);
    } else {
      batch.update(snap.docs[0].ref, planData);
    }

    await batch.commit();
    closeBudgetPlanModal();
    await fetchAllData();
    showToast('План бюджета обновлен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

// ==========================================
// 2. Calendar Bills (Счета и платежи)
// ==========================================
function openAddBillModal(initialDay = null) {
  const form = document.getElementById('calendar-bill-form');
  if (form) form.reset();

  const editIdEl = document.getElementById('bill-edit-id');
  if (editIdEl) editIdEl.value = '';

  const dayInput = document.getElementById('bill-day');
  if (dayInput && initialDay) {
    dayInput.value = initialDay;
  }

  const actions = document.getElementById('bill-dialog-actions');
  const deleteBtn = document.getElementById('bill-delete-btn');
  const title = document.getElementById('calendar-bill-dialog-title');

  if (actions) actions.classList.remove('hidden');
  if (deleteBtn) deleteBtn.classList.add('hidden');
  if (title) title.innerText = initialDay ? `Платеж на ${initialDay} число` : 'Платеж в календарь';

  const dlg = document.getElementById('calendar-bill-dialog');
  if (dlg) dlg.classList.remove('hidden');
}

function closeAddBillModal() {
  const dlg = document.getElementById('calendar-bill-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function openEditBillModal(billId) {
  const bill = Cache?.calendarBills?.find(b => b.id === billId);
  if (!bill) return;

  const dlg = document.getElementById('calendar-bill-dialog');
  const title = document.getElementById('calendar-bill-dialog-title');
  const deleteBtn = document.getElementById('bill-delete-btn');

  document.getElementById('bill-edit-id').value = bill.id;
  document.getElementById('bill-name').value = bill.name;
  setFormattedVal('bill-amount', bill.amount);
  document.getElementById('bill-day').value = bill.day;
  document.getElementById('bill-type').value = bill.type || 'recurring';

  if (title) title.innerText = 'Редактировать платеж';
  if (deleteBtn) deleteBtn.classList.remove('hidden');

  if (dlg) dlg.classList.remove('hidden');
}

async function submitCalendarBill(e) {
  e.preventDefault();
  const editId = document.getElementById('bill-edit-id').value;
  const name = document.getElementById('bill-name').value.trim();
  const amount = getUnformattedVal(document.getElementById('bill-amount'));
  const day = parseInt(document.getElementById('bill-day').value, 10);
  const type = document.getElementById('bill-type').value;

  if (!name || !amount) return;

  showToast('Сохранение платежа...', false, true);
  try {
    const col = getUserCol('CalendarBills');
    const billData = { name, amount, day, type, isPaid: false, updatedAt: Date.now() };

    if (editId) {
      await col.doc(editId).update(billData);
    } else {
      await col.add({ ...billData, createdAt: Date.now() });
    }

    closeAddBillModal();
    document.getElementById('calendar-bill-form').reset();
    document.getElementById('bill-edit-id').value = '';
    
    // Синхронизируем кеш
    await fetchAllData();

    // ЕСЛИ НАХОДИМСЯ В МАСТЕРЕ: держим Шаг 3!
    const plan = Cache?.budgetPlan || {};
    if (!plan.isConfigured) {
      goToWizardStep(3);
      renderWizCalendar();
    }
    
    showToast('Платеж сохранен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function deleteCurrentEditingBill() {
  const id = document.getElementById('bill-edit-id').value;
  if (!id) return;

  showToast('Удаление платежа...', false, true);
  try {
    await getUserCol('CalendarBills').doc(id).delete();
    closeAddBillModal();
    await fetchAllData();
    renderWizardCalendar();
    showToast('Платеж удален');
  } catch (e) {
    showToast('Ошибка удаления', true);
  }
}

async function toggleBillPaidStatus(billId, newStatus) {
  try {
    await getUserCol('CalendarBills').doc(billId).update({ isPaid: newStatus });
    await fetchAllData();
  } catch (e) {}
}

// Модальное окно управления счетами конкретного дня
function openDayBillsModal(day) {
  const dlg = document.getElementById('day-bills-dialog');
  const title = document.getElementById('day-bills-title');
  const list = document.getElementById('day-bills-items-list');
  const addBtn = document.getElementById('btn-add-second-bill');

  if (title) title.innerText = `${day} число: список платежей`;
  if (dlg) dlg.classList.remove('hidden');

  const bills = (Cache?.calendarBills || []).filter(b => parseInt(b.day, 10) === parseInt(day, 10));

  if (list) {
    if (bills.length === 0) {
      list.innerHTML = '<div class="text-center py-4 text-xs text-[#848D99]">Счетов на этот день нет</div>';
    } else {
      list.innerHTML = bills.map(b => `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-[#12151C] border border-[rgba(255,255,255,0.04)] text-xs">
          <div>
            <div class="font-semibold text-white">${escapeHtml(b.name)}</div>
            <div class="font-mono text-[11px] text-[#848D99]">${formatMoney(b.amount)}</div>
          </div>
          <button type="button" onclick="deleteCalendarBill('${b.id}')" class="text-gray-500 hover:text-[#FF453A] p-1.5 cursor-pointer">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `).join('');
    }
  }

  if (addBtn) {
    addBtn.onclick = () => {
      closeDayBillsModal();
      openAddBillModal(day);
    };
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeDayBillsModal() {
  const dlg = document.getElementById('day-bills-dialog');
  if (dlg) dlg.classList.add('hidden');
}

// Быстрое удаление счета из календаря
async function deleteCalendarBill(billId) {
  showToast('Удаление платежа...', false, true);
  try {
    await getUserCol('CalendarBills').doc(billId).delete();
    closeDayBillsModal();
    await fetchAllData();
    renderWizCalendar();
    showToast('Платеж удален');
  } catch (e) {
    showToast('Ошибка удаления', true);
  }
}

// ==========================================
// 3. Budget Goals (Цели и Копилки)
// ==========================================
function processGoals(goals) {
  return goals.map(g => {
    const tar = parseFloat(g.target) || 0;
    const sav = parseFloat(g.saved) || 0;
    const share = parseFloat(g.share) || (goals.length > 0 ? Math.round(100 / goals.length) : 100);
    return {
      id: g.id,
      name: g.name,
      target: tar,
      saved: sav,
      share: share,
      progress: Math.min(100, tar > 0 ? (sav / tar) * 100 : 0).toFixed(1),
      isAchieved: sav >= tar
    };
  });
}

// Умный определитель векторной иконки цели по смыслу названия
function getGoalIcon(name) {
  const n = (name || '').toLowerCase();
  if (/квартир|дом|ремонт|жиль/i.test(n)) return 'home';
  if (/машин|авто|тачк|мото/i.test(n)) return 'car';
  if (/отпуск|море|путешеств|билет|тур/i.test(n)) return 'plane';
  if (/учеб|курс|образов/i.test(n)) return 'graduation-cap';
  if (/подушк|безопасн|резерв/i.test(n)) return 'shield-check';
  if (/инвест|акци/i.test(n)) return 'trending-up';
  if (/телефон|ноут|комп|айфон|гаджет/i.test(n)) return 'smartphone';
  return 'target';
}

// Управление созданием и редактированием целей бюджета
function openGoalModal() {
  const form = document.getElementById('budget-goal-form');
  if (form) form.reset();

  document.getElementById('goal-edit-id').value = '';
  document.getElementById('goal-share-input').value = 100;
  document.getElementById('goal-share-label').innerText = '100%';
  document.getElementById('goal-delete-btn').classList.add('hidden');
  document.getElementById('budget-goal-dialog-title').innerText = 'Новая цель';

  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.remove('hidden');
}

function closeGoalModal() {
  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function openEditGoalModal(goalId) {
  const goal = Cache?.goals?.find(g => g.id === goalId);
  if (!goal) return;

  document.getElementById('goal-edit-id').value = goal.id;
  document.getElementById('goal-name-input').value = goal.name;
  setFormattedVal('goal-target-input', goal.target);
  setFormattedVal('goal-saved-input', goal.saved);
  document.getElementById('goal-share-input').value = goal.share || 100;
  document.getElementById('goal-share-label').innerText = (goal.share || 100) + '%';
  document.getElementById('goal-delete-btn').classList.remove('hidden');
  document.getElementById('budget-goal-dialog-title').innerText = 'Редактировать цель';

  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.remove('hidden');
}

async function submitBudgetGoal(e) {
  e.preventDefault();
  const editId = document.getElementById('goal-edit-id').value;
  const name = document.getElementById('goal-name-input').value.trim();
  const target = getUnformattedVal(document.getElementById('goal-target-input'));
  const saved = getUnformattedVal(document.getElementById('goal-saved-input'));
  const share = parseInt(document.getElementById('goal-share-input').value, 10) || 100;

  if (!name || !target) return;

  showToast('Сохранение цели...', false, true);
  try {
    const col = getUserCol('Goals');
    const goalData = {
      name,
      target,
      saved,
      share,
      status: saved >= target ? 'Выполнена' : 'В процессе',
      updatedAt: Date.now()
    };

    if (editId) {
      await col.doc(editId).update(goalData);
    } else {
      await col.add({ ...goalData, createdAt: Date.now() });
    }

    closeGoalModal();
    await fetchAllData();
    showToast('Цель сохранена');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function deleteCurrentEditingGoal() {
  const editId = document.getElementById('goal-edit-id').value;
  if (!editId) return;

  showToast('Удаление цели...', false, true);
  try {
    await getUserCol('Goals').doc(editId).delete();
    closeGoalModal();
    await fetchAllData();
    showToast('Цель удалена');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

function deleteBudgetGoal(goalId, goalName) {
  showDialog('Удаление цели', `Удалить цель "${goalName}"? Накопленный прогресс будет удален.`, true, async () => {
    showToast('Удаление цели...', false, true);
    try {
      await getUserCol('Goals').doc(goalId).delete();
      await fetchAllData();
      showToast('Цель удалена');
    } catch (e) {
      showToast('Ошибка удаления', true);
    }
  });
}

function openGoalTopupModal(goalId, goalName) {
  activeTopupGoalId = goalId;
  const dlg = document.getElementById('goal-topup-dialog');
  const title = document.getElementById('goal-topup-title');
  if (title) title.innerText = goalName;
  document.getElementById('goal-topup-amount').value = '';
  setTopupMode('add');
  if (dlg) dlg.classList.remove('hidden');
}

function closeGoalTopupModal() {
  const dlg = document.getElementById('goal-topup-dialog');
  if (dlg) dlg.classList.add('hidden');
  activeTopupGoalId = null;
}

function setTopupMode(mode) {
  currentTopupMode = mode;
  const addBtn = document.getElementById('tab-topup-add');
  const subBtn = document.getElementById('tab-topup-sub');
  if (mode === 'add') {
    addBtn.className = 'flex-1 py-1.5 rounded-lg font-semibold bg-[#212430] text-white transition-all';
    subBtn.className = 'flex-1 py-1.5 rounded-lg font-medium text-[#848D99] hover:text-white transition-all';
  } else {
    subBtn.className = 'flex-1 py-1.5 rounded-lg font-semibold bg-[#212430] text-white transition-all';
    addBtn.className = 'flex-1 py-1.5 rounded-lg font-medium text-[#848D99] hover:text-white transition-all';
  }
}

async function submitGoalTopup() {
  if (!activeTopupGoalId) return;
  const amount = getUnformattedVal(document.getElementById('goal-topup-amount'));
  if (!amount) return;

  const goal = Cache?.goals?.find(g => g.id === activeTopupGoalId);
  if (!goal) return;

  let newSaved = currentTopupMode === 'add' ? (goal.saved + amount) : Math.max(0, goal.saved - amount);

  showToast('Обновление цели...', false, true);
  try {
    await getUserCol('Goals').doc(activeTopupGoalId).update({ saved: newSaved });
    closeGoalTopupModal();
    await fetchAllData();
    showToast(currentTopupMode === 'add' ? `В цель внесено +${formatMoney(amount)}` : `Из цели снято −${formatMoney(amount)}`);
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

// ==========================================
// 4. Budget Wizard (Мастер настройки)
// ==========================================
function initBudgetWizard(forceReset = false) {
  if (forceReset) {
    currentWizardStep = 1;
    localStorage.setItem('budget_wizard_step', '1');
    const gName = document.getElementById('wiz-goal-name');
    const gTarget = document.getElementById('wiz-goal-target');
    const gSaved = document.getElementById('wiz-goal-saved');
    const incInput = document.getElementById('wiz-income-input');
    if (gName) gName.value = '';
    if (gTarget) gTarget.value = '';
    if (gSaved) gSaved.value = '';
    if (incInput) incInput.value = '';
    document.querySelectorAll('[data-wiz-cat]').forEach(inp => inp.value = '');
    updateWizGoalSlider();
  } else {
    currentWizardStep = parseInt(localStorage.getItem('budget_wizard_step'), 10) || currentWizardStep || 1;
  }

  goToWizardStep(currentWizardStep);
  calculateHistoricalIncomeForWizard();
}

function goToWizardStep(step) {
  currentWizardStep = step;
  localStorage.setItem('budget_wizard_step', String(step));

  for (let i = 1; i <= 5; i++) {
    const stepEl = document.getElementById(`wizard-step-${i}`);
    const progEl = document.getElementById(`wiz-progress-${i}`);
    if (stepEl) {
      if (i === step) stepEl.classList.remove('hidden');
      else stepEl.classList.add('hidden');
    }
    if (progEl) {
      progEl.className = i <= step 
        ? 'h-full rounded-full bg-[#6C5DD3] transition-colors duration-300' 
        : 'h-full rounded-full bg-[rgba(255,255,255,0.08)] transition-colors duration-300';
    }
  }

  const badge = document.getElementById('wizard-step-badge');
  const title = document.getElementById('wizard-step-title');
  const counter = document.getElementById('wizard-step-counter');
  if (counter) counter.innerText = `${step}/5`;

  const titles = [
    'Создайте цель накопления',
    'Планируемый доход',
    'Календарь обязательных счетов',
    'Лимиты на каждый день',
    'Итоговый план бюджета'
  ];

  if (badge) badge.innerText = `Шаг ${step} из 5`;
  if (title) title.innerText = titles[step - 1] || 'Настройка';

  if (step === 1) updateWizGoalSlider();
  else if (step === 3) renderWizCalendar();
  else if (step === 4) renderWizLimitsEditor();
  else if (step === 5) calculateAndRenderWizSummary();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openWizardIconPicker() {
  const picker = document.getElementById('wiz-icon-picker');
  if (picker) picker.classList.toggle('hidden');
}

function selectWizardGoalIcon(icon) {
  wizGoalIcon = icon;
  const display = document.getElementById('wiz-goal-icon-display');
  if (display) display.innerText = icon;
  const picker = document.getElementById('wiz-icon-picker');
  if (picker) picker.classList.add('hidden');
}

function updateWizGoalSlider() {
  const target = getUnformattedVal(document.getElementById('wiz-goal-target'));
  const saved = getUnformattedVal(document.getElementById('wiz-goal-saved'));

  const label = document.getElementById('wiz-goal-pct-label');
  const bar = document.getElementById('wiz-goal-progress-bar');

  if (!target || target <= 0) {
    if (label) label.innerText = '0%';
    if (bar) bar.style.width = '0%';
    return;
  }

  const pct = Math.min(100, Math.max(0, Math.round((saved / target) * 1000) / 10));
  if (label) label.innerText = `${pct}%`;
  if (bar) bar.style.width = `${pct}%`;
}

function recalculateWizardIncome() {
  const txMonths = Cache?.transactions || [];
  if (txMonths.length === 0) return;

  const monthsCount = Math.min(3, txMonths.length);
  let totalIncome = 0;

  for (let i = 0; i < monthsCount; i++) {
    const items = txMonths[i].items || [];
    items.forEach(tx => {
      if (tx.type === 'Доход') {
        const cat = tx.category || 'Другое';
        // Если категория входит в выбранные источники
        if (wizardActiveIncomeSources.has(cat)) {
          totalIncome += (parseFloat(tx.amount) || 0);
        }
      }
    });
  }

  const avgIncome = monthsCount > 0 ? Math.round(totalIncome / monthsCount) : 0;
  
  const calcEl = document.getElementById('wiz-calculated-income');
  const inputEl = document.getElementById('wiz-income-input');
  
  if (calcEl) calcEl.innerText = `${formatMoney(avgIncome)}/мес`;
  if (inputEl && (!inputEl.value || inputEl.value === '0 ₽')) {
    inputEl.value = formatMoney(avgIncome);
  }
}

function adoptCalculatedIncome() {
  const calcText = document.getElementById('wiz-calculated-income')?.innerText || '0';
  const val = parseInt(calcText.replace(/[^\d]/g, ''), 10) || 0;
  const input = document.getElementById('wiz-income-input');
  if (input && val > 0) {
    input.value = formatMoney(val);
    showToast('Сумма дохода подставлена');
  }
}

function calculateHistoricalIncomeForWizard() {
  const txMonths = Cache?.transactions || [];
  const calcEl = document.getElementById('wiz-calculated-income');
  const inputEl = document.getElementById('wiz-income-input');

  if (!txMonths.length) {
    if (calcEl) calcEl.innerText = '0 ₽/мес';
    return 0;
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  let totalIncome = 0;

  txMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      const t = tx.timestamp || (tx.rawDate ? new Date(tx.rawDate).getTime() : null);
      if (t) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }

      if (tx.type === 'Доход') {
        const cat = tx.category || 'Другое';
        if (wizardActiveIncomeSources.has(cat)) {
          totalIncome += (parseFloat(tx.amount) || 0);
        }
      }
    });
  });

  const diffDays = Math.max(1, Math.round((maxTime - minTime) / (1000 * 60 * 60 * 24)) + 1);
  const effectiveDays = Math.min(90, diffDays);
  const avgIncome = Math.round(totalIncome * (30.44 / effectiveDays));

  if (calcEl) calcEl.innerText = `${formatMoney(avgIncome)}/мес`;
  if (inputEl && (!inputEl.value || inputEl.value === '0 ₽' || inputEl.value === '0')) {
    inputEl.value = formatMoney(avgIncome);
  }
  return avgIncome;
}

function toggleWizardIncomeSource(sourceName) {
  if (wizardActiveIncomeSources.has(sourceName)) {
    wizardActiveIncomeSources.delete(sourceName);
  } else {
    wizardActiveIncomeSources.add(sourceName);
  }

  // Обновляем визуальное состояние чипсов
  document.querySelectorAll('#wiz-income-sources-list [data-source]').forEach(el => {
    const src = el.dataset.source;
    if (wizardActiveIncomeSources.has(src)) {
      el.className = 'text-[10px] bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/20 px-2 py-0.5 rounded-lg font-medium flex items-center gap-1 cursor-pointer transition-all';
      el.innerHTML = `<i data-lucide="check" class="w-2.5 h-2.5"></i> ${escapeHtml(src)}`;
    } else {
      el.className = 'text-[10px] bg-[#212430] text-[#848D99] border border-transparent px-2 py-0.5 rounded-lg font-medium flex items-center gap-1 cursor-pointer transition-all';
      el.innerHTML = `${escapeHtml(src)}`;
    }
  });

  // Пересчитываем сумму по активным источникам
  recalculateWizardIncome();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function addAnotherBillFromTooltip() {
  closeWizDayTooltip();
  openAddBillModal(currentWizSelectedDay);
}

// Рендер сетки календаря
function renderWizCalendar() {
  const grid = document.getElementById('wiz-calendar-grid');
  const totalLabel = document.getElementById('wiz-bills-total-label');
  if (!grid) return;

  const bills = Cache?.calendarBills || [];
  const totalSum = bills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);
  if (totalLabel) totalLabel.innerText = formatMoney(totalSum);

  let html = '';

  for (let day = 1; day <= 31; day++) {
    const dayBills = bills.filter(b => parseInt(b.day, 10) === day);
    const hasBills = dayBills.length > 0;
    const isSelected = day === currentWizSelectedDay;
    const totalDaySum = dayBills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);

    let sumBadge = '';
    if (hasBills) {
      const shortSum = totalDaySum >= 1000 ? `${Math.round(totalDaySum / 1000)}k` : `${totalDaySum}`;
      sumBadge = `<span class="wiz-bill-badge">${shortSum}</span>`;
    }

    html += `
      <div onclick="handleWizardDayClick(${day})" class="wiz-day-cell ${isSelected ? 'is-selected' : ''} ${hasBills ? 'has-bills' : ''}">
        <span class="${isSelected ? 'text-white font-bold' : (hasBills ? 'text-gray-200' : 'text-[#848D99]')}">${day}</span>
        ${sumBadge}
      </div>
    `;
  }
  grid.innerHTML = html;
}

function renderWizDayBillsList() {
  const container = document.getElementById('wiz-day-bills-list');
  const label = document.getElementById('wiz-selected-day-label');
  if (label) label.innerText = `${currentWizSelectedDay} число: счета`;
  if (!container) return;

  const bills = (Cache.calendarBills || []).filter(b => parseInt(b.day, 10) === currentWizSelectedDay);

  if (bills.length === 0) {
    container.innerHTML = `
      <div class="py-2 text-center text-[11px] text-[#848D99]">
        Нет списаний на этот день
      </div>
    `;
    return;
  }

  container.innerHTML = bills.map(b => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-[#181B24] border border-[rgba(255,255,255,0.04)]">
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-[#212430] flex items-center justify-center text-xs text-gray-300">
          <i data-lucide="receipt" class="w-3.5 h-3.5 text-[#848D99]"></i>
        </div>
        <span class="text-xs font-medium text-gray-200 truncate">${escapeHtml(b.name)}</span>
      </div>
      <b class="text-xs font-mono font-semibold text-gray-200 ml-2">-${formatMoney(b.amount)}</b>
    </div>
  `).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openAddBillModalFromWizard() {
  const dayInput = document.getElementById('bill-day');
  if (dayInput) dayInput.value = currentWizSelectedDay;
  openAddBillModal();
}

function showWizDayTooltip(day, bills) {
  const tooltip = document.getElementById('wiz-day-tooltip');
  const title = document.getElementById('wiz-tooltip-title');
  const list = document.getElementById('wiz-tooltip-bills-list');
  if (!tooltip || !list) return;

  if (title) title.innerText = `${day} число: платежи (${bills.length})`;

  list.innerHTML = bills.map(b => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-[#12151C] border border-[rgba(255,255,255,0.04)]">
      <div class="min-w-0 pr-2 cursor-pointer" onclick="openEditBillModal('${b.id}')">
        <span class="text-xs font-semibold text-white truncate block">${escapeHtml(b.name)}</span>
        <span class="text-[11px] font-mono text-gray-400">-${formatMoney(b.amount)}</span>
      </div>
      <div class="flex items-center gap-1">
        <button type="button" onclick="openEditBillModal('${b.id}')" class="text-gray-400 hover:text-white p-1.5 cursor-pointer">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
        </button>
        <button type="button" onclick="deleteCalendarBill('${b.id}')" class="text-gray-400 hover:text-[#FF453A] p-1.5 cursor-pointer">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>
  `).join('');

  tooltip.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeWizDayTooltip() {
  const tooltip = document.getElementById('wiz-day-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}

function renderWizLimitsEditor() {
  const container = document.getElementById('wiz-category-limits-editor');
  if (!container) return;

  const avgMap = calculateHistoricalCategoryAverages();

  // Стандартные 3 категории
  const list = [
    { name: 'Продукты', icon: 'shopping-cart' },
    { name: 'Кафе и рестораны', icon: 'utensils' },
    { name: 'Развлечения', icon: 'gamepad-2' }
  ];

  // Добавленные пользователем категории
  wizardCustomCategories.forEach(catName => {
    const catObj = Cache?.categories?.expense?.find(c => c.name === catName);
    list.push({ name: catName, icon: catObj?.icon || 'tag', isCustom: true });
  });

  // Собирательная категория «Прочие расходы»
  const accountedNames = list.map(c => c.name);
  let othersAvg = 0;
  Object.keys(avgMap).forEach(cat => {
    if (!accountedNames.includes(cat)) {
      othersAvg += avgMap[cat] || 0;
    }
  });
  avgMap['Прочие расходы'] = othersAvg;
  list.push({ name: 'Прочие расходы', icon: 'package' });

  container.innerHTML = list.map(cat => {
    const avg = Math.round(avgMap[cat.name] || 0);
    const existingVal = Cache.budgetPlan?.categoryLimits?.[cat.name] || (avg > 0 ? avg : '');

    return `
      <div class="p-3 rounded-2xl bg-[#12151C] border border-[rgba(255,255,255,0.04)] flex items-center justify-between gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-[#1E2330] text-gray-300 flex items-center justify-center flex-shrink-0">
          <i data-lucide="${cat.icon}" class="w-5 h-5 text-[#848D99]"></i>
        </div>
        
        <div class="flex-1 min-w-0 pr-1">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-gray-200 truncate">${escapeHtml(cat.name)}</span>
            ${cat.isCustom ? `<button type="button" onclick="removeWizardCustomCat('${escapeHtml(cat.name)}')" class="text-gray-500 hover:text-[#FF453A] text-xs font-bold cursor-pointer">✕</button>` : ''}
          </div>
          ${avg > 0 ? `
            <div onclick="applyWizCategoryAvg('${escapeHtml(cat.name)}', ${avg})" class="wiz-adopt-chip mt-1.5 whitespace-nowrap" title="Нажмите, чтобы применить">
              <span>В среднем: ~${formatMoney(avg)}</span>
              <span class="text-[#727cff] font-bold">↵</span>
            </div>
          ` : `
            <span class="text-[10px] text-[#848D99] mt-0.5 block">В среднем: нет данных</span>
          `}
        </div>

        <div class="w-28 flex-shrink-0">
          <input type="text"
                 inputmode="decimal"
                 data-wiz-cat="${escapeHtml(cat.name)}"
                 oninput="formatSumInput(this); updateWizLiveTotal();"
                 value="${existingVal ? formatMoney(existingVal) : ''}"
                 placeholder="0 ₽"
                 class="w-full bg-[#181B24] border border-[rgba(255,255,255,0.08)] text-white text-right font-mono font-bold text-xs rounded-xl px-2.5 py-2 outline-none focus:border-[#6C5DD3] transition-colors">
        </div>
      </div>
    `;
  }).join('');

  updateWizLiveTotal();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

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

function addCategoryToWizard(catName) {
  wizardCustomCategories.add(catName);
  const dlg = document.getElementById('custom-dialog');
  if (dlg) dlg.classList.add('hidden');
  renderWizLimitsEditor();
  showToast(`Категория «${catName}» добавлена`);
}

function removeWizardCustomCat(catName) {
  wizardCustomCategories.delete(catName);
  renderWizLimitsEditor();
}

function updateWizLiveTotal() {
  let total = 0;
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    total += getUnformattedVal(inp) || 0;
  });

  const totalEl = document.getElementById('wiz-limits-live-total');
  const weeklyEl = document.getElementById('wiz-live-weekly-estimate');
  if (totalEl) totalEl.innerText = `${formatMoney(total)}/мес`;
  if (weeklyEl) weeklyEl.innerText = `~${formatMoney(Math.round(total / 4.33))}`;
}

// Вспомогательный расчет истории трат из выписок
function calculateHistoricalCategoryAverages() {
  const map = {};
  const txMonths = Cache?.transactions || [];
  if (!txMonths.length) return map;

  let minTime = Infinity;
  let maxTime = -Infinity;
  const catTotals = {};

  txMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      const t = tx.timestamp || (tx.rawDate ? new Date(tx.rawDate).getTime() : null);
      if (t) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }

      if (tx.type === 'Расход' && tx.category) {
        const val = parseFloat(tx.amount) || 0;
        catTotals[tx.category] = (catTotals[tx.category] || 0) + val;
      }
    });
  });

  if (minTime === Infinity || maxTime === -Infinity) return map;

  const diffDays = Math.max(1, Math.round((maxTime - minTime) / (1000 * 60 * 60 * 24)) + 1);
  const effectiveDays = Math.min(90, diffDays);
  const monthFactor = 30.44 / effectiveDays;

  Object.keys(catTotals).forEach(cat => {
    map[cat] = Math.round(catTotals[cat] * monthFactor);
  });

  return map;
}

// Расчет финансовой квитанции на Шаге 5
function calculateAndRenderWizSummary() {
  const income = getUnformattedVal(document.getElementById('wiz-income-input')) || 0;
  
  // Считаем обязательные платежи из календаря
  const bills = Cache.calendarBills || [];
  const billsTotal = bills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);

  // Считаем сумму установленных лимитов
  let limitsTotal = 0;
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    limitsTotal += getUnformattedVal(inp) || 0;
  });

  const surplus = Math.max(0, income - billsTotal - limitsTotal);
  const weekly = limitsTotal > 0 ? Math.round(limitsTotal / 4.33) : 0;

  const goalTarget = getUnformattedVal(document.getElementById('wiz-goal-target')) || 100000;
  const goalSaved = getUnformattedVal(document.getElementById('wiz-goal-saved')) || 0;
  const remainingToGoal = Math.max(0, goalTarget - goalSaved);
  const monthsToGoal = surplus > 0 ? Math.ceil(remainingToGoal / surplus) : 0;

  document.getElementById('wiz-sum-income').innerText = formatMoney(income);
  document.getElementById('wiz-sum-bills').innerText = `-${formatMoney(billsTotal)}`;
  document.getElementById('wiz-sum-limits').innerText = `-${formatMoney(limitsTotal)}`;
  document.getElementById('wiz-sum-surplus').innerText = `+${formatMoney(surplus)}/мес`;
  document.getElementById('wiz-sum-week').innerText = formatMoney(weekly);
  document.getElementById('wiz-sum-timeline').innerText = monthsToGoal > 0 ? `~${monthsToGoal} мес.` : 'Цель достигнута!';
}

async function finishBudgetOnboarding() {
  showToast('Запуск бюджета...', false, true);

  const goalName = document.getElementById('wiz-goal-name').value.trim() || 'Новая цель';
  const goalTarget = getUnformattedVal(document.getElementById('wiz-goal-target')) || 100000;
  const goalSaved = getUnformattedVal(document.getElementById('wiz-goal-saved')) || 0;
  const income = getUnformattedVal(document.getElementById('wiz-income-input')) || 0;

  // 1. Собираем установленные лимиты категорий
  let limitsTotal = 0;
  const categoryLimits = {};
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    const val = getUnformattedVal(inp);
    if (val > 0) {
      limitsTotal += val;
      categoryLimits[inp.dataset.wizCat] = val;
    }
  });

  try {
    const batch = db.batch();

    // 2. Создаем или обновляем первую цель накопления
    const goalsCol = getUserCol('Goals');
    const existingGoalsSnap = await goalsCol.limit(1).get();
    let targetGoalRef;

    if (!existingGoalsSnap.empty) {
      targetGoalRef = existingGoalsSnap.docs[0].ref;
      batch.update(targetGoalRef, {
        name: goalName,
        target: goalTarget,
        saved: goalSaved,
        share: 100,
        status: goalSaved >= goalTarget ? 'Выполнена' : 'В процессе',
        updatedAt: Date.now()
      });
    } else {
      targetGoalRef = goalsCol.doc();
      batch.set(targetGoalRef, {
        name: goalName,
        target: goalTarget,
        saved: goalSaved,
        share: 100,
        status: goalSaved >= goalTarget ? 'Выполнена' : 'В процессе',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // 3. Сохраняем генеральный план бюджета
    const planRef = getUserCol('BudgetPlan').doc('plan');
    batch.set(planRef, {
      isConfigured: true,
      monthlyIncome: income,
      monthlyVariableLimit: limitsTotal > 0 ? limitsTotal : Math.max(0, income - 40000), // Фоллбэк
      categoryLimits: categoryLimits,
      updatedAt: Date.now()
    }, { merge: true });

    // 4. Коммитим все изменения единым пакетом
    await batch.commit();

    // 5. Полная перезагрузка актуальных данных и переход к дашборду
    await fetchAllData();
    // Сброс сохраненного шага после успешного запуска бюджета
    localStorage.removeItem('budget_wizard_step');
    currentWizardStep = 1;

    showToast('Бюджет успешно активирован!');
  } catch (err) {
    console.error('Ошибка активации бюджета:', err);
    showToast('Ошибка сохранения: ' + err.message, true);
  }
}

function openCategoryLimitModal(catName, currentLimit) {
  activeEditCategory = catName;
  const dlg = document.getElementById('category-limit-dialog');
  const title = document.getElementById('category-limit-title');
  const inp = document.getElementById('category-limit-amount');

  if (title) title.innerText = catName;
  if (inp) setFormattedVal('category-limit-amount', currentLimit || '');
  if (dlg) dlg.classList.remove('hidden');
}

function closeCategoryLimitModal() {
  const dlg = document.getElementById('category-limit-dialog');
  if (dlg) dlg.classList.add('hidden');
  activeEditCategory = null;
}

async function submitCategoryLimit() {
  if (!activeEditCategory) return;
  const amount = getUnformattedVal(document.getElementById('category-limit-amount'));
  const plan = Cache?.budgetPlan || {};
  const limits = plan.categoryLimits || {};

  if (amount > 0) limits[activeEditCategory] = amount;
  else delete limits[activeEditCategory];

  const totalVarLimit = Object.values(limits).reduce((s, v) => s + v, 0);

  showToast('Сохранение лимита...', false, true);
  try {
    await getUserCol('BudgetPlan').doc('plan').set({
      ...plan,
      isConfigured: true,
      monthlyVariableLimit: totalVarLimit,
      categoryLimits: limits
    }, { merge: true });

    closeCategoryLimitModal();
    await fetchAllData();
    showToast('Лимит обновлен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

function applyWizCategoryAvg(catName, avg) {
  const inp = document.querySelector(`[data-wiz-cat="${catName}"]`);
  if (inp) {
    inp.value = formatMoney(avg);
    updateWizLiveTotal();
  }
}

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

// ==========================================
// 5. Global Scope Exports
// ==========================================
window.renderBudgetTab = renderBudgetTab;
window.renderBudgetCalendar = renderBudgetCalendar;
window.renderBudgetGoals = renderBudgetGoals;
window.renderBudgetCategoryLimits = renderBudgetCategoryLimits;
window.isBillPaidInCurrentMonth = isBillPaidInCurrentMonth;

// План бюджета
window.openBudgetPlanModal = openBudgetPlanModal;
window.closeBudgetPlanModal = closeBudgetPlanModal;
window.updatePlanForecast = updatePlanForecast;
window.submitBudgetPlan = submitBudgetPlan;

// Счета календаря
window.openAddBillModal = openAddBillModal;
window.closeAddBillModal = closeAddBillModal;
window.openEditBillModal = openEditBillModal;
window.submitCalendarBill = submitCalendarBill;
window.deleteCurrentEditingBill = deleteCurrentEditingBill;
window.toggleBillPaidStatus = toggleBillPaidStatus;
window.openDayBillsModal = openDayBillsModal;
window.closeDayBillsModal = closeDayBillsModal;
window.deleteCalendarBill = deleteCalendarBill;

// Цели и копилки
window.processGoals = processGoals;
window.getGoalIcon = getGoalIcon;
window.openGoalModal = openGoalModal;
window.closeGoalModal = closeGoalModal;
window.openEditGoalModal = openEditGoalModal;
window.submitBudgetGoal = submitBudgetGoal;
window.deleteCurrentEditingGoal = deleteCurrentEditingGoal;
window.deleteBudgetGoal = deleteBudgetGoal;
window.openGoalTopupModal = openGoalTopupModal;
window.closeGoalTopupModal = closeGoalTopupModal;
window.setTopupMode = setTopupMode;
window.submitGoalTopup = submitGoalTopup;

// Мастер (Онбординг)
window.initBudgetWizard = initBudgetWizard;
window.goToWizardStep = goToWizardStep;
window.openWizardIconPicker = openWizardIconPicker;
window.selectWizardGoalIcon = selectWizardGoalIcon;
window.updateWizGoalSlider = updateWizGoalSlider;
window.recalculateWizardIncome = recalculateWizardIncome;
window.adoptCalculatedIncome = adoptCalculatedIncome;
window.calculateHistoricalIncomeForWizard = calculateHistoricalIncomeForWizard;
window.toggleWizardIncomeSource = toggleWizardIncomeSource;
window.addAnotherBillFromTooltip = addAnotherBillFromTooltip;
window.renderWizCalendar = renderWizCalendar;
window.renderWizDayBillsList = renderWizDayBillsList;
window.openAddBillModalFromWizard = openAddBillModalFromWizard;
window.showWizDayTooltip = showWizDayTooltip;
window.closeWizDayTooltip = closeWizDayTooltip;
window.renderWizLimitsEditor = renderWizLimitsEditor;
window.openAddCategoryLimitPicker = openAddCategoryLimitPicker;
window.addCategoryToWizard = addCategoryToWizard;
window.removeWizardCustomCat = removeWizardCustomCat;
window.updateWizLiveTotal = updateWizLiveTotal;
window.calculateAndRenderWizSummary = calculateAndRenderWizSummary;
window.finishBudgetOnboarding = finishBudgetOnboarding;
window.openCategoryLimitModal = openCategoryLimitModal;
window.closeCategoryLimitModal = closeCategoryLimitModal;
window.submitCategoryLimit = submitCategoryLimit;
window.applyWizCategoryAvg = applyWizCategoryAvg;
window.handleWizardDayClick = handleWizardDayClick;
window.selectWizCalendarDay = handleWizardDayClick;
