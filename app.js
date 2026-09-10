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
let monthlyChartObj = null;
let categoryChartObj = null;

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

// Показываем экран загрузки сразу при старте
document.getElementById('loading-screen').classList.remove('hidden');

auth.onAuthStateChanged(user => {
  // Скрываем экран загрузки в любом случае
  document.getElementById('loading-screen').classList.add('hidden');
  
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
    const [txS, depS, brS, goalS, catS] = await Promise.all([
      db.collection('Transactions').get(),
      db.collection('Deposits').get(),
      db.collection('Broker').get(),
      db.collection('Goals').get(),
      db.collection('Categories').get()
    ]);
    const txData = txS.docs.map(d => ({ id: d.id, ...d.data() }));
    const depData = depS.docs.map(d => ({ id: d.id, ...d.data() }));
    const brData = brS.docs.map(d => ({ id: d.id, ...d.data() }));
    const goalData = goalS.docs.map(d => ({ id: d.id, ...d.data() }));

    const processedDeposits = processDeposits(depData, goalData);
    const processedBroker = processBroker(brData, goalData);
    const catData = catS.docs.map(d => ({ id: d.id, ...d.data() }));
    const categories = processCategories(catData);
    Cache = {
      transactions: processTransactions(txData),
      deposits: processedDeposits,
      broker: processedBroker,
      goals: processGoals(goalData, processedDeposits, processedBroker),
      categories: categories
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

function processCategories(cats) {
  const defaultExpense = [
    { name: 'Продукты', icon: '🍔' },
    { name: 'Транспорт', icon: '🚗' },
    { name: 'Жилье', icon: '🏠' },
    { name: 'Развлечения', icon: '🎬' },
    { name: 'Другое', icon: '📦' }
  ];
  const defaultIncome = [
    { name: 'Зарплата', icon: '💼' },
    { name: 'Другое', icon: '📦' }
  ];

  const expense = [...defaultExpense];
  const income = [...defaultIncome];

  cats.forEach(c => {
    if (c.type === 'Расход') {
      if (!expense.some(item => item.name === c.name)) {
        expense.push({ name: c.name, icon: c.icon || '📦' });
      }
    } else if (c.type === 'Доход') {
      if (!income.some(item => item.name === c.name)) {
        income.push({ name: c.name, icon: c.icon || '📦' });
      }
    }
  });

  return { expense, income };
}

function showAddCategoryDialog(type, selectEl) {
  currentCategoryType = type;
  currentCategorySelect = selectEl;
  selectedCategoryIcon = '📦';
  document.getElementById('category-dialog-title').innerText = `Новая категория (${type})`;
  document.getElementById('category-name-input').value = '';
  renderIconGrid();
  document.getElementById('category-dialog').classList.remove('hidden');
}

function renderIconGrid() {
  const grid = document.getElementById('category-icon-grid');
  grid.innerHTML = availableIcons.map(icon => `
    <button type="button" class="icon-option ${icon === selectedCategoryIcon ? 'selected' : ''}" data-icon="${icon}">${icon}</button>
  `).join('');
  grid.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategoryIcon = btn.dataset.icon;
      grid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
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
    await db.collection('Categories').add({ name, type: currentCategoryType, icon: selectedCategoryIcon });
    const arr = currentCategoryType === 'Доход' ? Cache.categories.income : Cache.categories.expense;
    arr.push({ name, icon: selectedCategoryIcon });
    updateCategorySelect(currentCategorySelect, currentCategoryType);
    document.getElementById('category-dialog').classList.add('hidden');
    showToast('Категория добавлена');
  } catch (e) {
    showToast('Ошибка', true);
  }
});

function showManageCategoriesDialog() {
  renderManageCategories();
  document.getElementById('manage-categories-dialog').classList.remove('hidden');
}

function renderManageCategories() {
  const container = document.getElementById('categories-list-container');
  let html = `<p class="text-xs text-gray-400 mb-2">Расходы</p>`;
  Cache.categories.expense.forEach(cat => {
    const isDefault = ['Продукты', 'Транспорт', 'Жилье', 'Развлечения', 'Другое'].includes(cat.name);
    html += `
      <div class="flex justify-between items-center py-2 border-b border-gray-700">
        <span>${cat.icon} ${escapeHtml(cat.name)}</span>
        ${!isDefault ? `<button class="text-red-400 text-xs" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Расход')">✕</button>` : ''}
      </div>`;
  });
  html += `<p class="text-xs text-gray-400 mt-4 mb-2">Доходы</p>`;
  Cache.categories.income.forEach(cat => {
    const isDefault = ['Зарплата', 'Другое'].includes(cat.name);
    html += `
      <div class="flex justify-between items-center py-2 border-b border-gray-700">
        <span>${cat.icon} ${escapeHtml(cat.name)}</span>
        ${!isDefault ? `<button class="text-red-400 text-xs" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Доход')">✕</button>` : ''}
      </div>`;
  });
  container.innerHTML = html;
}

async function deleteCategory(name, type) {
  showDialog('Удаление', `Удалить категорию "${name}"?`, true, async () => {
    try {
      // Найти документ по name и type
      const snapshot = await db.collection('Categories')
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
});

function updateCategorySelect(selectEl, type) {
  if (!Cache || !Cache.categories) return;
  const cats = type === 'Доход' ? Cache.categories.income : Cache.categories.expense;
  selectEl.innerHTML = '<option value="" disabled selected>Категория...</option>' +
    cats.map(c => `<option value="${escapeHtml(c.name)}">${c.icon} ${escapeHtml(c.name)}</option>`).join('');
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

  const row = clone.querySelector('.tx-item');
  row.querySelector('.tx-date').value = new Date().toISOString().split('T')[0];

  // Обработчики переключения типа для обновления категорий
  row.querySelectorAll('.tx-type').forEach(input => {
    input.addEventListener('change', (e) => {
      const select = row.querySelector('.tx-category');
      updateCategorySelect(select, e.target.value);
    });
  });

  // Инициализация категорий для выбранного по умолчанию типа
  const initialType = row.querySelector('.tx-type:checked').value;
  updateCategorySelect(row.querySelector('.tx-category'), initialType);

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
    document.getElementById('transactions-list').innerHTML =
      '<div class="text-center text-gray-500 py-4">Операций нет</div>';
    return;
  }

  document.getElementById('transactions-list').innerHTML = data.map(month => `
    <div class="pt-2 pb-1 border-b border-gray-800 flex justify-between items-end">
      <h3 class="font-bold text-gray-400 text-xs uppercase tracking-wider">${month.label}</h3>
      <span class="text-[10px] text-gray-500">
        Доход: ${formatMoney(month.income)} | Расход: ${formatMoney(month.expense)}
      </span>
    </div>

    <div class="space-y-3 mt-3">
      ${month.items.map(tx => {
        const isExp = tx.type === 'Расход';

        return `
          <div class="card transaction-card" data-id="${tx.id}" data-table="Transactions">
            <div class="tx-main-info">
              <p class="tx-category">
                ${(() => {
                  const catList = Cache.categories[tx.type === 'Расход' ? 'expense' : 'income'] || [];
                  const cat = catList.find(c => c.name === tx.category);
                  return cat ? `<span class="tx-category__icon">${cat.icon}</span>` : '';
                })()}
                <span>${escapeHtml(tx.category)}</span>
              </p>
              <p class="tx-meta">
                ${tx.formattedDate}${tx.comment ? ' • ' + escapeHtml(tx.comment) : ''}
              </p>
            </div>

            <p class="tx-amount ${isExp ? 'text-red-400' : 'text-emerald-400'}">
              ${isExp ? '-' : '+'}${formatMoney(tx.amount)}
            </p>

            <div class="card-actions">
              <button onclick="deleteRecord('Transactions','${tx.id}')" class="card-action-btn delete-btn" title="Удалить">✕</button>
              <button onclick="editTx('${tx.id}','${tx.type}',${tx.amount},'${escapeHtml(tx.category)}','${escapeHtml(tx.comment)}','${tx.rawDate}')" class="card-action-btn" title="Редактировать">✎</button>
            </div>

            <input type="checkbox" class="select-checkbox" data-id="${tx.id}">
          </div>
        `;
      }).join('')}
    </div>
  `).join('');
}

function switchTransactionView(view) {
  const isChart = view === 'chart';
  const list = document.getElementById('transactions-list');
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

function buildCharts() {
  if (!Cache || !Cache.transactions) return;
  const months = Cache.transactions;
  if (!months.length) return;

  const chronological = months.slice().reverse();
  const lastMonths = chronological.slice(-8);
  const labels = lastMonths.map(m => m.label);
  const expenses = lastMonths.map(m => Number(m.expense) || 0);
  const incomes = lastMonths.map(m => Number(m.income) || 0);
  const net = lastMonths.map((m, i) => incomes[i] - expenses[i]);

  const select = document.getElementById('chart-month-select');
  select.innerHTML = months.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  const currentSelected = select.dataset.selectedMonth;
  select.value = months.some(m => m.id === currentSelected) ? currentSelected : months[0].id;
  select.onchange = () => {
    select.dataset.selectedMonth = select.value;
    updateAnalyticsForMonth(select.value);
  };
  updateAnalyticsForMonth(select.value);

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
          backgroundColor: 'rgba(54,214,155,.88)',
          borderColor: '#36d69b',
          borderWidth: 0,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        },
        {
          label: 'Расходы',
          data: expenses,
          backgroundColor: 'rgba(255,111,125,.88)',
          borderColor: '#ff6f7d',
          borderWidth: 0,
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
      interaction: { mode: 'index', intersect: true },
      events: ['mousemove', 'mouseout', 'click'],
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
          displayColors: true,
          callbacks: { label: context => `${context.dataset.label}: ${formatMoney(context.raw)}` }
        }
      }
    }
  });

  const netEl = document.getElementById('analytics-net');
  if (netEl) {
    const current = net[net.length - 1] || 0;
    netEl.textContent = `${current >= 0 ? '+' : ''}${formatMoney(current)}`;
    netEl.classList.toggle('is-negative', current < 0);
  }
}

function formatCompactChartMoney(value) {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + ' млн';
  if (Math.abs(value) >= 1000) return Math.round(value / 1000) + 'k';
  return value;
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

  const catMap = {};
  month.items.filter(tx => tx.type === 'Расход').forEach(tx => {
    catMap[tx.category] = (catMap[tx.category] || 0) + (Number(tx.amount) || 0);
  });
  const entries = Object.entries(catMap).sort((a,b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const data = entries.map(([,value]) => value);
  const colors = ['#7b83ff', '#36d69b', '#f3b65a', '#ff6f7d', '#a878ff', '#ef79b4', '#36bfc0', '#f58b55'];
  const total = data.reduce((sum, value) => sum + value, 0);

  const totalEl = document.getElementById('category-total');
  const legendEl = document.getElementById('category-legend');
  if (totalEl) totalEl.textContent = formatMoney(total);
  if (legendEl) {
    legendEl.innerHTML = entries.length ? entries.slice(0, 6).map(([label, value], i) => `
      <div class="category-legend__item">
        <span class="category-legend__dot" style="background:${colors[i % colors.length]}"></span>
        <span class="category-legend__name">${escapeHtml(label)}</span>
        <span class="category-legend__value">${formatMoney(value)}</span>
        <span class="category-legend__percent">${total ? Math.round(value / total * 100) : 0}%</span>
      </div>`).join('') : '<div class="analytics-empty">Нет расходов за выбранный месяц</div>';
  }

  const ctx = document.getElementById('categoryExpensesChart').getContext('2d');
  if (categoryChartObj) categoryChartObj.destroy();
  categoryChartObj = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.length ? labels : ['Нет расходов'],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: data.length ? colors.slice(0, data.length) : ['#303740'],
        borderColor: '#171d24',
        borderWidth: 3,
        hoverOffset: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 450 },
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

  const top = entries[0];
  const topEl = document.getElementById('analytics-top-category');
  if (topEl) topEl.textContent = top ? `${top[0]} · ${formatMoney(top[1])}` : 'Нет данных';
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
    document.getElementById('deposits-list').innerHTML =
      '<div class="text-center text-gray-500 py-4">Вкладов нет</div>';
    return;
  }

  const active = data.filter(d => !d.isClosed);
  const closed = data.filter(d => d.isClosed);

  let html = '';

  const renderCard = (dep, isCls) => `
    <div
      class="card deposit-card ${isCls ? 'opacity-60 grayscale' : ''}"
      data-id="${dep.id}"
      data-table="Deposits">

      <input
        type="checkbox"
        class="select-checkbox"
        data-id="${dep.id}">

      <button
        onclick="deleteRecord('Deposits','${dep.id}')"
        class="delete-btn deposit-delete-btn"
        title="Удалить"
        aria-label="Удалить вклад">✕</button>

      ${dep.goalName ? `
        <div class="deposit-goal-badge">
          Цель: ${escapeHtml(dep.goalName)}
        </div>
      ` : ''}

      <div class="deposit-main">
        <h3>${escapeHtml(dep.name)}</h3>
        <p>
          ${isCls ? 'Закрыт ' : 'До '}
          ${dep.endDateStr} • ${dep.rate}%
        </p>
      </div>

      <p class="deposit-amount">
        ${formatMoney(dep.amount)}
      </p>

      ${!isCls ? `
        <button
          onclick="editDep('${dep.id}','${escapeHtml(dep.name)}',${dep.amount},${dep.rate},'${dep.rawStart}','${dep.rawEnd}','${dep.goalId}')"
          class="deposit-edit-btn"
          aria-label="Редактировать">✎</button>
      ` : ''}

      <div class="deposit-interest">
        <p class="deposit-current-interest">
          +${formatMoney(dep.currentInterest)}
        </p>

        <p class="deposit-expected-interest">
          +${formatMoney(dep.expectedInterest)}
        </p>
      </div>

      <div class="deposit-progress">
        <div style="width:${dep.progress}%"></div>
      </div>

    </div>
  `;

  if (active.length > 0) {
    html += `
      <h3 class="deposit-section-title">
        Активные
      </h3>
    `;

    html += active.map(d => renderCard(d, false)).join('');
  }

  if (closed.length > 0) {
    html += `
      <h3 class="deposit-section-title deposit-section-title--closed">
        Завершенные
      </h3>
    `;

    html += closed.map(d => renderCard(d, true)).join('');
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
    b.innerText = 'Цель: ' + br.goalName;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
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
        <div class="card goal-card" data-id="${g.id}" data-table="Goals">
      <input type="checkbox" class="select-checkbox" data-id="${g.id}">

      <button
        onclick="deleteRecord('Goals','${g.id}')"
        class="goal-delete-btn"
        title="Удалить"
      >✕</button>

      <div class="goal-main">
        <h3>${escapeHtml(g.name)}</h3>
        ${g.isAchieved
          ? '<span class="goal-status goal-status--achieved">Достигнута</span>'
          : `<span class="goal-date">До ${escapeHtml(g.deadlineStr)}</span>`}
      </div>

      <div class="goal-progress-value">${g.progress}%</div>

      <button
        onclick="editGoal('${g.id}','${escapeHtml(g.name)}',${g.target},'${escapeHtml(g.rawDeadline)}')"
        class="goal-edit-btn"
        title="Редактировать"
      >✎</button>

      <div class="goal-progress">
        <div
          class="${g.isAchieved ? 'goal-progress-fill goal-progress-fill--achieved' : 'goal-progress-fill'}"
          style="width:${g.progress}%"
        ></div>
      </div>

      <div class="goal-amounts">
        <span>${formatMoney(g.saved)}</span>
        <span>из ${formatMoney(g.target)}</span>
      </div>
    </div>`).join('');
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
let selectionMode = false;
let selectedItems = new Set(); // ключи вида "table:id"
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;
let currentCategoryType = 'Расход';
let currentCategorySelect = null;
let selectedCategoryIcon = '📦';
const availableIcons = [
  '🍔', '🚗', '🏠', '🎬', '📦', '💼', '🎓', '👶', '🐾', '💊',
  '🛒', '✈️', '🏋️', '🎮', '📚', '🎵', '🎁', '☕', '🍕', '👕',
  '💡', '🔧', '📱', '💻', '🖥️', '📷', '🎨', '🎸', '⚽', '🏀',
  '🚌', '🚇', '🚕', '⛽', '🛁', '🧹', '🧺', '🪴', '🌍', '💳'
];

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
      <button id="delete-selected" class="btn-delete">Удалить</button>
      <button id="cancel-selection" class="btn-cancel">Отмена</button>
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
 function startLongPress(card) {
  longPressTriggered = false;
  clearTimeout(longPressTimer);
  
  const cancelEvents = ['touchmove', 'touchend', 'touchcancel', 'mousemove', 'mouseup'];
  const cancelHandler = () => {
    clearTimeout(longPressTimer);
    cancelEvents.forEach(ev => document.removeEventListener(ev, cancelHandler));
  };
  cancelEvents.forEach(ev => document.addEventListener(ev, cancelHandler, { passive: true }));

  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    if (!selectionMode) enableSelectionMode();
    toggleItemSelection(card.dataset.id, card.dataset.table);
    cancelEvents.forEach(ev => document.removeEventListener(ev, cancelHandler));
  }, 500);
}

document.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.target.closest('.card-action-btn') && !e.target.closest('input')) {
    startLongPress(card);
  }
}, { passive: true });

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const card = e.target.closest('.card');
  if (card && !e.target.closest('.card-action-btn') && !e.target.closest('input')) {
    startLongPress(card);
  }
});

document.addEventListener('click', (e) => {
  // Игнорируем первый клик после долгого нажатия
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
