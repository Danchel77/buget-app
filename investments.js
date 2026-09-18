// ==========================================
// Variables & State
// ==========================================
let brokerChartObj = null;
let currentBrokerTimeframe = 'ALL';

// ==========================================
// 1. Deposits (Вклады)
// ==========================================
function processDeposits(deposits, goals) {
  const goalsMap = {};
  goals.forEach(g => goalsMap[g.id] = g.name || '');
  return deposits.map(dep => {
    const amount = parseFloat(dep.amount) || 0;
    const rate = parseFloat(dep.rate) || 0;
    const endDate = dep.endDate ? new Date(dep.endDate) : new Date();
    const startDate = dep.startDate ? new Date(dep.startDate) : new Date();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    const isClosed = dep.status === 'Закрыт' || today > end;

    const totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000));
    const daysPassed = isClosed ? totalDays : Math.max(0, Math.min(Math.round((new Date() - startDate) / 86400000), totalDays));
    const goalIdStr = isClosed ? '' : (dep.goalId || '');
    const durationStr = getDepositDurationStr(startDate, endDate);

    return {
      id: dep.id,
      name: dep.name,
      amount,
      rate,
      goalId: goalIdStr,
      goalName: goalsMap[goalIdStr] || '',
      currentInterest: daysPassed * (amount * (rate / 100) / 365),
      expectedInterest: totalDays * (amount * (rate / 100) / 365),
      progress: Math.min(100, (daysPassed / totalDays) * 100).toFixed(1),
      endDateStr: formatDateStr(dep.endDate, 'dd.MM.yyyy'),
      durationStr,
      rawStart: dep.startDate,
      rawEnd: dep.endDate,
      isClosed
    };
  });
}

function renderDeposits() // Без изменений

function submitDeposit(e) // Без изменений

function editDep(id) // Без изменений

function getDepositDurationStr(dep) // Без изменений

// ==========================================
// 2. Broker (Брокерский счет: расчеты и графики)
// ==========================================
function processBroker(ops, goals) {
  const goalsMap = {};
  goals.forEach(g => goalsMap[g.id] = g.name || '');
  let goalId = '';
  let totalDeposits = 0;
  const depositList = [];
  const points = [];

  // Находим актуальную цель (самая свежая запись типа 'Цель')
  const goalOps = ops.filter(o => o.type === 'Цель');
  if (goalOps.length > 0) {
    goalOps.sort((a, b) => (b.timestamp || new Date(b.date || 0).getTime()) - (a.timestamp || new Date(a.date || 0).getTime()));
    goalId = goalOps[0].goalId || '';
  }

  ops.forEach(o => {
    if (o.type === 'Цель') return;

    const rawDate = o.date || new Date().toISOString().split('T')[0];
    const ds = formatDateStr(rawDate, 'dd.MM');
    const fullDate = formatDateStr(rawDate, 'dd.MM.yyyy');
    const timestamp = new Date(rawDate).getTime();

    if (o.type === 'Пополнение') {
      const depAmount = parseFloat(o.amount) || 0;
      const balAfter = parseFloat(o.balance !== undefined ? o.balance : o.amount) || 0;
      totalDeposits += depAmount;

      depositList.push({
        id: o.id,
        date: rawDate,
        formattedDate: fullDate,
        amount: depAmount,
        balance: balAfter,
        timestamp
      });

      points.push({
        x: ds,
        fullDate,
        y: balAfter,
        type: 'Пополнение',
        depositAmount: depAmount,
        timestamp
      });
    } else if (o.type === 'Баланс') {
      const bal = parseFloat(o.balance !== undefined ? o.balance : o.amount) || 0;
      points.push({
        x: ds,
        fullDate,
        y: bal,
        type: 'Баланс',
        depositAmount: 0,
        timestamp
      });
    }
  });

  // Точки на графике сортируем от старых к новым
  points.sort((a, b) => a.timestamp - b.timestamp);

  // Карточки пополнений сортируем от новых к старым
  depositList.sort((a, b) => b.timestamp - a.timestamp);

  // Текущий баланс — последняя точка по времени
  const currentBalance = points.length > 0 ? points[points.length - 1].y : 0;

  // Базовый капитал: если первая точка была фиксацией баланса, базовый капитал = баланс первой точки + последующие пополнения
  let baseCapital = 0;
  if (points.length > 0) {
    const firstPoint = points[0];
    if (firstPoint.type === 'Баланс') {
      const subsequentDeposits = points.slice(1).filter(p => p.type === 'Пополнение').reduce((s, p) => s + (p.depositAmount || 0), 0);
      baseCapital = firstPoint.y + subsequentDeposits;
    } else {
      baseCapital = totalDeposits;
    }
  } else {
    baseCapital = totalDeposits;
  }

  const profit = currentBalance - baseCapital;

  return {
    balance: currentBalance,
    totalDeposits: baseCapital,
    profit: profit,
    goalId,
    goalName: goalsMap[goalId] || '',
    chartData: points,
    deposits: depositList
  };
}

function renderBroker() // Без изменений

function drawBrokerChart(canvasId, historyData) // Без изменений

function setBrokerTimeframe(tf) // Без изменений


// ==========================================
// 3. Broker UI (Поповеры и меню)
// ==========================================

function toggleBrokerPopover(id, type) // Без изменений

function closeAllBrokerPopovers() // Без изменений

function submitBrokerPopover(id, type) // Без изменений

function toggleBrokerGoalDropdown(id) // Без изменений

function selectBrokerGoal(id, goalName) // Без изменений


// ==========================================
// 4. Global Event Listeners (Инвестиции)
// ==========================================

// Глобальный клик для закрытия поповеров брокера при клике в пустоту.
// (Если в вашем коде есть похожий обработчик рядом с closeAllBrokerPopovers — вставьте его сюда).
document.addEventListener('click', (e) => {
  if (!e.target.closest('.broker-item') && !e.target.closest('.broker-popover')) {
    if (typeof closeAllBrokerPopovers === 'function') closeAllBrokerPopovers();
  }
});


// ==========================================
// 5. Global Scope Exports
// ==========================================
window.processDeposits = processDeposits;
window.renderDeposits = renderDeposits;
window.submitDeposit = submitDeposit;
window.editDep = editDep;
window.getDepositDurationStr = getDepositDurationStr;

window.processBroker = processBroker;
window.renderBroker = renderBroker;
window.drawBrokerChart = drawBrokerChart;
window.setBrokerTimeframe = setBrokerTimeframe;
window.toggleBrokerPopover = toggleBrokerPopover;
window.closeAllBrokerPopovers = closeAllBrokerPopovers;
window.submitBrokerPopover = submitBrokerPopover;
window.toggleBrokerGoalDropdown = toggleBrokerGoalDropdown;
window.selectBrokerGoal = selectBrokerGoal;
