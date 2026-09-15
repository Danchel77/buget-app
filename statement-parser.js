/**
 * statement-parser.js
 * Парсер банковских PDF-выписок (Шаг 1: извлечение текста, Шаг 2: формирование таблицы)
 */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// -------------------------------------------------------------
// 1. ИЗВЛЕЧЕНИЕ СЫРОГО ТЕКСТА
// -------------------------------------------------------------
class StatementExtractor {
  static async extractLinesFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allLines = [];

    const Y_TOLERANCE = 3.5;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const sortedItems = textContent.items.filter(it => it.str && it.str.trim().length > 0);
      sortedItems.sort((a, b) => {
        if (Math.abs(a.transform[5] - b.transform[5]) > Y_TOLERANCE) {
          return b.transform[5] - a.transform[5];
        }
        return a.transform[4] - b.transform[4];
      });

      let currentLine = [];
      let currentY = null;

      for (const item of sortedItems) {
        const text = item.str.trim();
        const y = item.transform[5];

        if (currentY === null || Math.abs(y - currentY) <= Y_TOLERANCE) {
          currentLine.push(text);
          if (currentY === null) currentY = y;
        } else {
          if (currentLine.length > 0) {
            allLines.push(currentLine.join(' '));
          }
          currentLine = [text];
          currentY = y;
        }
      }
      if (currentLine.length > 0) {
        allLines.push(currentLine.join(' '));
      }
    }

    return allLines;
  }
}

// -------------------------------------------------------------
// ДИНАМИЧЕСКИЕ КАТЕГОРИИ И ИКОНКИ ИЗ FIREBASE
// -------------------------------------------------------------

/**
 * Возвращает массив названий категорий нужного типа из Firebase
 */
function getActiveCategories(type = 'Расход') {
  const cats = window.Cache?.categories;
  if (!cats) {
    return type === 'Доход' ? ['Зарплата', 'Другое'] : ['Продукты', 'Другое'];
  }
  const list = type === 'Доход' ? (cats.income || []) : (cats.expense || []);
  return list.map(c => c.name);
}

/**
 * Находит актуальную иконку для любой категории из базы (включая созданные пользователем)
 */
function getDynamicCategoryIcon(catName) {
  const cats = window.Cache?.categories;
  if (cats) {
    const all = [...(cats.expense || []), ...(cats.income || [])];
    const found = all.find(c => c.name === catName);
    if (found && found.icon && found.icon !== '📦') return found.icon;
  }
  return 'tag'; // Глобальный вектор-дефолт, вместо эмодзи коробки
}

// -------------------------------------------------------------
// 3. УНИВЕРСАЛЬНЫЙ ОПРЕДЕЛИТЕЛЬ (И ДОХОДЫ, И РАСХОДЫ ИЗ FIREBASE)
// -------------------------------------------------------------
class StatementCategorizer {
  static normalize(str) {
    if (!str) return '';

    // 1. Приведение к нижнему регистру и нормализация буквы ё
    let s = String(str).toLowerCase().replace(/ё/g, 'е');

    // 2. Транслитерация кириллицы в латиницу по стандарту банковских терминалов
    const ruToEn = {
      'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e',
      'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l',
      'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's',
      'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch',
      'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e',
      'ю': 'yu', 'я': 'ya'
    };

    s = s.replace(/[а-я]/g, char => ruToEn[char] !== undefined ? ruToEn[char] : char);

    // 3. Фонетическая гармонизация латиницы и англо-русских брендов
    s = s
      .replace(/ck/g, 'k')
      .replace(/c([eiy])/g, 's$1')     // cinema -> sinema, city -> siti
      .replace(/c/g, 'k')              // rostics -> rostiks, cafe -> kafe, cofix -> kofiks
      .replace(/q/g, 'k')
      .replace(/x/g, 'ks')             // taxi -> taksi, yandex -> yandeks
      .replace(/w/g, 'v')             // wildberries -> vildberries
      .replace(/ph/g, 'f')            // pharmacy -> farmacy
      .replace(/ia/g, 'ya')           // piaterochka -> pyaterochka
      .replace(/iu/g, 'yu')
      .replace(/shch/g, 'sh')
      .replace(/sch/g, 'sh')
      .replace(/tc/g, 'ts')
      .replace(/tz/g, 'ts')
      .replace(/ee/g, 'i')            // befree -> befri
      .replace(/oo/g, 'u')
      .replace(/y(?![aeiou])/g, 'i'); // dixy -> diksi, city -> siti

    // 4. Схлопывание двойных согласных (coffee -> kofi, fitness -> fitnes, vkusvill -> vkusvil)
    s = s.replace(/([b-df-hj-np-tv-z])\1+/g, '$1');

    // 5. Очистка спецсимволов и дублирующихся пробелов
    s = s.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    return s;
  }

  static categorize(merchant, rawDetails, type) {
    const rawText = `${merchant} ${rawDetails}`;
    const normText = this.normalize(rawText);
    const normTextNoSpaces = normText.replace(/\s+/g, '');

    const rules = window.Cache?.categoryRules?.length
      ? window.Cache.categoryRules
      : (window.DEFAULT_CATEGORY_RULES || []);

    const allowedCategories = getActiveCategories(type);

    for (const rule of rules) {
      if (!rule.pattern || !rule.category) continue;
      if (!allowedCategories.includes(rule.category)) continue;

      if (this._matches(normText, normTextNoSpaces, rule.pattern)) {
        return rule.category;
      }
    }

    return allowedCategories.includes('Другое') ? 'Другое' : (allowedCategories[0] || 'Другое');
  }

  static _matches(normText, normTextNoSpaces, rawPattern) {
    const normPat = this.normalize(rawPattern);
    if (!normPat) return false;

    // Для коротких паттернов (<= 4 символов) строго проверяем границы слов
    if (normPat.length <= 4) {
      const escaped = normPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
      return regex.test(normText);
    }

    // 1. Прямой поиск в нормализованном тексте
    if (normText.includes(normPat)) return true;

    // 2. Поиск без пробелов (например: "vkus vill" находит "vkusvill", "burger king" находит "burgerking")
    const normPatNoSpaces = normPat.replace(/\s+/g, '');
    if (normPatNoSpaces.length >= 5 && normTextNoSpaces.includes(normPatNoSpaces)) {
      return true;
    }

    return false;
  }
}
window.StatementCategorizer = StatementCategorizer;

// =============================================================
// 1. УНИВЕРСАЛЬНЫЙ ДВИЖОК ПАРСИНГА ВЫПИСОК
// =============================================================

