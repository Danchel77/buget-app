// ==========================================
// Main Application Entry Point & Navigation
// ==========================================

// Показываем экран загрузки сразу при старте
document.getElementById('loading-screen')?.classList.remove('hidden');

// Слушатель состояния авторизации пользователя (Запуск приложения)
auth.onAuthStateChanged(async user => {
  document.getElementById('loading-screen')?.classList.add('hidden');
  
  if (user) {
    document.getElementById('login-screen')?.classList.add('hidden');
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
    document.getElementById('login-screen')?.classList.remove('hidden');
  }
});

// Переключение основных экранов (Табов)
function switchTab(tab) {
  if (typeof disableSelectionMode === 'function') disableSelectionMode();

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
  
  if (tab === 'budget' && typeof renderBudgetTab === 'function') {
    renderBudgetTab();
  }
  if (tab === 'broker' && Cache && typeof drawBrokerChart === 'function') {
    setTimeout(drawBrokerChart, 100);
  }
}

// Универсальные хелперы открытия/закрытия форм
function toggleForm(containerId, btnId, btnText, formId, type) {
  const formContainer = document.getElementById(containerId);
  if (!formContainer) return;
  formContainer.classList.toggle('hidden');

  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    const btn = document.getElementById(btnId);
    if (btn) btn.innerText = btnText;
  }

  if (!formContainer.classList.contains('hidden')) {
    const form = document.getElementById(formId);
    if (form) form.reset();
    const today = new Date().toISOString().split('T')[0];

    if (type === 'tx' && typeof addTxRow === 'function') {
      const list = document.getElementById('tx-items-list');
      if (list) list.innerHTML = '';
      addTxRow();
    } else if (type === 'dep') {
      const startInp = document.getElementById('dep-start');
      if (startInp) startInp.value = today;
      const firstGoal = Cache?.goals?.find(g => !g.isAchieved);
      const depGoal = document.getElementById('dep-goal');
      if (firstGoal && depGoal) depGoal.value = firstGoal.id;
    }
  }
}

function closeForm(containerId, btnId, btnText, formId) {
  const container = document.getElementById(containerId);
  if (container) container.classList.add('hidden');
  const form = document.getElementById(formId);
  if (form) form.reset();
  if (formId === 'tx-form') {
    const list = document.getElementById('tx-items-list');
    if (list) list.innerHTML = '';
  }
  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    const btn = document.getElementById(btnId);
    if (btn) btn.innerText = btnText;
  }
}

// Экспорт в глобальную область
window.switchTab = switchTab;
window.toggleForm = toggleForm;
window.closeForm = closeForm;
