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

function renderDeposits() {
  const data = Cache.deposits || [];

  if (data.length === 0) {
    document.getElementById('deposits-list').innerHTML =
      '<div class="text-center text-[#848D99] py-10 text-[13px]">Открытых вкладов нет</div>';
    if(typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const active = data.filter(d => !d.isClosed);
  const closed = data.filter(d => d.isClosed);

  let html = '';

  const renderCard = (dep, isCls) => `
    <div
      class="card bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl w-full mb-3 flex flex-col p-4 cursor-pointer overflow-hidden ${isCls ? 'opacity-50 grayscale' : ''}"
      data-id="${dep.id}"
      data-table="Deposits"
      ${!isCls ? `onclick="openCardContextMenu(event, '${escapeHtml(dep.name)}', () => editDep('${dep.id}','${escapeHtml(dep.name)}',${dep.amount},${dep.rate},'${dep.rawStart}','${dep.rawEnd}','${dep.goalId}'), () => deleteRecord('Deposits', '${dep.id}'))"` : ''}
    >
      <input type="checkbox" class="select-checkbox" data-id="${dep.id}">

      <div class="flex justify-between items-start w-full">
        <div class="flex items-center gap-3.5 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center flex-shrink-0">
            <i data-lucide="vault" class="w-5 h-5"></i>
          </div>
          <div class="min-w-0">
            <h3 class="text-[16px] font-semibold text-gray-200 truncate leading-tight">${escapeHtml(dep.name)}</h3>
            <p class="text-[12px] text-[#848D99] mt-0.5">${isCls ? `Закрыт ${dep.endDateStr} • ${dep.durationStr}` : `До ${dep.endDateStr}`} • ${dep.rate}% годовых</p>
          </div>
        </div>
        
        ${dep.goalName ? `
          <div class="deposit-goal-tag flex-shrink-0 ml-2">
            <span class="px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase bg-indigo-500/15 text-indigo-400 rounded-full border border-indigo-500/20 truncate max-w-[90px] inline-block">
              ${escapeHtml(dep.goalName)}
            </span>
          </div>
        ` : ''}
      </div>

      <div class="mt-4 flex items-end justify-between w-full">
        <div class="flex flex-col">
          <span class="text-[11px] text-[#848D99] font-medium tracking-wide mb-1 uppercase">Вложено: ${formatMoney(dep.amount)}</span>
          ${isCls ? `
            <div class="flex items-center gap-1.5 text-[14px]">
               <span class="text-[#30D158] font-semibold">+${formatMoney(dep.expectedInterest)}</span>
               <span class="text-[11px] text-[#848D99] font-normal">выплачено</span>
            </div>
          ` : `
            <div class="flex items-center gap-1.5 text-[14px]">
               <span class="text-[#30D158] font-semibold">+${formatMoney(dep.currentInterest)}</span>
               <span class="text-gray-700">/</span>
               <span class="text-gray-400">+${formatMoney(dep.expectedInterest)}</span>
            </div>
          `}
        </div>
      </div>

      <!-- Тонкая полоска прогресса (Material/iOS) -->
      <div class="w-full bg-[rgba(255,255,255,0.06)] h-[5px] rounded-full overflow-hidden mt-3">
        <div class="bg-[#32ADE6] h-full rounded-full transition-all" style="width:${dep.progress}%"></div>
      </div>

    </div>
  `;

  if (active.length > 0) {
    html += `<h3 class="font-semibold text-[#848D99] text-[13px] mb-3 px-1 tracking-wide mt-2">Активные вклады</h3>`;
    html += active.map(d => renderCard(d, false)).join('');
  }

  if (closed.length > 0) {
    html += `<h3 class="font-semibold text-[#848D99] text-[13px] mb-3 px-1 tracking-wide mt-4">Завершенные</h3>`;
    html += closed.map(d => renderCard(d, true)).join('');
  }

  document.getElementById('deposits-list').innerHTML = html;
  
  // Рендерим иконки Lucide внутри сгенерированного HTML
  if(typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function submitDeposit(e) {
  e.preventDefault();
  submitAction('dep-submit-btn', 'Deposits', {
    name: document.getElementById('dep-name').value,
    amount: getUnformattedVal(document.getElementById('dep-amount')),
    rate: getUnformattedVal(document.getElementById('dep-rate')),
    startDate: document.getElementById('dep-start').value,
    endDate: document.getElementById('dep-end').value,
    goalId: document.getElementById('dep-goal').value,
    status: 'Активен'
  });
}

function editDep(id, name, amount, rate, start, end, goalId) {
  currentEditId = id;
  currentEditTable = 'Deposits';
  document.getElementById('dep-name').value = name;
  setFormattedVal('dep-amount', amount);
  setFormattedVal('dep-rate', rate);
  document.getElementById('dep-start').value = start;
  document.getElementById('dep-end').value = end;
  document.getElementById('dep-goal').value = goalId || '';
  document.getElementById('dep-submit-btn').innerText = 'Сохранить изменения';
  document.getElementById('deposit-form-container').classList.remove('hidden');
  window.scrollTo(0, 0);
}

// Хелпер склонения месяцев для вкладов
function getDepositDurationStr(startDate, endDate) {
  const totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000));
  let months = Math.round(totalDays / 30.4375);
  if (months < 1) months = 1;

  const mod10 = months % 10;
  const mod100 = months % 100;
  if (mod100 >= 11 && mod100 <= 19) return `${months} месяцев`;
  if (mod10 === 1) return `${months} месяц`;
  if (mod10 >= 2 && mod10 <= 4) return `${months} месяца`;
  return `${months} месяцев`;
}

// ==========================================
// 2.  (Брокерский счет: расчеты и графики)
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

function renderBroker() {
  const br = Cache?.broker;
  if (!br) return;

  // Основной баланс
  document.getElementById('broker-balance').innerText = formatMoney(br.balance);

  // Базовый капитал и чистая прибыль
  const baseCapital = br.totalDeposits;
  const profit = br.profit;
  const yieldPct = baseCapital > 0 ? ((profit / baseCapital) * 100).toFixed(1) : 0;
  const isPos = profit >= 0;

  document.getElementById('broker-deposits').innerText = formatMoney(baseCapital);

  const yieldBadge = document.getElementById('broker-yield-badge');
  if (yieldBadge) {
    yieldBadge.innerText = `${isPos ? '+' : ''}${yieldPct}% (${isPos ? '+' : ''}${formatMoney(profit)}) за всё время`;
    yieldBadge.className = `px-2.5 py-0.5 rounded-full text-xs font-semibold ${isPos ? 'bg-[#30D158]/15 text-[#30D158]' : 'bg-[#FF453A]/15 text-[#FF453A]'}`;
  }

  // Бейдж привязанной цели
  const b = document.getElementById('broker-goal-badge');
  if (b) {
    if (br.goalName) {
      b.innerText = 'Цель: ' + br.goalName;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  // Отрисовка списка пополнений
  const list = document.getElementById('broker-deposits-list');
  if (list) {
    const deps = br.deposits || [];
    if (deps.length === 0) {
      list.innerHTML = `
        <div class="card rounded-2xl p-6 text-center flex flex-col items-center justify-center gap-3 mt-4 border border-[rgba(255,255,255,0.06)] bg-[#181B24]">
          <div class="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
            <i data-lucide="arrow-down-circle" class="w-6 h-6"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-gray-200">Пополнений пока нет</p>
            <p class="text-xs text-[#848D99] mt-0.5">Внесите первое пополнение, чтобы зафиксировать баланс</p>
          </div>
          <button type="button" onclick="toggleBrokerPopover('deposit', event)" class="mt-1 px-4 py-2.5 rounded-xl bg-[#6C5DD3] hover:bg-[#5b4ec2] text-white text-xs font-semibold transition-all active:scale-95 cursor-pointer">
            + Внести первое пополнение
          </button>
        </div>
      `;
    } else {
      list.innerHTML = `
        <h3 class="text-[11px] uppercase font-bold tracking-wider text-[#848D99] mt-5 mb-2.5 px-1">История пополнений</h3>
        <div class="space-y-2">
          ${deps.map(d => `
            <div class="card bg-[#181B24] rounded-2xl border border-[rgba(255,255,255,0.06)] p-3.5 flex justify-between items-center" data-id="${d.id}" data-table="Broker">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl bg-[#30D158]/10 text-[#30D158] flex items-center justify-center flex-shrink-0">
                  <i data-lucide="arrow-down-left" class="w-4 h-4"></i>
                </div>
                <div>
                  <p class="text-[15px] font-semibold text-[#30D158]">+${formatMoney(d.amount)}</p>
                  <p class="text-[11px] text-[#848D99] mt-0.5">${d.formattedDate} • Баланс: ${formatMoney(d.balance)}</p>
                </div>
              </div>
              <button type="button" onclick="deleteRecord('Broker','${d.id}')" class="text-gray-500 hover:text-[#FF453A] p-2 cursor-pointer transition-colors" title="Удалить"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();

  const brokerTab = document.getElementById('broker-tab');
  if (brokerTab && !brokerTab.classList.contains('hidden')) {
    drawBrokerChart();
  }
}

function drawBrokerChart() {
  const br = Cache?.broker;
  const canvas = document.getElementById('brokerChart');
  if (!canvas) return;

  const rawData = br?.chartData || [];
  const ctx = canvas.getContext('2d');

  if (brokerChartObj) {
    brokerChartObj.destroy();
    brokerChartObj = null;
  }

  if (rawData.length === 0) return;

  // 1. Фильтрация по выбранному таймфрейму
  const now = Date.now();
  let timeLimit = 0;
  if (currentBrokerTimeframe === '1M') timeLimit = now - 30 * 86400000;
  else if (currentBrokerTimeframe === '3M') timeLimit = now - 90 * 86400000;
  else if (currentBrokerTimeframe === '6M') timeLimit = now - 180 * 86400000;
  else if (currentBrokerTimeframe === '1Y') timeLimit = now - 365 * 86400000;

  let data = timeLimit > 0 ? rawData.filter(d => d.timestamp >= timeLimit) : rawData.slice();
  if (data.length === 0 && rawData.length > 0) {
    data = [rawData[rawData.length - 1]];
  }

  // 2. Короткие понятные имена месяцев по оси X вместо длинных дат
  const shortMonths = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const labels = data.map(d => {
    const dt = new Date(d.timestamp);
    return isNaN(dt.getTime()) ? d.x : shortMonths[dt.getMonth()];
  });

  // 3. Мягкий вертикальный градиент под кривой Безье
  const gradient = ctx.createLinearGradient(0, 0, 0, 180);
  gradient.addColorStop(0, 'rgba(108, 93, 211, 0.32)');
  gradient.addColorStop(1, 'rgba(108, 93, 211, 0.0)');

  brokerChartObj = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Баланс',
        data: data.map(d => d.y),
        borderColor: '#6C5DD3',
        borderWidth: 2.2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.38,
        pointRadius: data.map(d => d.type === 'Пополнение' ? 5 : 3.5),
        pointHoverRadius: 7,
        pointHitRadius: 20,
        pointBackgroundColor: data.map(d => d.type === 'Пополнение' ? '#30D158' : '#6C5DD3'),
        pointBorderColor: '#181B24',
        pointBorderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: true
      },
      onClick: (e, elements, chart) => {
        if (!elements || elements.length === 0) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update('none');
          const balEl = document.getElementById('broker-balance');
          if (balEl && br) balEl.innerText = formatMoney(br.balance);
          return;
        }

        const clickedIdx = elements[0].index;
        const activeElements = chart.tooltip.getActiveElements();

        // Повторный тап по той же точке закрывает тултип
        if (activeElements.length > 0 && activeElements[0].index === clickedIdx) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update('none');
          const balEl = document.getElementById('broker-balance');
          if (balEl && br) balEl.innerText = formatMoney(br.balance);
        } else {
          chart.setActiveElements([{ datasetIndex: 0, index: clickedIdx }]);
          chart.tooltip.setActiveElements([{ datasetIndex: 0, index: clickedIdx }], {
            x: elements[0].element.x,
            y: elements[0].element.y
          });
          chart.update('none');
          const pt = data[clickedIdx];
          const balEl = document.getElementById('broker-balance');
          if (balEl && pt) balEl.innerText = formatMoney(pt.y);
        }
      },
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          titleColor: '#848D99',
          titleFont: { size: 11, weight: '500' },
          bodyColor: '#ffffff',
          bodyFont: { size: 13, weight: 'bold' },
          padding: 9,
          cornerRadius: 12,
          displayColors: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const pt = data[items[0].dataIndex];
              return pt ? pt.fullDate : '';
            },
            label: (context) => {
              const pt = data[context.dataIndex];
              if (!pt) return '';
              const lines = [`Баланс: ${formatMoney(pt.y)}`];
              if (pt.type === 'Пополнение' && pt.depositAmount > 0) {
                lines.push(`Пополнение: +${formatMoney(pt.depositAmount)}`);
              }
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#848D99',
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6
          }
        },
        y: {
          display: false // Скрываем ось Y для чистоты минималистичного брокерского графика
        }
      }
    }
  });
  window.brokerChartObj = brokerChartObj;

  // Сброс баланса при завершении скраббинга
  canvas.onmouseleave = () => {
    const balEl = document.getElementById('broker-balance');
    if (balEl && br) balEl.innerText = formatMoney(br.balance);
  };
  canvas.ontouchend = () => {
    const balEl = document.getElementById('broker-balance');
    if (balEl && br) balEl.innerText = formatMoney(br.balance);
  };
}