// Единый список признаков переводов и движения наличных для всех банков
const UNIVERSAL_TRANSFER_KEYWORDS = [
  'перевод', 'сбп', 'между счетами', 'снятие наличных', 'внесение наличных',
  'взнос наличными', 'зачисление наличных', 'пополнение наличными', 'наличными',
  'vklad-karta', 'karta-vklad', 'bpwww', 'брокер', 'vb24'
];

// Общие служебные строки (шапки, подвалы документов)
const COMMON_SERVICE_LINES = [
  'страница', 'выписка по', 'справка о движении', 'входящий остаток',
  'исходящий остаток', 'итого зачислений', 'итого списаний', 'с уважением',
  'руководитель департамента', 'лицензия банка россии', 'номер лицевого счёта'
];

// Утилита очистки суммы из строки в число
function cleanAmount(str) {
  if (!str) return 0;
  const clean = str.replace(/[+−–—\-\u2012\u2013\u2014\u2212]/g, '')
                   .replace(/[^\d.,]/g, '')
                   .replace(',', '.');
  return Math.abs(parseFloat(clean)) || 0;
}

/**
 * ЕДИНЫЙ ДВИЖОК: собирает строки в блоки, проверяет переводы и нормализует данные
 */
class UniversalStatementParser {
  static parse(rawLines, config) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line, config)) continue;

      if (config.isTxStart(line)) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    return rawBlocks.map(block => this._processBlock(block, config)).filter(Boolean);
  }

  static _processBlock(lines, config) {
    // Извлекаем поля через правила конкретного банка
    const data = config.extract(lines);
    if (!data || !data.date || !data.amount) return null;

    const fullText = lines.join(' ');
    const merchant = data.merchant || 'Банковская операция';

    // Универсальная проверка на перевод / наличные
    const isTransfer = this._checkIfTransfer(fullText, merchant, config);

    // Нормализация даты в YYYY-MM-DD
    let isoDate = data.date;
    if (data.date.includes('.')) {
      const [d, m, y] = data.date.split('.');
      isoDate = `${y.length === 2 ? '20' + y : y}-${m}-${d}`;
    }

    // Динамическая категоризация через базу Firebase
    const category = StatementCategorizer.categorize(merchant, `${data.hint || ''} ${fullText}`, data.type);

    return {
      date: isoDate,
      displayDate: data.date,
      type: data.type,
      amount: data.amount,
      merchant: merchant,
      category: category,
      isTransfer: isTransfer,
      bank: config.name,
      rawDetails: fullText
    };
  }

  static _checkIfTransfer(fullText, merchant, config) {
    const text = `${fullText} ${merchant}`.toLowerCase();
    const hasUniversal = UNIVERSAL_TRANSFER_KEYWORDS.some(kw => text.includes(kw));
    const hasCustom = config.customTransferCheck ? config.customTransferCheck(text) : false;
    return hasUniversal || hasCustom;
  }

  static _isServiceLine(line, config) {
    const l = line.toLowerCase();
    const isCommon = COMMON_SERVICE_LINES.some(kw => l.includes(kw));
    const isCustom = config.isServiceLine ? config.isServiceLine(l) : false;
    return isCommon || isCustom;
  }
}

// =============================================================
// 2. РЕЕСТР БАНКОВ (КАЖДЫЙ БАНК — ПРОСТОЙ ОБЪЕКТ НАСТРОЕК)
// =============================================================

