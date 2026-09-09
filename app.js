// --- РЕГИСТРАЦИЯ PWA (SERVICE WORKER) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW сбой:', err));
  });
}

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyC_JkUF__UfStFrTKecRasKqKBKXlQ4D88",
  authDomain: "familybudget-4245a.firebaseapp.com",
  projectId: "familybudget-4245a",
  storageBucket: "familybudget-4245a.firebasestorage.app",
  messagingSenderId: "129164761119",
  appId: "1:129164761119:web:0303fd6ccd41e071655d2a"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

let Cache = null;
let currentEditId = null, currentEditTable = null;
let brokerChartObj = null;

// --- АВТОРИЗАЦИЯ ---
function loginUser(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerText = 'Вход...';
  auth.signInWithEmailAndPassword(
    document.getElementById('login-email').value,
    document.getElementById('login-password').value
  ).catch(err => {
    btn.disabled = false;
    btn.innerText = 'Войти';
    showToast('Ошибка: неверный email или пароль', true);
  });
}

function logoutUser() {
  showDialog('Выход', 'Точно выйти из аккаунта?', true, () => auth.signOut());
}

auth.onAuthStateChanged(user => {
  if (user) {
    document.getElementById('login-screen').classList.add('hidden');
    switchTab('transactions');
    fetchAllData();
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

// --- UI УТИЛИТЫ ---
const formatMoney = (sum) => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0
}).format(sum);

function formatSumInput(el) {
  let val = el.value.replace(/[^\d.,]/g, '').replace(',', '.');
  if (val) {
    let parts = val.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    el.value = parts.join('.');
  }
}

const getUnformattedVal = (el) => parseFloat(el.value.replace(/\s/g, '')) || 0;
const setFormattedVal = (id, val) => {
  const el = document.getElementById(id);
  el.value = val;
  formatSumInput(el);
};

function formatDateStr(dateStr, format) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  if (format === 'dd.MM.yyyy')
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (format === 'yyyy-MM')
    return d.toISOString().substring(0, 7);
  return d.toISOString().substring(0, 10);
}

function showToast(text, isError = false, keep = false) {
  const c = document.getElementById('toast-container');
  document.getElementById('toast-text').innerText = text;
  document.getElementById('toast-spinner').style.display = isError || keep === false ? 'none' : 'block';
  document.getElementById('toast-content').style.borderColor = isError ? '#ef4444' : (keep ? '#3b82f6' : '#10b981');
  c.classList.remove('hidden');
  if (!keep) setTimeout(() => c.classList.add('hidden'), 2500);
}

/* Кастомное диалоговое окно */
function showDialog(title, message, isConfirm, callback) {
  const dialog = document.getElementById('custom-dialog');
  document.getElementById('dialog-title').innerText = title;
  document.getElementById('dialog-message').innerText = message;
  const btns = document.getElementById('dialog-buttons');
  btns.innerHTML = '';

  if (isConfirm) {
    btns.innerHTML = `<button id="dialog-cancel" class="flex-1 bg-gray-700 text-white py-3 rounded-xl font-medium">Отмена</button>
                      <button id="dialog-ok" class="flex-1 bg-blue-600 text-white py-3 rounded-xl font-medium">ОК</button>`;
    document.getElementById('dialog-cancel').onclick = () => dialog.classList.add('hidden');
    document.getElementById('dialog-ok').onclick = () => {
      dialog.classList.add('hidden');
      if (callback) callback();
    };
  } else {
    btns.innerHTML = `<button id="dialog-ok" class="w-full bg-blue-600 text-white py-3 rounded-xl font-medium">Понятно</button>`;
    document.getElementById('dialog-ok').onclick = () => {
      dialog.classList.add('hidden');
      if (callback) callback();
    };
  }
  dialog.classList.remove('hidden');
}

// --- БД И ЛОГИКА ---
async function fetchCollection(table) {
  try {
    const querySnapshot = await db.collection(table).get();
    const data = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    switch (table) {
      case 'Transactions':
        Cache.transactions = processTransactions(data);
        renderTransactions();
        break;
      case 'Deposits':
        Cache.deposits = processDeposits(data, Cache.goals);
        renderDeposits();
        break;
      case 'Broker':
        Cache.broker = processBroker(data, Cache.goals);
        renderBroker();
        break;
      case 'Goals':
        // Цели влияют на вклады и брокера, поэтому обновляем всё
        await fetchAllData();
        break;
    }
  } catch (e) {
    showToast("Ошибка загрузки", true);
  }
}