function setBrokerTimeframe(tf) {
  currentBrokerTimeframe = tf;
  document.querySelectorAll('.broker-tf-btn').forEach(btn => {
    const isAct = btn.dataset.tf === tf;
    btn.className = `broker-tf-btn flex-1 py-1 text-center rounded-lg transition-all cursor-pointer ${isAct ? 'bg-[#212430] text-white font-semibold' : 'text-[#848D99] hover:text-white'}`;
  });
  drawBrokerChart();
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

// ==========================================
// 3. Broker UI (Поповеры и меню)
// ==========================================
function toggleBrokerPopover(type, e) {
  if (e) e.stopPropagation();
  const popDep = document.getElementById('broker-popover-deposit');
  const popBal = document.getElementById('broker-popover-balance');
  const goalMenu = document.getElementById('broker-goal-dropdown');
  if (goalMenu) goalMenu.classList.add('hidden');

  const today = new Date().toISOString().split('T')[0];

  if (type === 'deposit') {
    if (popBal) popBal.classList.add('hidden');
    if (popDep) {
      const isHidden = popDep.classList.contains('hidden');
      popDep.classList.toggle('hidden', !isHidden);
      if (isHidden) {
        document.getElementById('popover-dep-date').value = today;
        document.getElementById('popover-dep-amount').value = '';
        document.getElementById('popover-dep-balance').value = '';
      }
    }
  } else {
    if (popDep) popDep.classList.add('hidden');
    if (popBal) {
      const isHidden = popBal.classList.contains('hidden');
      popBal.classList.toggle('hidden', !isHidden);
      if (isHidden) {
        document.getElementById('popover-bal-date').value = today;
        document.getElementById('popover-bal-input').value = '';
      }
    }
  }
}

function closeAllBrokerPopovers() {
  const popDep = document.getElementById('broker-popover-deposit');
  const popBal = document.getElementById('broker-popover-balance');
  const goalMenu = document.getElementById('broker-goal-dropdown');
  if (popDep) popDep.classList.add('hidden');
  if (popBal) popBal.classList.add('hidden');
  if (goalMenu) goalMenu.classList.add('hidden');
}

async function submitBrokerPopover(type) {
  if (type === 'Пополнение') {
    const date = document.getElementById('popover-dep-date').value || new Date().toISOString().split('T')[0];
    const amount = getUnformattedVal(document.getElementById('popover-dep-amount'));
    const balance = getUnformattedVal(document.getElementById('popover-dep-balance')) || amount;
    if (!amount) return showToast('Введите сумму пополнения', true);
    
    closeAllBrokerPopovers();
    try {
      await getUserCol('Broker').add({ type: 'Пополнение', date, amount, balance });
      await fetchAllData();
      
    } catch (e) {
      showToast('Ошибка сохранения: ' + e.message, true);
    }
  } else {
    const date = document.getElementById('popover-bal-date').value || new Date().toISOString().split('T')[0];
    const balance = getUnformattedVal(document.getElementById('popover-bal-input'));
    if (!balance && balance !== 0) return showToast('Введите баланс', true);
    closeAllBrokerPopovers();
   
    try {
      await getUserCol('Broker').add({ type: 'Баланс', date, amount: balance, balance });
      await fetchAllData();
    } catch (e) {
      showToast('Ошибка сохранения: ' + e.message, true);
    }
  }
}

function toggleBrokerGoalDropdown(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('broker-goal-dropdown');
  if (!menu) return;

  const isClosed = menu.classList.contains('hidden');
  closeAllBrokerPopovers();

  if (isClosed) {
    menu.classList.remove('hidden');
  }
}

async function selectBrokerGoal(goalId) {
  closeAllBrokerPopovers();
  showToast('Сохранение цели...', false, true);
  try {
    const col = getUserCol('Broker');
    // Очищаем все предыдущие записи привязки цели
    const snap = await col.where('type', '==', 'Цель').get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));

    // Если выбрана конкретная цель — сохраняем её. Если "Без цели" — оставляем очищенным
    if (goalId) {
      const newDoc = col.doc();
      batch.set(newDoc, {
        type: 'Цель',
        date: new Date().toISOString().split('T')[0],
        goalId: goalId,
        timestamp: Date.now()
      });
    }

    await batch.commit();
    await fetchAllData();
  } catch (err) {
    showToast('Ошибка привязки цели: ' + err.message, true);
  }
}

// ==========================================
// 4. Global Event Listeners (Инвестиции)
// ==========================================
// Глобальный клик для закрытия поповеров брокера при клике в пустоту.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown-wrap') && !e.target.closest('.custom-dropdown-menu')) {
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
window.updateGoalDropdowns = updateGoalDropdowns;