const BANK_REGISTRY = [
  // --- ЯНДЕКС БАНК ---
  {
    id: 'YANDEX',
    name: 'Яндекс Банк',
    slug: 'yandexbank',
    iconKey: 'yandex',
    badgeColor: 'bg-amber-900/60 text-amber-300 border-amber-700/60',
    guide: {
      doc: 'Выписка по договору Сейва или карты (PDF)',
      steps: [
        'Откройте приложение «Яндекс Пэй»',
        'Нажмите на Сейв или карту Яндекс Банка',
        'Перейдите в раздел «Справки» внизу страницы',
        'Выберите «Выписка по договору» и задайте период дат',
        'Скачайте сформированный PDF-документ'
      ]
    },
    getScore: (p) => {
      let score = 0;
      if (/лицензи[яи][^\d]*3027\b/i.test(p) || p.includes('3027')) score += 10;
      if (p.includes('яндекс банк') || p.includes('кб яндекс') || p.includes('yandex bank') || p.includes('ао яндекс')) score += 8;
      if (p.includes('yabank.yandex.ru') || p.includes('yandex.ru/bank') || p.includes('yandex pay') || p.includes('яндекс пэй')) score += 5;
      if (p.includes('договору сейва') || p.includes('сейв') || p.includes('справка об остатке')) score += 4;
      return score;
    },
    detect: function(p) { return this.getScore(p) >= 5; },
    isTxStart: (l) => /\d{2}\.\d{2}\.\d{4}/.test(l) && /[\d\s\xa0]+[.,]\d{2}\s*₽/.test(l),
    isServiceLine: (l) => (l.includes('операции') && l.includes('мск')) || (l.includes('обработки') && l.includes('договора')),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/\d{2}\.\d{2}\.\d{4}/);
      const amounts = first.match(/([+−–—\-\u2012\u2013\u2014\u2212]?\s*[\d\s\xa0]+[.,]\d{2})\s*₽/g) || [];
      const raw = amounts[0] || '0';
      const type = raw.includes('+') ? 'Доход' : 'Расход';

      let part1 = first.split(/\d{2}\.\d{2}\.\d{4}/)[0].replace(/^Оплата товаров и услуг\s*/i, '').trim();
      let part2 = lines.slice(1).map(l => l.replace(/в\s+\d{2}:\d{2}/i, '').replace(/\d{2}\.\d{2}\.\d{4}/g, '').replace(/\*\d{4}/g, '').replace(/[\d\s\xa0]+[.,]\d{2}\s*₽/g, '').trim()).filter(Boolean).join(' ');
      let merchant = `${part1} ${part2}`.replace(/^Оплата товаров и услуг\s*/i, '').replace(/\b(операции|обработки|договора|мск|карты|валюте)\b/gi, '').replace(/\s+/g, ' ').trim() || 'Операция Яндекс Банк';

      return { date: dMatch[0], amount: cleanAmount(raw), type, merchant };
    }
  },

  // --- ГАЗПРОМБАНК ---
  {
    id: 'GPB',
    name: 'Газпромбанк',
    slug: 'gazprombank',
    iconKey: 'gpb',
    badgeColor: 'bg-blue-900/60 text-blue-300 border-blue-700/60',
    guide: {
      doc: 'Выписка по карте / счёту (PDF)',
      steps: [
        'Откройте мобильное приложение Газпромбанка',
        'Выберите счёт карты на главном экране',
        'Перейдите в раздел «Справки и выписки»',
        'Выберите «Выписка по карте», укажите интервал дат',
        'Скачайте сформированный PDF-документ'
      ]
    },
    getScore: (p) => {
      let score = 0;
      if (/лицензи[яи][^\d]*354\b/i.test(p)) score += 10;
      if (p.includes('банк гпб') || p.includes('газпромбанк') || p.includes('гпб (ао)') || p.includes('гпб (акционерное')) score += 8;
      if (p.includes('gazprombank.ru')) score += 5;
      if (p.includes('дата отражения') || p.includes('номер банковского счета')) score += 4;
      return score;
    },
    detect: function(p) { return this.getScore(p) >= 5; },
    isTxStart: (l) => /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/^(\d{2}\.\d{2}\.\d{4})/);
      const amounts = first.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
      let inc = 0, exp = 0;
      if (amounts.length >= 2) {
        inc = cleanAmount(amounts[amounts.length - 2]);
        exp = cleanAmount(amounts[amounts.length - 1]);
      } else if (amounts.length === 1) {
        exp = cleanAmount(amounts[0]);
      }
      const type = (exp === 0 && inc > 0) ? 'Доход' : 'Расход';
      const amount = type === 'Доход' ? inc : exp;

      const full = lines.join(' ');
      const dev = full.match(/Устройство:\s*([^.]+?)(?:\.\s*Город|\.\s*Сумма|\.|$)/i);
      const sbp = full.match(/Перевод\s+(?:по\s+СБП|клиенту|от)\s+([^.]+?)(?:\.|$)/i);
      let merchant = dev ? dev[1].trim() : (sbp ? sbp[0].trim() : first.replace(/^(\d{2}\.\d{2}\.\d{4}\s*){1,2}/, '').replace(/([+-]?\s*[\d\s]+[.,]\d{2})/g, '').replace(/Операция:\s*/i, '').trim());

      return { date: dMatch[1], amount, type, merchant };
    }
  },

  // --- СБЕРБАНК ---
  {
    id: 'SBER',
    name: 'Сбербанк',
    slug: 'sberbank',
    iconKey: 'sber',
    badgeColor: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60',
    guide: {
      doc: 'Выписка по счёту карты (PDF)',
      steps: [
        'Откройте приложение «СберБанк Онлайн»',
        'Выберите нужную карту или платёжный счёт',
        'Нажмите «О карте» → «Выписки и справки»',
        'Выберите «Выписка по счету карты», укажите интервал дат',
        'Скачайте сформированный PDF-документ'
      ]
    },
    getScore: (p) => {
      let score = 0;
      if (/лицензи[яи][^\d]*1481\b/i.test(p) || p.includes('1481')) score += 10;
      if (p.includes('пао сбербанк') || p.includes('сбербанк россии') || p.includes('сбербанк онлайн') || p.includes('sberbank online')) score += 8;
      else if (p.includes('сбербанк')) score += 5;
      if (p.includes('sberbank.ru') || p.includes('sber.ru')) score += 5;
      if (p.includes('отчет по счету') || p.includes('выписка по счету дебетовой карты') || p.includes('выписка по счету карты')) score += 4;
      return score;
    },
    detect: function(p) { return this.getScore(p) >= 5; },
    isTxStart: (l) => /^(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}/.test(l) && !/^\d{2}\.\d{2}\.\d{4}\s+\d{6}/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/^(\d{2}\.\d{2}\.\d{4})/);
      const after = first.replace(/^(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}\s+/, '');
      const amounts = after.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
      const rawAmount = amounts[0] || '0';
      const type = rawAmount.includes('+') ? 'Доход' : 'Расход';

      let sberCat = after;
      amounts.forEach(a => sberCat = sberCat.replace(a, ''));
      sberCat = sberCat.trim();

      let merchant = sberCat;
      if (lines.length > 1) {
        let desc = lines[1].replace(/^\d{2}\.\d{2}\.\d{4}\s+\d+\s*/, '')
                           .replace(/\.?\s*(Операция|Перевод)\s+по.*$/i, '')
                           .trim();
        if (desc) merchant = desc;
      }
      return { date: dMatch[1], amount: cleanAmount(rawAmount), type, merchant, hint: sberCat };
    }
  },

  // --- ОЗОН БАНК ---
  {
    id: 'OZON',
    name: 'Озон Банк',
    slug: 'ozonbank',
    iconKey: 'ozon',
    badgeColor: 'bg-sky-900/60 text-sky-300 border-sky-700/60',
    guide: {
      doc: 'Справка о движении средств (PDF)',
      steps: [
        'Откройте приложение Ozon Банк',
        'Выберите нужную карту или платёжный счёт',
        'Нажмите «Получить справку» → «О движении средств»',
        'Укажите интервал дат и тип операций',
        'Скачайте сформированный PDF-документ'
      ]
    },
    getScore: (p) => {
      let score = 0;
      if (/лицензи[яи][^\d]*3542\b/i.test(p) || p.includes('3542')) score += 10;
      if (p.includes('озон банк') || p.includes('ozon банк') || p.includes('ozon bank') || p.includes('еком банк') || p.includes('ecom bank')) score += 8;
      if (p.includes('finance.ozon.ru') || p.includes('ozon.ru')) score += 5;
      if (p.includes('справка о движении денежных средств') || p.includes('справка о движении средств') || p.includes('движении средств')) score += 4;
      return score;
    },
    detect: function(p) { return this.getScore(p) >= 5; },
    isTxStart: (l) => /^\d{2}\.\d{2}\.\d{4}/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/(\d{2}\.\d{2}\.\d{4})/);
      const full = lines.join(' ');
      const amounts = full.match(/([+−–—\-\u2012\u2013\u2014\u2212]\s*[\d\s\xa0]+[.,]\d{2})/g) || [];
      const raw = amounts[0] || '0';
      const type = raw.includes('+') ? 'Доход' : 'Расход';

      let merchant = 'Операция Озон Банк';
      const pos = full.match(/(?:сумма\s*[\d.]+\s*в|\bв)\s+([\s\S]+?)\s+дата\s*\d{4}/i);
      if (pos && pos[1].trim()) {
        merchant = pos[1].replace(/\s+(RU|RUS)$/i, '').replace(/\s+/g, ' ').trim();
      } else if (/выплата\s+к[еэ]шб[еэ]ка/i.test(full)) {
        merchant = 'Кэшбек Ozon';
      } else if (/возврат/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Возврат Ozon (${o[0]})` : 'Возврат покупки';
      } else if (/ozon\s*travel/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Ozon Travel (${o[0]})` : 'Ozon Travel';
      } else if (/платформе\s+ozon|оплата.*ozon/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Ozon (${o[0]})` : 'Ozon';
      } else if (/перевод.*сбп/i.test(full)) {
        const s = full.match(/(?:Отправитель|Получатель):\s*([^.]*?)(?:Без НДС|$)/i);
        merchant = s ? `Перевод СБП (${s[1].trim()})` : 'Перевод через СБП';
      }

      return { date: dMatch[1], amount: cleanAmount(raw), type, merchant };
    }
  }
];
window.BANK_REGISTRY = BANK_REGISTRY;

function openBankGuide(bankIdentifier) {
  const bank = BANK_REGISTRY.find(b => b.id === bankIdentifier || b.iconKey === bankIdentifier || b.slug === bankIdentifier);
  if (!bank || !bank.guide) return;

  const dialog = document.getElementById('bank-guide-dialog');
  const titleEl = document.getElementById('bank-guide-title');
  const docEl = document.getElementById('bank-guide-doc');
  const stepsEl = document.getElementById('bank-guide-steps');
  const iconContainer = document.getElementById('bank-guide-icon');

  if (!dialog || !titleEl || !docEl || !stepsEl) return;

  titleEl.textContent = bank.name;
  docEl.textContent = bank.guide.doc;

  if (iconContainer) {
    iconContainer.setAttribute('data-bank-icon', bank.iconKey || bank.slug);
  }

  stepsEl.innerHTML = bank.guide.steps.map((step, idx) => `
    <div class="flex items-start gap-2.5 p-2.5 rounded-xl bg-[#12151C] border border-[rgba(255,255,255,0.03)]">
      <span class="w-5 h-5 rounded-full bg-[#6C5DD3]/20 text-[#6C5DD3] text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">${idx + 1}</span>
      <span class="text-xs text-gray-300 leading-snug">${escapeHtml(step)}</span>
    </div>
  `).join('');

  dialog.classList.remove('hidden');

  if (typeof renderBankIcons === 'function') {
    renderBankIcons();
  }
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function closeBankGuide() {
  const dialog = document.getElementById('bank-guide-dialog');
  if (dialog) dialog.classList.add('hidden');
}

window.openBankGuide = openBankGuide;
window.closeBankGuide = closeBankGuide;

// =============================================================
// 3. ДИСПЕТЧЕР (НАХОДИТ БАНК И ЗАПУСКАЕТ ПАРСИНГ)
// =============================================================
class StatementDispatcher {
  /**
   * Интеллектуально выделяет шапку документа строго до начала таблицы операций,
   * чтобы захватить лицензии и реквизиты, исключив строки переводов СБП.
   */
  static extractPreamble(rawLines) {
    let cutoffIndex = Math.min(rawLines.length, 50);

    for (let i = 0; i < cutoffIndex; i++) {
      const line = rawLines[i].toLowerCase();
      // Остановка перед заголовком таблицы или первой транзакцией
      if (
        line.includes('дата операции') ||
        line.includes('дата списания') ||
        line.includes('дата отражения') ||
        (/\d{2}\.\d{2}\.\d{4}/.test(line) && /[\d\s\xa0]+[.,]\d{2}/.test(line))
      ) {
        cutoffIndex = Math.max(i, 8);
        break;
      }
    }

    return rawLines.slice(0, cutoffIndex).join(' ').toLowerCase();
  }

  static parse(rawLines) {
    const preamble = this.extractPreamble(rawLines);

    let bestBank = null;
    let maxScore = 0;

    for (const bank of BANK_REGISTRY) {
      const score = bank.getScore ? bank.getScore(preamble) : (bank.detect(preamble) ? 10 : 0);
      if (score > maxScore) {
        maxScore = score;
        bestBank = bank;
      }
    }

    if (!bestBank || maxScore < 5) {
      const supported = BANK_REGISTRY.map(b => b.name).join(', ');
      throw new Error(`Не удалось определить банк выписки. Поддерживаются: ${supported}.`);
    }

    const transactions = UniversalStatementParser.parse(rawLines, bestBank);
    return { bank: bestBank, transactions };
  }
}

// -------------------------------------------------------------
// 3. UI-ОБРАБОТЧИК И ВЫВОД РЕЗУЛЬТАТА ШАГА 2
// -------------------------------------------------------------
async function handleStatementUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Пожалуйста, выберите файл в формате PDF', true);
    return;
  }

  showToast('Обработка выписки...', false, true);

  try {
    const lines = await StatementExtractor.extractLinesFromPDF(file);

    if (!lines || lines.length === 0) {
      throw new Error('Файл пуст или не содержит читаемого текста');
    }

    const result = StatementDispatcher.parse(lines);
    renderParsedTransactionsView(file.name, result.transactions, result.bank);

    document.getElementById('toast-container')?.classList.add('hidden');
  } catch (err) {
    console.error('Ошибка обработки PDF:', err);
    showToast('Ошибка: ' + err.message, true);
  } finally {
    event.target.value = '';
  }
}
window.handleStatementUpload = handleStatementUpload;

// -------------------------------------------------------------
// 4. ПРОВЕРКА ДУБЛИКАТОВ И ИМПОРТ В FIREBASE
// -------------------------------------------------------------

/**
 * Проверяет, есть ли уже такая операция в Cache.transactions
 */
function isTransactionDuplicate(tx) {
  if (!window.Cache || !window.Cache.transactions) return false;

  for (const month of window.Cache.transactions) {
    for (const item of month.items) {
      if (
        item.rawDate === tx.date &&
        Math.abs(item.amount - tx.amount) < 0.01 &&
        item.type === tx.type
      ) {
        return true;
      }
    }
  }
  return false;
}

// -------------------------------------------------------------
// ОБНОВЛЕННЫЙ УПЛОТНЕННЫЙ РЕНДЕР КАРТОЧЕК ВЫПИСКИ (~52px)
// -------------------------------------------------------------
let currentImportFilter = 'new'; // 'new' | 'transfers' | 'dupes' | 'all'

function setImportFilter(filter) {
  currentImportFilter = filter;
  ['new', 'transfers', 'dupes', 'all'].forEach(f => {
    const btn = document.getElementById(`tab-import-${f}`);
    if (btn) {
      btn.className = f === filter
        ? 'flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-xl font-semibold bg-[#212430] text-white transition-all cursor-pointer'
        : 'flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-xl font-medium text-[#848D99] hover:text-white transition-all cursor-pointer';
    }
  });

  const txs = window._lastParsedTransactions || [];
  renderFilteredRows(txs);
}
window.setImportFilter = setImportFilter;

// Массовый выбор: отметить все новые транзакции
function toggleSelectAllNew() {
  const txs = window._lastParsedTransactions || [];
  const anyUnselected = txs.some(t => !t.isDuplicate && !t.isTransfer && !t.selected);
  txs.forEach(t => {
    if (!t.isDuplicate && !t.isTransfer) {
      t.selected = anyUnselected;
    }
  });
  renderFilteredRows(txs);
  if (window._updateHeaderSummary) window._updateHeaderSummary();
}
window.toggleSelectAllNew = toggleSelectAllNew;

function renderFilteredRows(transactions) {
  const output = document.getElementById('pdf-debug-output');
  if (!output) return;

  const expenseCategories = getActiveCategories('Расход');
  const incomeCategories = getActiveCategories('Доход');

  // Фильтрация по статусам
  let visibleTxs = transactions;
  if (currentImportFilter === 'new') {
    visibleTxs = transactions.filter(t => !t.isDuplicate && !t.isTransfer);
  } else if (currentImportFilter === 'transfers') {
    visibleTxs = transactions.filter(t => t.isTransfer);
  } else if (currentImportFilter === 'dupes') {
    visibleTxs = transactions.filter(t => t.isDuplicate && !t.isTransfer);
  }

  if (visibleTxs.length === 0) {
    output.innerHTML = '<div class="text-center text-[#848D99] py-12 text-xs">Нет операций в этой вкладке</div>';
    return;
  }

  let html = '';
  visibleTxs.forEach(tx => {
    const isInactive = tx.isDuplicate || tx.isTransfer;
    const isExp = tx.type === 'Расход';
    const amountSign = isExp ? '-' : '+';
    const amountColor = isInactive ? 'text-gray-500 font-medium' : (isExp ? 'text-white font-bold' : 'text-[#30D158] font-bold');
    const cats = isExp ? expenseCategories : incomeCategories;
    const currentIcon = getDynamicCategoryIcon(tx.category);

    html += `
      <!-- Просторная 2-уровневая строка (мерчант на всю строку, дата и чипс снизу) -->
      <div class="card-parsed-row bg-[#181B24] border border-[rgba(255,255,255,0.06)] px-3.5 py-2.5 rounded-2xl flex flex-col gap-1.5 transition-all relative ${isInactive ? 'bg-[#12151C]' : 'hover:border-[rgba(255,255,255,0.12)]'}" 
           id="card-tx-${tx._id}" 
           data-is-inactive="${isInactive}"
           style="${isInactive ? 'opacity: 0.55;' : ''}">
        
        <!-- СТРОКА 1: Чекбокс, Название мерчанта и Сумма -->
        <div class="flex items-center justify-between gap-2.5 min-w-0">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <input type="checkbox" 
                   class="w-4 h-4 rounded accent-[#6C5DD3] bg-[#212430] border-gray-700 flex-shrink-0 cursor-pointer"
                   data-tx-id="${tx._id}"
                   ${tx.selected ? 'checked' : ''}
                   onchange="toggleTxSelection('${tx._id}', this.checked)">

            <span class="text-[13px] ${isInactive ? 'text-gray-400 font-normal' : 'text-gray-100 font-semibold'} truncate leading-tight" title="${escapeHtml(tx.merchant)}">
              ${escapeHtml(tx.merchant)}
            </span>
          </div>

          <span class="text-[14px] ${amountColor} font-mono font-semibold flex-shrink-0 ml-2">
            ${amountSign}${formatMoney(tx.amount)}
          </span>
        </div>

        <!-- СТРОКА 2: Дата/Статус слева, Категория-чипс и Пин справа -->
        <div class="flex items-center justify-between gap-2 pt-1 border-t border-[rgba(255,255,255,0.03)]">
          <div class="flex items-center gap-2 text-[11px] text-[#848D99]">
            <span class="font-mono">${tx.displayDate}</span>
            ${tx.isTransfer ? '<span class="text-[9px] font-bold text-amber-400 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-900/40">Перевод</span>' : ''}
            ${tx.isDuplicate ? '<span class="text-[9px] font-bold text-gray-400 bg-gray-800/80 px-1.5 py-0.5 rounded border border-gray-700/60">В базе</span>' : ''}
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            <!-- Чипс категории с фиксированной шириной 130px -->
            <div class="relative custom-dropdown-wrap" id="cat-wrap-${tx._id}">
              <button type="button" 
                      onclick="toggleImportCatMenu('${tx._id}')" 
                      id="cat-btn-${tx._id}"
                      class="w-[130px] bg-[#212430] border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.15)] text-[#F2F4F7] text-[11px] font-medium rounded-full px-2.5 py-1 flex items-center justify-between outline-none transition-colors cursor-pointer flex-shrink-0">
                <span id="cat-label-${tx._id}" class="truncate flex items-center gap-1.5 min-w-0 pr-1">
                  <i data-lucide="${currentIcon}" class="w-3.5 h-3.5 text-[#848D99] flex-shrink-0"></i> 
                  <span class="truncate">${escapeHtml(tx.category)}</span>
                </span>
                <i data-lucide="chevron-down" class="w-3 h-3 text-gray-500 flex-shrink-0"></i>
              </button> 
              
              <div id="cat-menu-${tx._id}" 
                   class="custom-dropdown-menu hidden absolute right-0 bottom-full mb-1.5 w-52 max-h-60 overflow-y-auto bg-[#181B24] border border-[rgba(255,255,255,0.08)] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.85)] z-50 p-1.5 space-y-0.5">
                ${cats.map(cat => {
                  const isCustom = !DEFAULT_SYSTEM_CATEGORIES.includes(cat);
                  const loopIcon = getDynamicCategoryIcon(cat);
                  return `
                    <div class="flex items-center justify-between hover:bg-[#2A2D3C] rounded-xl px-2.5 py-1.5 transition-colors group">
                      <button type="button" 
                              onclick="selectImportCat('${tx._id}', '${escapeHtml(cat)}', '${loopIcon}')" 
                              class="flex-1 text-left text-[12px] font-medium text-gray-200 flex items-center gap-2 cursor-pointer truncate min-w-0">
                        <i data-lucide="${loopIcon}" class="w-3.5 h-3.5 text-[#848D99]"></i>
                        <span class="truncate">${escapeHtml(cat)}</span>
                      </button>
                      ${isCustom ? `
                        <button type="button" onclick="event.stopPropagation(); deleteCategoryFromImport('${escapeHtml(cat)}', '${tx.type}')" class="text-gray-500 hover:text-[#FF453A] p-1 flex-shrink-0 cursor-pointer"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                      ` : ''}
                    </div>
                  `;
                }).join('')}

                <div class="border-t border-[rgba(255,255,255,0.06)] pt-1 mt-1">
                  <button type="button" onclick="event.stopPropagation(); addCategoryFromImport('${tx.type}')" class="w-full text-left px-2 py-1.5 text-[12px] text-blue-400 hover:bg-[#2A2D3C] rounded-lg flex items-center gap-1.5 font-medium cursor-pointer transition-colors">
                    <i data-lucide="plus" class="w-3.5 h-3.5"></i>
                    <span>Добавить</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- Аккуратный пин правила -->
            <button type="button" 
                    onclick="openRememberRuleModal('${tx._id}')" 
                    class="text-gray-500 hover:text-[#6C5DD3] hover:bg-[#212430] p-1.5 rounded-lg transition-colors cursor-pointer flex items-center justify-center" 
                    title="Закрепить правило категории">
              <i data-lucide="pin" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

      </div>
    `;
  });

  output.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderParsedTransactionsView(fileName, transactions, bankConfig) {
  window._lastActiveBank = bankConfig;

  // Сортировка по убыванию даты
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  
  const dialog = document.getElementById('pdf-debug-dialog');
  const info = document.getElementById('pdf-debug-info');

  transactions.forEach((tx, idx) => {
    tx._id = 'tx_parsed_' + idx;
    if (!tx.category || tx.category === 'Не определено') {
      tx.category = StatementCategorizer.categorize(tx.merchant, tx.rawDetails, tx.type);
    }
    tx.isDuplicate = isTransactionDuplicate(tx);
    tx.selected = !tx.isDuplicate && !tx.isTransfer;
  });

  window._lastParsedTransactions = transactions;

  function updateHeaderSummary() {
    const selectedTxs = transactions.filter(t => t.selected);
    const totalExp = selectedTxs.filter(t => t.type === 'Расход').reduce((s, t) => s + t.amount, 0);
    const totalInc = selectedTxs.filter(t => t.type === 'Доход').reduce((s, t) => s + t.amount, 0);

    const bankName = bankConfig.name || 'Банк';
    const iconKey = bankConfig.iconKey || bankConfig.slug || '';
    const badgeColor = bankConfig.badgeColor || 'bg-blue-900/60 text-blue-300 border-blue-700/60';

    if (info) {
      info.innerHTML = `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-xl text-[11px] font-semibold border ${badgeColor}">
          <span data-bank-icon="${iconKey}" class="w-4 h-4 flex items-center justify-center flex-shrink-0"></span>
          <span>${escapeHtml(bankName)}</span>
        </span>
        <span class="text-xs text-[#848D99] truncate font-normal" title="${escapeHtml(fileName)}">
          ${escapeHtml(fileName)}
        </span>
      `;
      if (typeof renderBankIcons === 'function') {
        renderBankIcons();
      }
    }

    // Обновляем метрики в компактной горизонтальной карточке
    const cntEl = document.getElementById('pdf-stat-count');
    const expEl = document.getElementById('pdf-stat-exp');
    const incEl = document.getElementById('pdf-stat-inc');
    if (cntEl) cntEl.innerText = `${selectedTxs.length} из ${transactions.length}`;
    if (expEl) expEl.innerText = formatMoney(totalExp);
    if (incEl) incEl.innerText = formatMoney(totalInc);

    // Точный раздельный подсчет операций
    const newCount = transactions.filter(t => !t.isDuplicate && !t.isTransfer).length;
    const transfersCount = transactions.filter(t => t.isTransfer).length;
    const dupesCount = transactions.filter(t => t.isDuplicate && !t.isTransfer).length;

    const cntNew = document.getElementById('tab-count-new');
    const cntTransfers = document.getElementById('tab-count-transfers');
    const cntDupes = document.getElementById('tab-count-dupes');
    const cntAll = document.getElementById('tab-count-all');

    if (cntNew) cntNew.innerText = newCount;
    if (cntTransfers) cntTransfers.innerText = transfersCount;
    if (cntDupes) cntDupes.innerText = dupesCount;
    if (cntAll) cntAll.innerText = transactions.length;

    const tabTransfers = document.getElementById('tab-import-transfers');
    const tabDupes = document.getElementById('tab-import-dupes');

    // Скрываем вкладки только если в них 0 операций
    if (tabTransfers) tabTransfers.style.display = transfersCount > 0 ? 'flex' : 'none';
    if (tabDupes) tabDupes.style.display = dupesCount > 0 ? 'flex' : 'none';

    const importBtn = document.getElementById('btn-import-transactions');
    if (importBtn) {
      importBtn.innerText = `Импортировать (${selectedTxs.length})`;
      importBtn.disabled = selectedTxs.length === 0;
    }
  }

  window._updateHeaderSummary = updateHeaderSummary;
  setImportFilter('new'); // По умолчанию открываем только новые транзакции
  updateHeaderSummary();

  dialog.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleImportCatMenu(txId) {
  const menu = document.getElementById(`cat-menu-${txId}`);
  const btn = document.getElementById(`cat-btn-${txId}`);
  const card = document.getElementById(`card-tx-${txId}`);
  if (!menu || !btn) return;

  const isClosed = menu.classList.contains('hidden');
  
  // Закрываем все открытые меню и возвращаем исходную прозрачность карточкам
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  document.querySelectorAll('.card-parsed-row').forEach(c => {
    c.style.zIndex = '';
    if (c.dataset.isInactive === 'true') {
      c.style.opacity = '0.55';
    }
  });

  if (isClosed) {
    // Поднимаем z-index и убираем полупрозрачность на время работы с меню
    if (card) {
      card.style.zIndex = '60';
      card.style.opacity = '1';
    }
    
    // Позиционируем вниз (или вверх, если внизу нет места)
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 240 && rect.top > 240) {
      menu.style.bottom = 'calc(100% + 4px)';
      menu.style.top = 'auto';
    } else {
      menu.style.top = 'calc(100% + 4px)';
      menu.style.bottom = 'auto';
    }

    menu.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function selectImportCat(txId, newCat, icon) {
  const tx = window._lastParsedTransactions?.find(t => t._id === txId);
  if (tx) {
    tx.category = newCat;
    const labelEl = document.getElementById(`cat-label-${txId}`);
    if (labelEl) {
      labelEl.innerHTML = `<i data-lucide="${icon}" class="w-[14px] h-[14px]"></i> ${escapeHtml(newCat)}`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
  const menu = document.getElementById(`cat-menu-${txId}`);
  if (menu) menu.classList.add('hidden');
  const card = document.getElementById(`card-tx-${txId}`);
  if (card) card.style.zIndex = '';
}

// Удаление категории прямо из окна импорта
async function deleteCategoryFromImport(catName, type) {
  if (typeof deleteCategory === 'function') {
    await deleteCategory(catName, type);
    // Перерисовываем список импорта с обновленными категориями
    if (window._lastParsedTransactions && window._lastParsedFileName) {
      renderParsedTransactionsView(window._lastParsedFileName, window._lastParsedTransactions, window._lastParsedBankName);
    }
  }
}

// Добавление категории прямо из окна импорта
function addCategoryFromImport(type) {
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  if (typeof showAddCategoryDialog === 'function') {
    showAddCategoryDialog(type);
  }
}

/**
 * Переключение чекбокса операции
 */
function toggleTxSelection(txId, isSelected) {
  const tx = window._lastParsedTransactions.find(t => t._id === txId);
  if (tx) {
    tx.selected = isSelected;
    if (window._updateHeaderSummary) window._updateHeaderSummary();
  }
}

/**
 * Сохранение всех выбранных операций в Firebase
 */
async function importSelectedTransactions() {
  const selected = (window._lastParsedTransactions || []).filter(t => t.selected);
  if (selected.length === 0) {
    showToast('Выберите хотя бы одну операцию', true);
    return;
  }

  const btn = document.getElementById('btn-import-transactions');
  btn.disabled = true;
  btn.innerText = 'Сохранение...';
  showToast(`Импорт ${selected.length} операций...`, false, true);

  try {
    // В Firestore батч вмещает максимум 500 операций
    const CHUNK_SIZE = 400;
    for (let i = 0; i < selected.length; i += CHUNK_SIZE) {
      const chunk = selected.slice(i, i + CHUNK_SIZE);
      const batch = db.batch();

      chunk.forEach(tx => {
        const docRef = (window.getUserCol ? getUserCol('Transactions') : db.collection('Transactions')).doc();
        batch.set(docRef, {
          type: tx.type,
          amount: tx.amount,
          date: tx.date,            // YYYY-MM-DD
          category: tx.category,
          comment: tx.merchant      // Записываем название точки в комментарий
        });
      });

      await batch.commit();
    }

    showToast(`Успешно добавлено ${selected.length} операций!`);
    document.getElementById('pdf-debug-dialog').classList.add('hidden');

    // Обновляем список транзакций и графики
    if (typeof fetchCollection === 'function') {
      await fetchCollection('Transactions');
    }
  } catch (err) {
    console.error('Ошибка импорта:', err);
    showToast('Ошибка при импорте: ' + err.message, true);
    btn.disabled = false;
    btn.innerText = 'Попробовать снова';
  }
}

// Сохраняем последний результат в глобальную переменную для экспорта
window._lastParsedTransactions = [];

function downloadParsedJSON() {
  if (!window._lastParsedTransactions || window._lastParsedTransactions.length === 0) {
    showToast('Нет данных для скачивания', true);
    return;
  }

  const slug = window._lastActiveBank?.slug || 'statement';
  const today = new Date().toISOString().slice(0, 10);

  const jsonStr = JSON.stringify(window._lastParsedTransactions, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}_parsed_${today}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------
// ЛОГИКА ОКНА "ЗАПОМНИТЬ ПРАВИЛО"
// -------------------------------------------------------------
let currentRememberTx = null;

function openRememberRuleModal(txId) {
  const tx = window._lastParsedTransactions?.find(t => t._id === txId);
  if (!tx) return;

  currentRememberTx = tx;

  const keywordInput = document.getElementById('rule-keyword-input');

  // Предзаполняем ключевое слово названием торговой точки
  keywordInput.value = tx.merchant;

  // Выбираем список категорий в зависимости от типа операции (Доход или Расход)
  let targetCats = [];
  
  if (tx.type === 'Доход') {
    targetCats = window.Cache?.categories?.income?.map(c => c.name) || ['Зарплата', 'Другое'];
  } else {
    targetCats = [
      'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Одежда', 'Здоровье', 'Развлечения', 'Другое'
    ];
    if (window.Cache?.categories?.expense) {
      window.Cache.categories.expense.forEach(c => {
        if (!targetCats.includes(c.name)) targetCats.push(c.name);
      });
    }
  }

  populateModalCatMenu('rule', targetCats, tx.category);

  document.getElementById('remember-rule-dialog').classList.remove('hidden');
}

function closeRememberRuleModal() {
  document.getElementById('remember-rule-dialog').classList.add('hidden');
  currentRememberTx = null;
}

async function saveCategoryRuleFromModal() {
  const keyword = document.getElementById('rule-keyword-input').value.trim();
  const category = document.getElementById('rule-category-input').value;
  
  if (!keyword) {
    showToast('Введите ключевую фразу', true);
    return;
  }

  showToast('Сохранение правила...', false, true);

  try {
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');

    // Если слово ранее было подавлено пользователем — удаляем маркер disabled
    const snap = await col.where('pattern', '==', keyword).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));

    const newDocRef = col.doc();
    batch.set(newDocRef, { pattern: keyword, category: category });
    await batch.commit();

    const normKeyword = StatementCategorizer.normalize(keyword);
    if (!window.Cache.categoryRules) window.Cache.categoryRules = [];
    window.Cache.categoryRules = window.Cache.categoryRules.filter(r => StatementCategorizer.normalize(r.pattern) !== normKeyword);
    window.Cache.categoryRules.push({ id: newDocRef.id, pattern: keyword, category: category, isSystem: false });

    if (window._lastParsedTransactions) {
      window._lastParsedTransactions.forEach(t => {
        const full = `${t.merchant} ${t.rawDetails}`.toLowerCase();
        if (full.includes(keyword.toLowerCase())) {
          t.category = category;
          const sel = document.getElementById(`cat-select-${t._id}`);
          if (sel) sel.value = category;
        }
      });
    }

    closeRememberRuleModal();
    showToast(`Правило сохранено: "${keyword}" → ${category}`);
  } catch (err) {
    console.error('Ошибка сохранения правила:', err);
    showToast('Ошибка при сохранении: ' + err.message, true);
  }
}

// -------------------------------------------------------------
// РЕДАКТОР СЛОВАРЯ КАТЕГОРИЙ (ШЕСТЕРЕНКА ⚙️)
// -------------------------------------------------------------
function openRulesEditorModal() {
  const dialog = document.getElementById('rules-editor-dialog');

  const allCats = [...new Set([...getActiveCategories('Расход'), ...getActiveCategories('Доход')])];
  
  populateModalCatMenu('editor', allCats, 'Продукты');

  document.getElementById('editor-keyword-input').value = '';
  renderRulesList();
  dialog.classList.remove('hidden');
}

function closeRulesEditorModal() {
  document.getElementById('rules-editor-dialog').classList.add('hidden');
  
  if (window._returnToProfile) {
    window._returnToProfile = false;
    if (typeof openProfileModal === 'function') {
      openProfileModal();
    }
  }
}

function renderRulesList() {
  const container = document.getElementById('editor-rules-list');
  const rules = window.Cache?.categoryRules || [];

  if (rules.length === 0) {
    container.innerHTML = '<p class="text-xs text-gray-500 text-center py-4">В словаре пока нет правил</p>';
    return;
  }

  const grouped = {};
  rules.forEach(r => {
    const cat = r.category || 'Другое';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  });

  let html = '';
  Object.keys(grouped).sort().forEach(cat => {
    const catIcon = getDynamicCategoryIcon(cat);
    html += `
      <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-3 mb-3">
        <div class="text-[13px] font-bold text-gray-200 mb-2.5 flex items-center gap-2 border-b border-[rgba(255,255,255,0.06)] pb-2">
          <i data-lucide="${catIcon}" class="w-4 h-4 text-[#848D99]"></i>
          <span>${escapeHtml(cat)}</span>
          <span class="text-[11px] text-[#848D99] font-normal">(${grouped[cat].length})</span>
        </div>
        <div class="flex flex-wrap gap-2">
    `;

    grouped[cat].forEach(r => {
      html += `
        <span class="inline-flex items-center gap-1.5 ${r.isSystem ? 'bg-[#212430] text-gray-300' : 'bg-[#6C5DD3]/15 text-white border border-[#6C5DD3]/30'} text-[12px] px-2.5 py-1.5 rounded-lg">
          <span>${escapeHtml(r.pattern)}</span>
          <button type="button" onclick="deleteRuleFromEditor('${r.id}', ${r.isSystem ? 'true' : 'false'}, '${escapeHtml(r.pattern)}')" class="text-gray-500 hover:text-[#FF453A] cursor-pointer" title="Удалить слово"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </span>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function addRuleFromEditor() {
  const input = document.getElementById('editor-keyword-input');
  const keyword = input.value.trim();
  const category = document.getElementById('editor-category-input').value;

  if (!keyword) {
    showToast('Введите слово или фразу', true);
    return;
  }

  showToast('Добавление...', false, true);
  try {
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');

    // Если слово ранее было подавлено, удаляем маркер disabled
    const snap = await col.where('pattern', '==', keyword).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));

    const newDocRef = col.doc();
    batch.set(newDocRef, { pattern: keyword, category: category });
    await batch.commit();

    if (!window.Cache.categoryRules) window.Cache.categoryRules = [];
    window.Cache.categoryRules = window.Cache.categoryRules.filter(r => r.pattern.toLowerCase() !== keyword.toLowerCase());
    window.Cache.categoryRules.push({ id: newDocRef.id, pattern: keyword, category: category, isSystem: false });

    input.value = '';
    renderRulesList();
    applyRulesToOpenedStatement(keyword, category);
    showToast(`Добавлено: "${keyword}" → ${category}`);
  } catch (e) {
    showToast('Ошибка: ' + e.message, true);
  }
}