async function fetchAllData() {
  showToast("Синхронизация...", false, true);
  try {
    const [txS, depS, brS, goalS] = await Promise.all([
      db.collection('Transactions').get(),
      db.collection('Deposits').get(),
      db.collection('Broker').get(),
      db.collection('Goals').get()
    ]);
    const txData = txS.docs.map(d => ({ id: d.id, ...d.data() }));
    const depData = depS.docs.map(d => ({ id: d.id, ...d.data() }));
    const brData = brS.docs.map(d => ({ id: d.id, ...d.data() }));
    const goalData = goalS.docs.map(d => ({ id: d.id, ...d.data() }));

    const processedDeposits = processDeposits(depData, goalData);
    const processedBroker = processBroker(brData, goalData);
    Cache = {
      transactions: processTransactions(txData),
      deposits: processedDeposits,
      broker: processedBroker,
      goals: processGoals(goalData, processedDeposits, processedBroker)
    };

    updateGoalDropdowns();
    renderTransactions();
    renderDeposits();
    renderBroker();
    renderGoals();
    document.getElementById('last-sync').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('toast-container').classList.add('hidden');
  } catch (err) {
    showToast("Ошибка", true);
  }
}

/* Универсальная функция добавления/обновления */
async function submitAction(btnId, table, data) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  showToast("Сохранение...", false, true);

  try {
    if (currentEditId && currentEditTable === table) {
      await db.collection(table).doc(currentEditId).update(data);
    } else if (Array.isArray(data)) {
      const batch = db.batch();
      data.forEach(item => batch.set(db.collection(table).doc(), item));
      await batch.commit();
    } else {
      await db.collection(table).add(data);
    }

    btn.disabled = false;
    btn.innerText = currentEditId ? 'Сохранить изменения' : btn.innerText;

    // Скрываем форму
    btn.closest('form').parentElement.classList.add('hidden');

    currentEditId = null;
    currentEditTable = null;

    // Оптимизированное обновление: только нужная коллекция
    if (table === 'Transactions') {
      await fetchCollection('Transactions');
      document.getElementById('toast-container').classList.add('hidden');
    } else {
      fetchAllData();
    }
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, true);
  }
}

function deleteRecord(table, id) {
  showDialog('Удаление', 'Точно удалить запись? Это нельзя отменить.', true, async () => {
    showToast("Удаление...", false, true);
    try {
      await db.collection(table).doc(id).delete();

      // Оптимизированное обновление
      if (table === 'Transactions') {
        await fetchCollection('Transactions');
        document.getElementById('toast-container').classList.add('hidden');
      } else {
        fetchAllData();
      }
    } catch (e) {
      showToast("Ошибка", true);
    }
  });
}

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
      rawStart: dep.startDate,
      rawEnd: dep.endDate,
      isClosed
    };
  });
}

function processBroker(ops, goals) {
  const goalsMap = {};
  goals.forEach(g => goalsMap[g.id] = g.name || '');
  let bal = 0, dep = 0, goalId = '', pts = [];
  ops.map(o => ({ ...o, d: o.date ? new Date(o.date) : new Date() }))
    .sort((a, b) => a.d - b.d)
    .forEach(o => {
      const s = parseFloat(o.amount) || 0;
      const ds = formatDateStr(o.date, 'dd.MM.yyyy');
      if (o.type === 'Цель') goalId = o.goalId || '';
      else if (o.type === 'Пополнение') {
        dep += s;
        bal += s;
        pts.push({ x: ds, y: bal });
      }
      else if (o.type === 'Баланс') {
        bal = s;
        pts.push({ x: ds, y: bal });
      }
    });
  return {
    balance: bal,
    totalDeposits: dep,
    profit: bal - dep,
    goalId,
    goalName: goalsMap[goalId] || '',
    chartData: pts
  };
}

function processGoals(goals, deps, br) {
  return goals.map(g => {
    const tar = parseFloat(g.target) || 0;
    let saved = deps.filter(d => d.goalId === g.id).reduce((acc, d) => acc + d.amount + d.currentInterest, 0);
    if (br && br.goalId === g.id) saved += br.balance;
    return {
      id: g.id,
      name: g.name,
      target: tar,
      saved,
      progress: Math.min(100, tar > 0 ? (saved / tar) * 100 : 0).toFixed(1),
      deadlineStr: g.deadline ? formatDateStr(g.deadline, 'dd.MM.yyyy') : "Без срока",
      rawDeadline: g.deadline || "",
      isAchieved: saved >= tar
    };
  });
}

