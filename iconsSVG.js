/**
 * Векторные SVG-логотипы банков для окна импорта выписок
 */
const BANK_ICONS = {
  // Сбербанк: фирменный зеленый круг с тройным шевроном
  sber: `
    <svg viewBox="0 0 32 32" class="w-7 h-7 flex-shrink-0" fill="none">
      <circle cx="16" cy="16" r="16" fill="#21A038"/>
      <path d="M12 16.8l-3.2-3.2 1.6-1.6 1.6 1.6 7-7 1.6 1.6-8.6 8.6z" fill="#fff"/>
      <path d="M12 21.2l-5.6-5.6 1.6-1.6 4 4 9.4-9.4 1.6 1.6-11 11z" fill="#fff"/>
      <path d="M12 25.6l-8-8 1.6-1.6 6.4 6.4 11.8-11.8 1.6 1.6-13.4 13.4z" fill="#fff"/>
    </svg>
  `,

  // Яндекс Банк: алая буква «Я» на прозрачном фоне (без лишних кругов)
  yandex: `
    <svg viewBox="0 0 32 32" class="w-6 h-6 flex-shrink-0" fill="none">
      <path d="M19.2 5.5H23v21h-4.2v-8.8h-2.9l-4.5 8.8H6.5l5.2-9.7C9.6 16 8 14.1 8 11.4c0-3.8 2.8-5.9 7.8-5.9h3.4zm0 3.3h-2.9c-2.8 0-4.4 1.2-4.4 3.3 0 1.9 1.4 3.2 4.4 3.2h2.9V8.8z" fill="#FC3F1D"/>
    </svg>
  `,

  // Газпромбанк: фирменный синий шар из волнистых линий
  gpb: `
    <svg viewBox="0 0 32 32" class="w-7 h-7 flex-shrink-0" fill="none">
      <circle cx="16" cy="16" r="15" fill="#0A1838" stroke="#1D4ED8" stroke-width="0.8"/>
      <g stroke="#38BDF8" stroke-width="1.3" stroke-linecap="round">
        <path d="M7 11.5c4-3.5 14-3.5 18 0"/>
        <path d="M5.5 16c4.5-4 16.5-4 21 0"/>
        <path d="M7 20.5c4 3.5 14 3.5 18 0"/>
        <path d="M10 24.5c3 2 9 2 12 0"/>
      </g>
    </svg>
  `,

  // Озон Банк: фирменный синий блок с белым текстом ozon банк
  ozon: `
    <svg viewBox="0 0 32 32" class="w-7 h-7 flex-shrink-0" fill="none">
      <rect width="32" height="32" rx="8" fill="#005BFF"/>
      <text x="16" y="14.5" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="8" fill="#fff" letter-spacing="-0.3">ozon</text>
      <text x="16" y="23.5" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="6.8" fill="#fff" letter-spacing="-0.2">банк</text>
    </svg>
  `
};

window.BANK_ICONS = BANK_ICONS;

function renderBankIcons() {
  document.querySelectorAll('[data-bank-icon]').forEach(el => {
    const key = el.dataset.bankIcon;
    if (window.BANK_ICONS && window.BANK_ICONS[key]) {
      el.innerHTML = window.BANK_ICONS[key];
    }
  });
}
window.renderBankIcons = renderBankIcons;