async function deleteRuleFromEditor(ruleId, isSystem, pattern) {
  try {
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');

    if (isSystem) {
      // Для системных правил фиксируем подавление
      await col.add({ pattern: pattern, disabled: true });
    } else {
      // Для пользовательских правил удаляем документ
      await col.doc(ruleId).delete();
    }

    const normTarget = StatementCategorizer.normalize(pattern);
    window.Cache.categoryRules = (window.Cache.categoryRules || []).filter(r => r.id !== ruleId && StatementCategorizer.normalize(r.pattern) !== normTarget);
    renderRulesList();
    showToast('Слово удалено из словаря');
  } catch (e) {
    showToast('Ошибка удаления: ' + e.message, true);
  }
} 

async function restoreDefaultRules() {
  showToast('Восстановление системных правил...', false, true);
  try {
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');
    const snap = await col.where('disabled', '==', true).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    if (typeof fetchAllData === 'function') {
      await fetchAllData();
    }
    renderRulesList();
    showToast('Системные правила восстановлены');
  } catch (e) {
    showToast('Ошибка восстановления: ' + e.message, true);
  }
}
window.restoreDefaultRules = restoreDefaultRules;

// Пересчитывает категории в открытой выписке при добавлении нового правила
function applyRulesToOpenedStatement(keyword, category) {
  if (!window._lastParsedTransactions) return;
  window._lastParsedTransactions.forEach(t => {
    const full = `${t.merchant} ${t.rawDetails}`.toLowerCase();
    if (full.includes(keyword.toLowerCase())) {
      t.category = category;
      const sel = document.getElementById(`cat-select-${t._id}`);
      if (sel) sel.value = category;
    }
  });
}

