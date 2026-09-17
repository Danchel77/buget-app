// ==========================================
// PWA Service Worker Registration
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('SW registration failed:', err);
    });
  });
}

// ==========================================
// Firebase Configuration & Initialization
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyD-EXAMPLE_KEY",
  authDomain: "your-app.firebaseapp.com",
  projectId: "your-app",
  storageBucket: "your-app.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

// Инициализируем приложение
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();
const auth = firebase.auth();

// Включаем поддержку офлайн-режима Firestore
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('Firestore persistence failed: Multiple tabs open');
  } else if (err.code === 'unimplemented') {
    console.warn('Firestore persistence is not supported by the browser');
  }
});

// ==========================================
// Global Application State (Cache)
// ==========================================
window.Cache = {
  Transactions: [],
  Categories: [],
  Rules: [],
  Deposits: [],
  Broker: [],
  BrokerHistory: [],
  BudgetPlans: [],
  CalendarBills: [],
  BudgetGoals: []
};

// Переменные текущего редактирования
let currentEditId = null;
let currentEditTable = null;

// ==========================================
// Database CRUD & Sync Operations
// ==========================================

// Хелпер доступа к личной подколлекции авторизованного пользователя
function getUserCol(table) {
  const user = auth.currentUser;
  if (!user) throw new Error('Пользователь не авторизован');
  return db.collection('users').doc(user.uid).collection(table);
}

async function fetchAllData() {
  const tables = ['Transactions', 'Deposits', 'Broker', 'Goals', 'Categories', 'CategoryRules', 'BudgetPlan', 'CalendarBills'];

  // ЭТАП 1: Мгновенное чтение из локального кэша IndexedDB (15-40 мс)
  try {
    const cachedSnaps = await Promise.all(
      tables.map(tbl => getUserCol(tbl).get({ source: 'cache' }))
    );
    if (cachedSnaps.some(s => !s.empty)) {
      await applySnapshotsToUI(cachedSnaps);
      document.getElementById('loading-screen')?.classList.add('hidden');
    }
  } catch (e) {}

  // ЭТАП 2: Фоновая синхронизация со свежими данными сервера
  try {
    showToast("Синхронизация...", false, true);
    const serverSnaps = await Promise.all(
      tables.map(tbl => getUserCol(tbl).get())
    );
    await applySnapshotsToUI(serverSnaps);
    document.getElementById('last-sync').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('toast-container')?.classList.add('hidden');
    document.getElementById('loading-screen')?.classList.add('hidden');
  } catch (err) {
    document.getElementById('toast-container')?.classList.add('hidden');
    document.getElementById('loading-screen')?.classList.add('hidden');
    if (!Cache) {
      showToast("Нет подключения к сети", true);
    }
  }
}

// --- БД И ЛОГИКА ---
async function fetchCollection(table) {
  try {
    const querySnapshot = await getUserCol(table).get();
    const data = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    switch (table) {
      case 'Transactions':
        Cache.transactions = processTransactions(data);
        renderTransactions();
        renderBudgetTab();
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
        await fetchAllData();
        break;
    }
  } catch (e) {
    showToast("Ошибка загрузки", true);
  }
}

async function applySnapshotsToUI([txS, depS, brS, goalS, catS, rulesS, planS, billsS]) {
  const txData = txS.docs.map(d => ({ id: d.id, ...d.data() }));
  const depData = depS.docs.map(d => ({ id: d.id, ...d.data() }));
  const brData = brS.docs.map(d => ({ id: d.id, ...d.data() }));
  const goalData = goalS ? goalS.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  const planData = planS && !planS.empty ? planS.docs[0].data() : {};
  const billsData = billsS ? billsS.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  
  const processedDeposits = processDeposits(depData, goalData);
  const processedBroker = processBroker(brData, goalData);
  const catData = catS.docs.map(d => ({ id: d.id, ...d.data() }));
  const categories = processCategories(catData);

  const existingSettings = (Cache && Cache.settings) ? Cache.settings : {};

  Cache = {
    settings: existingSettings,
    transactions: processTransactions(txData),
    deposits: processedDeposits,
    broker: processedBroker,
    goals: processGoals(goalData),
    categories: categories,
    categoryRules: await processOrSeedRules(rulesS),
    budgetPlan: planData,
    calendarBills: billsData
  };
  window.Cache = Cache;

  updateGoalDropdowns();
  renderBudgetTab();
  renderTransactions();
  renderDeposits();
  renderBroker();
}

