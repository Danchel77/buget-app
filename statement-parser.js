/**
 * statement-parser.js
 * Клиентский парсер PDF-выписок банков
 */

// Инициализация воркера PDF.js
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

class StatementExtractor {
  /**
   * Считывает PDF-файл из браузера без отправки на сервер
   * и возвращает массив структурированных строк по страницам.
   */
  static async extractLinesFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    const allPagesLines = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Группируем элементы текста по строкам на основе Y-координаты
      const lines = this._groupItemsIntoLines(textContent.items);
      allPagesLines.push({
        page: pageNum,
        lines: lines
      });
    }

    return allPagesLines;
  }

  /**
   * Группирует отдельные текстовые фрагменты по близким Y-координатам
   * и сортирует их слева направо (по X-координате).
   */
  static _groupItemsIntoLines(items) {
    // В PDF точка (0,0) обычно находится в левом нижнем углу.
    // item.transform: [scaleX, skewY, skewX, scaleY, transX, transY]
    // transX = transform[4], transY = transform[5]
    
    // Допустимая погрешность по вертикали для объединения в одну строку (в пунктах)
    const Y_TOLERANCE = 3.5;
    
    // Сортируем все элементы страницы сверху вниз (от большего Y к меньшему),
    // а при одинаковом Y — слева направо (от меньшего X к большему)
    const sortedItems = [...items].filter(it => it.str && it.str.trim().length > 0);
    sortedItems.sort((a, b) => {
      if (Math.abs(a.transform[5] - b.transform[5]) > Y_TOLERANCE) {
        return b.transform[5] - a.transform[5]; // сверху вниз
      }
      return a.transform[4] - b.transform[4]; // слева направо
    });

    const lines = [];
    let currentLine = [];
    let currentY = null;

    for (const item of sortedItems) {
      const x = Math.round(item.transform[4]);
      const y = item.transform[5];
      const text = item.str.trim();

      if (currentY === null || Math.abs(y - currentY) <= Y_TOLERANCE) {
        currentLine.push({ x, text });
        if (currentY === null) currentY = y;
      } else {
        // Завершаем текущую строку
        if (currentLine.length > 0) {
          lines.push(this._formatLine(currentLine));
        }
        currentLine = [{ x, text }];
        currentY = y;
      }
    }

    if (currentLine.length > 0) {
      lines.push(this._formatLine(currentLine));
    }

    return lines;
  }

  /**
   * Формирует объект строки: объединяет слова, идущие подряд в колонки
   */
  static _formatLine(items) {
    // items уже отсортированы по координате X
    // Попробуем разделить на смысловые колонки по значительному расстоянию между словами (> 15px)
    const columns = [];
    let curCol = [];
    let prevX = null;

    for (const it of items) {
      if (prevX !== null && (it.x - prevX) > 18) {
        columns.push(curCol.join(' '));
        curCol = [];
      }
      curCol.push(it.text);
      prevX = it.x + (it.text.length * 5); // приблизительное окончание слова
    }
    if (curCol.length > 0) {
      columns.push(curCol.join(' '));
    }

    return {
      rawText: items.map(i => i.text).join(' '),
      columns: columns
    };
  }
}

/**
 * Функция-обработчик загрузки файла из UI
 */
async function handleStatementUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    showToast('Пожалуйста, выберите файл в формате PDF', true);
    return;
  }

  showToast('Чтение выписки...', false, true);

  try {
    const pagesData = await StatementExtractor.extractLinesFromPDF(file);
    
    // Сбрасываем значение input, чтобы можно было загрузить тот же файл снова
    event.target.value = '';

    // Отображаем окно для отладки и проверки Шага 1
    renderDebugView(file.name, pagesData);
    
    document.getElementById('toast-container').classList.add('hidden');
  } catch (err) {
    console.error('Ошибка парсинга PDF:', err);
    showToast('Ошибка при чтении PDF: ' + err.message, true);
  }
}

/**
 * Выводит результат Шага 1 в модальное окно
 */
function renderDebugView(fileName, pagesData) {
  const dialog = document.getElementById('pdf-debug-dialog');
  const info = document.getElementById('pdf-debug-info');
  const output = document.getElementById('pdf-debug-output');

  let totalLines = 0;
  pagesData.forEach(p => totalLines += p.lines.length);

  info.textContent = `Файл: ${fileName} • Страниц: ${pagesData.length} • Всего строк: ${totalLines}`;
  
  let html = '';
  
  pagesData.forEach(p => {
    html += `
      <div class="bg-gray-900/80 p-3 rounded-xl border border-gray-700/80 mb-3">
        <div class="text-[11px] font-bold text-blue-400 mb-2 border-b border-gray-800 pb-1">
          --- СТРАНИЦА ${p.page} (${p.lines.length} строк) ---
        </div>
        <div class="space-y-1.5">
    `;

    p.lines.forEach((line, idx) => {
      const colsHtml = line.columns.map(c => 
        `<span class="inline-block bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-[11px] text-gray-200 mr-1.5 mb-1">${escapeHtml(c)}</span>`
      ).join('');

      html += `
        <div class="hover:bg-gray-800/50 p-1.5 rounded transition-colors border-b border-gray-800/40">
          <div class="text-[10px] text-gray-500 mb-0.5">#${idx + 1} Полная строка: <span class="text-gray-300 font-sans">${escapeHtml(line.rawText)}</span></div>
          <div class="flex flex-wrap items-center mt-1">
            <span class="text-[9px] text-gray-500 uppercase mr-2">Колонки:</span>
            ${colsHtml}
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  output.innerHTML = html;
  dialog.classList.remove('hidden');
}