// Функции для кастомных меню в модальных окнах
function toggleModalCatMenu(type) {
  const menu = document.getElementById(`${type}-category-menu`);
  if (!menu) return;
  const isClosed = menu.classList.contains('hidden');
  
  // Закрываем все открытые меню
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  
  if (isClosed) menu.classList.remove('hidden');
}

function selectModalCat(type, catName, catIcon) {
  const input = document.getElementById(`${type}-category-input`);
  const label = document.getElementById(`${type}-category-label`);
  const menu = document.getElementById(`${type}-category-menu`);

  if (input) input.value = catName;
  if (label) {
    label.innerHTML = `<i data-lucide="${catIcon || 'tag'}" class="w-4 h-4 inline-block mr-1 align-text-bottom"></i> ${escapeHtml(catName)}`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }
  if (menu) menu.classList.add('hidden');
}

// Универсальная функция генерации списка для модального меню
function populateModalCatMenu(type, categories, selectedCat) {
  const menu = document.getElementById(`${type}-category-menu`);
  const input = document.getElementById(`${type}-category-input`);
  const label = document.getElementById(`${type}-category-label`);
  if (!menu) return;

  const defaultCat = selectedCat || categories[0] || 'Другое';
  const defaultIcon = getDynamicCategoryIcon(defaultCat);

  if (input) input.value = defaultCat;
  if (label) {
    label.innerHTML = `<i data-lucide="${defaultIcon}" class="w-4 h-4 inline-block mr-1 align-text-bottom"></i> ${escapeHtml(defaultCat)}`;
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }

  menu.innerHTML = categories.map(cat => {
    const icon = getDynamicCategoryIcon(cat);
    const isSelected = (cat === defaultCat);
    return `
      <button type="button" 
              onclick="selectModalCat('${type}', '${escapeHtml(cat)}', '${icon}')" 
              class="w-full text-left px-3 py-2 text-[13px] rounded-xl transition-colors flex items-center gap-2.5 cursor-pointer ${isSelected ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] font-semibold' : 'text-gray-300 hover:bg-[#2A2D3C]'}">
        <i data-lucide="${icon}" class="w-4 h-4 ${isSelected ? 'text-[#6C5DD3]' : 'text-[#848D99]'}"></i>
        <span class="truncate">${escapeHtml(cat)}</span>
      </button>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Глобальное закрытие любых открытых кастомных меню при клике в любое место мимо
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown-wrap')) {
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  }
});