/* Универсальная функция добавления/обновления */
async function submitAction(btnId, table, data) {

  const btn = document.getElementById(btnId);
  btn.disabled = true;
  showToast("Сохранение...", false, true);

  try {
    if (currentEditId && currentEditTable === table) {
      await getUserCol(table).doc(currentEditId).update(data);
    } else if (Array.isArray(data)) {
      const batch = db.batch();
      data.forEach(item => batch.set(getUserCol(table).doc(), item));
      await batch.commit();
    } else {
      await getUserCol(table).add(data);
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
      await getUserCol(table).doc(id).delete();

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

// Инициализация профиля ТОЛЬКО если это совершенно новый пользователь
async function initNewUserIfNeeded(user) {
  try {
    const userDocRef = db.collection('users').doc(user.uid);
    const userDoc = await userDocRef.get();

    // Пользователь уже зарегистрирован и настроен — сразу выходим
    if (userDoc.exists) return;

    // Новый аккаунт: создаем профиль и начальные категории со словарем
    await seedNewUserInitialData(user);
  } catch (e) {
    console.error('Ошибка инициализации профиля:', e);
  }
}

// Заполнение начальных категорий и правил для нового аккаунта
async function seedNewUserInitialData(user) {
  try {
    const batch = db.batch();

    // Документ пользователя
    batch.set(db.collection('users').doc(user.uid), {
      migrated: true,
      displayName: user.displayName || user.email?.split('@')[0] || 'Пользователь',
      email: user.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
  } catch (err) {
    console.error('Ошибка инициализации нового пользователя:', err);
  }
}

// ==========================================
// Formatting & Utility Functions
// ==========================================

const formatMoney = (sum, isInputOrDetails = false) => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: isInputOrDetails ? 2 : 0, // Убираем копейки везде по умолчанию
  maximumFractionDigits: isInputOrDetails ? 2 : 0
}).format(sum).replace(',', '.'); // Использует неразрывные пробелы встроенно
const getUnformattedVal = (el) => parseFloat(el.value.replace(/\s/g, '')) || 0;
const setFormattedVal = (id, val) => {
  const el = document.getElementById(id);
  el.value = val;
  formatSumInput(el);
};

function formatSumInput(el) {
  let val = el.value.replace(/[^\d.,]/g, '').replace(',', '.');
  if (val) {
    let parts = val.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    el.value = parts.join('.');
  }
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

/**
 * ИСПРАВЛЕННАЯ ФУНКЦИЯ:
 * Устранено смещение часовых поясов (UTC toISOString),
 * даты теперь формируются строго по локальному времени пользователя.
 */
function formatDateStr(dateStr, format) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  if (format === 'dd.MM.yyyy') {
    return `${day}.${month}.${year}`;
  }
  if (format === 'yyyy-MM') {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${day}`;
}

// ==========================================
// UI Notifications & Dialogs
// ==========================================

let toastTimer = null;

function showToast(text, isError = false, keep = false) {
  const container = document.getElementById('toast-container');
  const content = document.getElementById('toast-content');
  const textEl = document.getElementById('toast-text');
  const spinner = document.getElementById('toast-spinner');
  const successIcon = document.getElementById('toast-icon-success');
  const errorIcon = document.getElementById('toast-icon-error');

  if (!container || !textEl) return;

  clearTimeout(toastTimer);
  textEl.innerText = text;

  if (isError) {
    if (spinner) spinner.style.display = 'none';
    if (successIcon) successIcon.classList.add('hidden');
    if (errorIcon) errorIcon.classList.remove('hidden');
    if (content) content.style.borderColor = 'rgba(255, 69, 58, 0.4)';
  } else if (keep) {
    if (spinner) spinner.style.display = 'block';
    if (successIcon) successIcon.classList.add('hidden');
    if (errorIcon) errorIcon.classList.add('hidden');
    if (content) content.style.borderColor = 'rgba(108, 93, 211, 0.4)';
  } else {
    if (spinner) spinner.style.display = 'none';
    if (successIcon) successIcon.classList.remove('hidden');
    if (errorIcon) errorIcon.classList.add('hidden');
    if (content) content.style.borderColor = 'rgba(48, 209, 88, 0.4)';
  }

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  container.classList.remove('hidden');

  if (!keep) {
    toastTimer = setTimeout(() => {
      container.classList.add('hidden');
    }, 2400);
  }
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

// ==========================================
// Global Scope Export
// ==========================================
window.db = db;
window.auth = auth;
window.getUserCol = getUserCol;
window.fetchAllData = fetchAllData;
window.fetchCollection = fetchCollection;
window.applySnapshotsToUI = applySnapshotsToUI;
window.submitAction = submitAction;
window.deleteRecord = deleteRecord;
window.formatMoney = formatMoney;
window.formatSumInput = formatSumInput;
window.getUnformattedVal = getUnformattedVal;
window.setFormattedVal = setFormattedVal;
window.formatDateStr = formatDateStr;
window.escapeHtml = escapeHtml;
window.showToast = showToast;
window.showDialog = showDialog;