// --- НАВИГАЦИЯ, ФОРМЫ, РЕНДЕР ---
function switchTab(tab) {
  ['transactions', 'deposits', 'broker', 'goals'].forEach(t => {
    document.getElementById(t + '-tab').classList.add('hidden');
    document.getElementById('nav-' + t).classList.replace('text-blue-400', 'text-gray-500');
  });
  document.getElementById(tab + '-tab').classList.remove('hidden');
  document.getElementById('nav-' + tab).classList.replace('text-gray-500', 'text-blue-400');
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
    } else if (type === 'broker-add') {
      document.getElementById('broker-type').value = 'Пополнение';
      document.getElementById('broker-date').value = today;
    } else if (type === 'broker-bal') {
      document.getElementById('broker-type').value = 'Баланс';
      document.getElementById('broker-date').value = today;
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
  document.getElementById('dep-goal').innerHTML = html;
  document.getElementById('broker-goal-select').innerHTML = html;
}

function addTxRow() {
  const clone = document.getElementById('tx-row-template').content.cloneNode(true);
  const uid = 'type_' + Math.random().toString(36).substr(2, 9);
  const radios = clone.querySelectorAll('.tx-type');
  radios[0].name = uid;
  radios[1].name = uid;
  clone.querySelector('.tx-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('tx-items-list').appendChild(clone);
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
  row.querySelector('.tx-category').value = cat;
  row.querySelector('.tx-comment').value = (comment && comment !== 'undefined') ? comment : '';
  document.getElementById('tx-submit-btn').innerText = 'Сохранить изменения';
  window.scrollTo(0, 0);
}

function renderTransactions() {
  const data = Cache.transactions || [];
  const curMonth = data.find(m => m.id === formatDateStr(new Date(), 'yyyy-MM')) || { expense: 0, income: 0 };
  document.getElementById('month-expense').innerText = formatMoney(curMonth.expense);
  document.getElementById('month-income').innerText = formatMoney(curMonth.income);

  if (data.length === 0) {
    document.getElementById('transactions-list').innerHTML = '<div class="text-center text-gray-500 py-4">Операций нет</div>';
    return;
  }

  document.getElementById('transactions-list').innerHTML = data.map(month => `
    <div class="pt-2 pb-1 border-b border-gray-800 flex justify-between items-end">
      <h3 class="font-bold text-gray-400 text-xs uppercase tracking-wider">${month.label}</h3>
      <span class="text-[10px] text-gray-500">Доход: ${formatMoney(month.income)} | Расход: ${formatMoney(month.expense)}</span>
    </div>
    <div class="space-y-3 mt-3">
      ${month.items.map(tx => {
        const isExp = tx.type === 'Расход';
        return `
          <div class="card bg-gray-800 p-3 rounded-2xl border border-gray-700 flex justify-between items-center relative" data-id="${tx.id}" data-table="Transactions">
            <input type="checkbox" class="select-checkbox" data-id="${tx.id}">
            <div class="flex-1 min-w-0">
              <p class="font-medium text-white text-sm">${tx.category}</p>
              <p class="text-[11px] text-gray-400">${tx.formattedDate} ${tx.comment ? '• ' + tx.comment : ''}</p>
            </div>
            <div class="text-right card-actions">
              <p class="font-bold text-sm ${isExp ? 'text-white' : 'text-emerald-400'} mb-1">${isExp ? '-' : '+'}${formatMoney(tx.amount)}</p>
              <div class="flex space-x-3 justify-end text-xs opacity-60">
                <button onclick="editTx('${tx.id}','${tx.type}',${tx.amount},'${tx.category}','${tx.comment}','${tx.rawDate}')">✏️</button>
                <button onclick="deleteRecord('Transactions','${tx.id}')" class="text-red-400">🗑️</button>
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>`).join('');
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

function renderDeposits() {
  const data = Cache.deposits || [];
  if (data.length === 0) {
    document.getElementById('deposits-list').innerHTML = '<div class="text-center text-gray-500 py-4">Вкладов нет</div>';
    return;
  }

  const active = data.filter(d => !d.isClosed);
  const closed = data.filter(d => d.isClosed);
  let html = '';

  const renderCard = (dep, isCls) => `
    <div class="card bg-gray-800 p-4 rounded-2xl border border-gray-700 relative overflow-hidden mb-4 ${isCls ? 'opacity-60 grayscale' : ''}" data-id="${dep.id}" data-table="Deposits">
      <input type="checkbox" class="select-checkbox" data-id="${dep.id}">
      ${dep.goalName ? `<div class="absolute top-0 right-0 bg-blue-600/20 text-blue-300 text-[9px] px-3 py-1 rounded-bl-lg font-bold uppercase tracking-wide border-b border-l border-blue-600/30">🎯 ${dep.goalName}</div>` : ''}
      <div class="flex justify-between items-start mb-2 ${dep.goalName ? 'pt-2' : ''}">
        <div>
          <h3 class="font-bold text-white">${dep.name}</h3>
          <p class="text-xs ${isCls ? 'text-gray-500' : 'text-gray-400'}">${isCls ? 'Закрыт ' : 'До '}${dep.endDateStr} • ${dep.rate}%</p>
        </div>
        <div class="text-right">
          <p class="font-bold text-lg text-white">${formatMoney(dep.amount)}</p>
          <div class="card-actions flex space-x-3 justify-end text-xs opacity-60 mt-1">
            ${!isCls ? `<button onclick="editDep('${dep.id}','${dep.name}',${dep.amount},${dep.rate},'${dep.rawStart}','${dep.rawEnd}','${dep.goalId}')">✏️</button>` : ''}
            <button onclick="deleteRecord('Deposits','${dep.id}')" class="text-red-400">🗑️</button>
          </div>
        </div>
      </div>
      <div class="bg-gray-900/50 rounded-lg p-3 mb-3 flex justify-between">
        <p class="font-bold text-emerald-400">+${formatMoney(dep.currentInterest)}</p>
        <p class="font-medium text-gray-300">+${formatMoney(dep.expectedInterest)}</p>
      </div>
      <div class="w-full bg-gray-700 rounded-full h-1.5">
        <div class="bg-blue-500 h-1.5 rounded-full" style="width:${dep.progress}%"></div>
      </div>
    </div>`;

  if (active.length > 0) {
    html += `<h3 class="text-xs text-gray-400 uppercase font-bold tracking-wider mb-3">Активные</h3>` + active.map(d => renderCard(d, false)).join('');
  }
  if (closed.length > 0) {
    html += `<h3 class="text-xs text-gray-400 uppercase font-bold tracking-wider mb-3 mt-6">Завершенные</h3>` + closed.map(d => renderCard(d, true)).join('');
  }
  document.getElementById('deposits-list').innerHTML = html;
}

function submitBrokerOperation(e) {
  e.preventDefault();
  submitAction('broker-submit-btn', 'Broker', {
    type: document.getElementById('broker-type').value,
    date: document.getElementById('broker-date').value,
    amount: getUnformattedVal(document.getElementById('broker-amount'))
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

function renderBroker() {
  const br = Cache.broker;
  if (!br) return;
  document.getElementById('broker-balance').innerText = formatMoney(br.balance);
  document.getElementById('broker-deposits').innerText = formatMoney(br.totalDeposits);
  const p = document.getElementById('broker-profit');
  p.innerText = (br.profit > 0 ? '+' : '') + formatMoney(br.profit);
  p.className = `text-xs font-bold ${br.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
  const b = document.getElementById('broker-goal-badge');
  if (br.goalName) {
    b.innerText = '🎯 ' + br.goalName;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

function drawBrokerChart() {
  const data = Cache.broker.chartData;
  if (!data || data.length === 0) return;
  const ctx = document.getElementById('brokerChart').getContext('2d');
  if (brokerChartObj) brokerChartObj.destroy();
  brokerChartObj = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.x.substring(0, 5)),
      datasets: [{
        label: 'Баланс',
        data: data.map(d => d.y),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        fill: true,
        tension: 0.1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
        }
      },
      scales: {
        x: {
          grid: { color: '#374151' },
          ticks: { color: '#9ca3af', font: { size: 10 } }
        },
        y: {
          grid: { color: '#374151' },
          ticks: {
            color: '#9ca3af',
            font: { size: 10 },
            callback: v => (v / 1000) + 'k'
          }
        }
      }
    }
  });
}

function submitGoal(e) {
  e.preventDefault();
  submitAction('goal-submit-btn', 'Goals', {
    name: document.getElementById('goal-name').value,
    target: getUnformattedVal(document.getElementById('goal-target')),
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

function renderGoals() {
  const data = Cache.goals || [];
  if (data.length === 0) {
    document.getElementById('goals-list').innerHTML = '<div class="text-center text-gray-500 py-4">Целей нет</div>';
    return;
  }
  document.getElementById('goals-list').innerHTML = data.map(g => `
    <div class="card bg-gray-800 p-4 rounded-2xl border border-gray-700 shadow-sm relative" data-id="${g.id}" data-table="Goals">
      <input type="checkbox" class="select-checkbox" data-id="${g.id}">
      <div class="flex justify-between items-start mb-3">
        <div>
          <h3 class="font-bold text-white">${g.name}</h3>
          ${g.isAchieved
            ? '<span class="text-emerald-400 text-[10px] font-bold uppercase">Достигнута</span>'
            : `<span class="text-xs text-gray-400">До ${g.deadlineStr}</span>`}
        </div>
        <div class="text-right">
          <p class="font-bold text-white">${g.progress}%</p>
          <div class="card-actions flex space-x-3 justify-end text-xs opacity-60 mt-1">
            <button onclick="editGoal('${g.id}','${g.name}',${g.target},'${g.rawDeadline}')">✏️</button>
            <button onclick="deleteRecord('Goals','${g.id}')" class="text-red-400">🗑️</button>
          </div>
        </div>
      </div>
      <div class="w-full bg-gray-700 rounded-full h-3 mb-2">
        <div class="${g.isAchieved ? 'bg-emerald-500' : 'bg-blue-500'} h-3 rounded-full" style="width:${g.progress}%"></div>
      </div>
      <div class="flex justify-between items-center text-sm">
        <span class="text-gray-300 font-medium">${formatMoney(g.saved)}</span>
        <span class="text-gray-500">из ${formatMoney(g.target)}</span>
      </div>
    </div>`).join('');
}

// ==================== РЕЖИМ МУЛЬТИВЫДЕЛЕНИЯ ====================
let selectionMode = false;
let selectedItems = new Set(); // ключи вида "table:id"
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;

function enableSelectionMode() {
  selectionMode = true;
  document.body.classList.add('selection-mode');

  let panel = document.getElementById('selection-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'selection-panel';
    panel.className = 'selection-panel';
    panel.innerHTML = `
      <span id="selected-count">Выбрано: 0</span>
      <button id="delete-selected" class="bg-red-600">Удалить</button>
      <button id="cancel-selection" class="cancel-selection">Отмена</button>
    `;
    document.body.appendChild(panel);
  }
  panel.style.display = 'flex';
  document.getElementById('selected-count').textContent = `Выбрано: ${selectedItems.size}`;
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
  
  // Обновляем счётчик
  document.getElementById('selected-count').textContent = `Выбрано: ${selectedItems.size}`;
  
  // Если не осталось выбранных элементов — выключаем режим выбора
  if (selectedItems.size === 0 && selectionMode) {
    disableSelectionMode();
  }
}

function cancelSelection() {
  disableSelectionMode();
}

async function deleteSelectedItems() {
  if (selectedItems.size === 0) return;
  showDialog('Удаление', `Удалить выбранные записи (${selectedItems.size})?`, true, async () => {
    showToast("Удаление...", false, true);
    try {
      const batch = db.batch();
      selectedItems.forEach(key => {
        const [table, id] = key.split(':');
        batch.delete(db.collection(table).doc(id));
      });
      await batch.commit();
      disableSelectionMode();
      fetchAllData();
    } catch (e) {
      showToast("Ошибка удаления", true);
    }
  });
}

// Обработчики долгого нажатия
function handleTouchStart(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  longPressTriggered = false;
  longPressTimer = setTimeout(() => {
  longPressTriggered = true;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 400);
  if (!selectionMode) enableSelectionMode();
  toggleItemSelection(card.dataset.id, card.dataset.table);
}, 500);
}

function handleTouchEnd(e) {
  clearTimeout(longPressTimer);
  if (longPressTriggered) {
    e.preventDefault(); // предотвращаем последующий click
  }
}

function handleTouchMove(e) {
  clearTimeout(longPressTimer);
}

function handleMouseDown(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  longPressTriggered = false;
  longPressTimer = setTimeout(() => {
  longPressTriggered = true;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 400);
  if (!selectionMode) enableSelectionMode();
  toggleItemSelection(card.dataset.id, card.dataset.table);
}, 500);
}

function handleMouseUp(e) {
  clearTimeout(longPressTimer);
}

function handleMouseMove(e) {
  clearTimeout(longPressTimer);
}

// Регистрация глобальных обработчиков
document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
document.addEventListener('mousemove', handleMouseMove);

document.addEventListener('click', (e) => {
  // Игнорируем первый клик после долгого нажатия
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  // Обработка кнопок панели выбора
  if (e.target.id === 'delete-selected') {
    deleteSelectedItems();
    return;
  }
  if (e.target.id === 'cancel-selection') {
    cancelSelection();
    return;
  }

  // Обработка кликов по карточкам в режиме выбора
  if (!selectionMode) return;
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.classList.contains('select-checkbox')) return;

  e.preventDefault();
  toggleItemSelection(card.dataset.id, card.dataset.table);
});
