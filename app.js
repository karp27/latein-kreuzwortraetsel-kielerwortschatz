/* Kieler Wortschatz · Kreuzworträtsel
   Neuer Aufbau: sauberer Generator, Fortschritt, Hinweise, Zeitmessung. */

(function () {
  'use strict';

  const STORE = 'kieler-xw-v2';
  const MODE_INFO = {
    easy: { label: 'Deutsch', hint: 'Deutsche Bedeutung → lateinisches Wort' },
    gram: { label: 'Grammatik', hint: 'Bedeutung mit Grammatikangabe → lateinisches Wort' },
    conj: { label: 'Formen', hint: 'Perfekt oder PPP eines Verbs → Grundform' },
    mix: { label: 'Mix', hint: 'Alles gemischt' },
  };

  const $ = (sel) => document.querySelector(sel);
  const VOCAB = window.VOCAB || {};

  /* ── Hilfsfunktionen ─────────────────────────────────── */

  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z]/g, '')
      .toUpperCase();
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), 1900);
  }

  /* ── Wortpool ────────────────────────────────────────── */

  function stripParens(text) {
    return String(text || '').replace(/\([^)]*\)/g, ' ').trim();
  }

  function perfectForm(grammar) {
    // "animadvertō, animadvertī, animadversum in" -> "animadvertī"
    const parts = grammar.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return '';
    const second = stripParens(parts[1]).split(/\s+/)[0];
    return second && /^[A-Za-zāēīōūȳĀĒĪŌŪ+.-]+$/.test(second) ? second : '';
  }

  function pppForm(grammar) {
    const parts = grammar.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return '';
    const third = stripParens(parts[2]).split(/\s+/)[0];
    if (!third || third === '---' || third === '—') return '';
    return /^[A-Za-zāēīōūȳĀĒĪŌŪ+.-]+$/.test(third) ? third : '';
  }

  function buildPool(lists, mode, size) {
    const maxLen = size;
    const seen = new Set();
    const pool = [];

    lists.forEach((num) => {
      (VOCAB[String(num)] || []).forEach((entry) => {
        const [latin, german, grammar] = entry;
        const answer = fold(latin);
        if (answer.length < 3 || answer.length > maxLen) return;
        if (seen.has(answer)) return;

        let clue = '';
        let kind = mode;
        if (mode === 'mix') kind = ['easy', 'gram', 'conj'][Math.floor(Math.random() * 3)];

        if (kind === 'easy') {
          clue = german;
        } else if (kind === 'gram') {
          if (!grammar) return;
          clue = german + ' · ' + grammar;
        } else if (kind === 'conj') {
          const perf = perfectForm(grammar);
          const ppp = pppForm(grammar);
          if (!perf && !ppp) return;
          const usePpp = ppp && (!perf || Math.random() < 0.4);
          clue = (usePpp ? 'PPP von ' : 'Perfekt von ') + latin.split(',')[0].trim();
        }
        if (!clue) return;

        seen.add(answer);
        pool.push({ answer, clue, list: num });
      });
    });
    return pool;
  }

  /* ── Generator ───────────────────────────────────────── */

  function key(r, c) { return r + ',' + c; }

  function placeWord(grid, word, r, c, dir) {
    const letters = word.split('');
    letters.forEach((ch, i) => {
      grid.set(key(r + (dir === 'D' ? i : 0), c + (dir === 'A' ? i : 0)), ch);
    });
  }

  function canPlace(grid, word, r, c, dir, size) {
    const letters = word.split('');
    for (let i = 0; i < letters.length; i++) {
      const rr = r + (dir === 'D' ? i : 0);
      const cc = c + (dir === 'A' ? i : 0);
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) return -1;
      const existing = grid.get(key(rr, cc));
      if (existing) {
        // Besetzt: nur als Kreuzung erlaubt, dann keine Nachbarprüfung
        if (existing !== letters[i]) return -1;
        continue;
      }

      // Leere Zelle: die Quernachbarn müssen frei bleiben
      const perp = dir === 'A'
        ? [[rr - 1, cc], [rr + 1, cc]]
        : [[rr, cc - 1], [rr, cc + 1]];
      for (const [pr, pc] of perp) {
        if (grid.has(key(pr, pc))) return -1;
      }
    }
    // Zellen direkt vor und hinter dem Wort müssen frei sein
    const before = dir === 'A' ? [r, c - 1] : [r - 1, c];
    const after = dir === 'A' ? [r, c + letters.length] : [r + letters.length, c];
    if (grid.has(key(before[0], before[1])) || grid.has(key(after[0], after[1]))) return -1;

    let crossings = 0;
    letters.forEach((ch, i) => {
      const rr = r + (dir === 'D' ? i : 0);
      const cc = c + (dir === 'A' ? i : 0);
      if (grid.get(key(rr, cc)) === ch) crossings++;
    });
    return crossings;
  }

  function bestPlacement(grid, word, size) {
    let best = null;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        for (const dir of ['A', 'D']) {
          const crossings = canPlace(grid, word, r, c, dir, size);
          if (crossings < 1) continue;
          const centreDist = Math.abs(r - size / 2) + Math.abs(c - size / 2);
          const score = crossings * 12 - centreDist * 0.4;
          if (!best || score > best.score) best = { r, c, dir, score, crossings };
        }
      }
    }
    return best;
  }

  function attempt(words, size, rng) {
    const grid = new Map();
    const placed = [];
    let crossings = 0;
    const order = shuffle(words, rng).sort((a, b) => b.answer.length - a.answer.length);

    order.forEach((entry, index) => {
      const word = entry.answer;
      if (index === 0) {
        const r = Math.floor(size / 2);
        const c = Math.max(0, Math.floor((size - word.length) / 2));
        placeWord(grid, word, r, c, 'A');
        placed.push({ ...entry, r, c, dir: 'A' });
        return;
      }
      const spot = bestPlacement(grid, word, size);
      if (!spot) return;
      crossings += spot.crossings || 1;
      placeWord(grid, word, spot.r, spot.c, spot.dir);
      placed.push({ ...entry, r: spot.r, c: spot.c, dir: spot.dir });
    });

    return { grid, placed, score: placed.length * 1000 + crossings * 40 };
  }

  function buildPuzzle(pool, size, seed) {
    if (!pool.length) return null;
    const rng = mulberry32(seed);
    const slice = shuffle(pool, rng).slice(0, Math.min(pool.length, 48));
    let best = null;
    for (let i = 0; i < 40; i++) {
      const candidate = attempt(slice, size, mulberry32(seed + i * 7919));
      if (!candidate.placed.length) continue;
      if (!best || candidate.score > best.score) best = candidate;
      if (best.placed.length >= 16) break;
    }
    if (!best) return null;
    return finalise(best.placed, size);
  }

  function finalise(placed, size) {
    let minR = size, minC = size, maxR = 0, maxC = 0;
    placed.forEach((w) => {
      const endR = w.r + (w.dir === 'D' ? w.answer.length - 1 : 0);
      const endC = w.c + (w.dir === 'A' ? w.answer.length - 1 : 0);
      minR = Math.min(minR, w.r); minC = Math.min(minC, w.c);
      maxR = Math.max(maxR, endR); maxC = Math.max(maxC, endC);
    });

    const rows = maxR - minR + 1;
    const cols = maxC - minC + 1;
    const cells = [];
    placed.forEach((w) => {
      w.r -= minR; w.c -= minC;
      const targets = [];
      for (let i = 0; i < w.answer.length; i++) {
        const r = w.r + (w.dir === 'D' ? i : 0);
        const c = w.c + (w.dir === 'A' ? i : 0);
        targets.push({ r, c, ch: w.answer[i] });
        let cell = cells.find((x) => x.r === r && x.c === c);
        if (!cell) {
          cell = { r, c, ch: w.answer[i], across: null, down: null, no: 0 };
          cells.push(cell);
        }
        if (w.dir === 'A') cell.across = w; else cell.down = w;
      }
      w.cells = targets;
    });

    // Nummerierung wie im klassischen Kreuzworträtsel
    const sorted = cells.slice().sort((a, b) => (a.r - b.r) || (a.c - b.c));
    let counter = 0;
    sorted.forEach((cell) => {
      const startsAcross = cell.across && cell.across.cells[0].r === cell.r && cell.across.cells[0].c === cell.c;
      const startsDown = cell.down && cell.down.cells[0].r === cell.r && cell.down.cells[0].c === cell.c;
      if (startsAcross || startsDown) {
        counter += 1;
        cell.no = counter;
      }
      if (startsAcross) cell.across.no = counter || cell.across.no;
      if (startsDown) cell.down.no = counter || cell.down.no;
    });

    placed.forEach((w) => { if (!w.no) w.no = 0; });

    return {
      rows, cols, cells,
      words: placed.filter((w) => w.no),
      across: placed.filter((w) => w.dir === 'A' && w.no).sort((a, b) => a.no - b.no),
      down: placed.filter((w) => w.dir === 'D' && w.no).sort((a, b) => a.no - b.no),
    };
  }

  /* ── Zustand ─────────────────────────────────────────── */

  const state = {
    lists: new Set([1, 2, 3, 4]),
    mode: 'easy',
    size: 11,
    puzzle: null,
    letters: {},
    checked: {},
    sel: null,
    dir: 'A',
    seed: 0,
    startedAt: 0,
    elapsed: 0,
    timer: null,
    finished: false,
  };

  /* ── Startbildschirm ─────────────────────────────────── */

  function renderListChips() {
    const holder = $('#listChips');
    holder.innerHTML = '';
    for (let n = 1; n <= 50; n++) {
      const chip = document.createElement('button');
      chip.className = 'chip' + (state.lists.has(n) ? ' on' : '');
      chip.textContent = n;
      chip.addEventListener('click', () => {
        if (state.lists.has(n)) state.lists.delete(n); else state.lists.add(n);
        chip.classList.toggle('on');
        updatePoolHint();
      });
      holder.appendChild(chip);
    }
  }

  function updatePoolHint() {
    const pool = buildPool([...state.lists], state.mode, state.size);
    $('#poolHint').textContent = pool.length
      ? pool.length + ' Wörter passen zu dieser Auswahl'
      : 'Keine Wörter passen — bitte mehr Listen wählen.';
    $('#btnStart').disabled = pool.length < 5;
  }

  function moveSegThumb(seg) {
    const thumb = seg.querySelector('.thumb');
    const active = seg.querySelector('button.on');
    if (!thumb || !active) return;
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + active.offsetLeft - seg.clientLeft + 'px)';
  }

  function initSeg(sel, onPick) {
    const seg = $(sel);
    seg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        moveSegThumb(seg);
        onPick(btn);
      });
    });
    requestAnimationFrame(() => moveSegThumb(seg));
    window.addEventListener('resize', () => moveSegThumb(seg));
  }

  /* ── Rätsel rendern ──────────────────────────────────── */

  function cellSize(cols) {
    const card = $('.board-card');
    const width = card ? card.clientWidth - 22 : window.innerWidth - 60;
    const fit = Math.floor((width - (cols - 1) * 1.5) / cols);
    return Math.max(26, Math.min(42, fit));
  }

  function renderPuzzle() {
    const p = state.puzzle;
    if (!p) return;
    const grid = $('#grid');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = 'repeat(' + p.cols + ', var(--cell))';
    document.documentElement.style.setProperty('--cell', cellSize(p.cols) + 'px');

    for (let r = 0; r < p.rows; r++) {
      for (let c = 0; c < p.cols; c++) {
        const cell = p.cells.find((x) => x.r === r && x.c === c);
        const el = document.createElement('div');
        el.className = 'cell';
        if (!cell) {
          el.classList.add('empty');
          grid.appendChild(el);
          continue;
        }
        el.dataset.r = r;
        el.dataset.c = c;
        if (cell.no) {
          const num = document.createElement('span');
          num.className = 'num';
          num.textContent = cell.no;
          el.appendChild(num);
        }
        const letter = document.createElement('span');
        letter.className = 'letter';
        letter.textContent = state.letters[key(r, c)] || '';
        el.appendChild(letter);
        el.addEventListener('click', () => onCellClick(r, c));
        grid.appendChild(el);
      }
    }
    paintSelection();
    renderClues();
    updateStatus();
  }

  function renderClues() {
    const p = state.puzzle;
    ['#cluesA', '#cluesD', '#sheetCluesA', '#sheetCluesD'].forEach((sel) => { $(sel).innerHTML = ''; });
    const fill = (list, sel, whole) => {
      const holder = $(sel);
      list.forEach((w) => {
        const item = document.createElement('div');
        item.className = 'clue-item';
        item.dataset.word = w.no + w.dir;
        const done = isWordDone(w);
        if (done) item.classList.add('done');
        const cur = activeWord();
        if (cur && cur.no === w.no && cur.dir === w.dir) item.classList.add('active');
        item.innerHTML = '<span class="no">' + w.no + '</span><span>' + w.clue + ' · ' + w.answer.length + '</span>';
        item.addEventListener('click', () => {
          selectWord(w);
          if (!whole) closeSheets();
          else closeSheets();
        });
        holder.appendChild(item);
      });
    };
    fill(p.across, '#cluesA', false);
    fill(p.down, '#cluesD', false);
    fill(p.across, '#sheetCluesA', true);
    fill(p.down, '#sheetCluesD', true);
  }

  function isWordDone(w) {
    return w.cells.every((c) => state.letters[key(c.r, c.c)] === c.ch);
  }

  function paintSelection() {
    document.querySelectorAll('.cell').forEach((el) => el.classList.remove('hl', 'active'));
    if (!state.sel) return;
    const { r, c } = state.sel;
    const word = state.puzzle.cells.find((x) => x.r === r && x.c === c);
    const active = word && (state.dir === 'A' ? word.across : word.down);
    if (active) {
      active.cells.forEach((cell) => {
        const el = document.querySelector('.cell[data-r="' + cell.r + '"][data-c="' + cell.c + '"]');
        if (el) el.classList.add('hl');
      });
    }
    const current = document.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"]');
    if (current) current.classList.add('active');

    document.querySelectorAll('.clue-item').forEach((el) => {
      el.classList.toggle('active', !!active && el.dataset.word === active.no + active.dir);
    });

    const bar = $('#cluebar');
    if (active) {
      $('#cbNo').textContent = active.no + ' ' + (active.dir === 'A' ? 'waagerecht' : 'senkrecht');
      $('#cbText').textContent = active.clue + ' · ' + active.answer.length;
    } else {
      $('#cbNo').textContent = '';
      $('#cbText').textContent = '—';
    }
  }

  function updateStatus() {
    const p = state.puzzle;
    if (!p) return;
    const done = p.words.filter(isWordDone).length;
    $('#statWords').textContent = done + '/' + p.words.length;
    $('#statMode').textContent = MODE_INFO[state.mode].label;
    const bar = $('#progressFill');
    if (bar) bar.style.width = Math.round((done / Math.max(1, p.words.length)) * 100) + '%';
  }

  /* ── Auswahl und Eingabe ─────────────────────────────── */

  function onCellClick(r, c) {
    const cell = state.puzzle.cells.find((x) => x.r === r && x.c === c);
    if (!cell) return;
    if (state.sel && state.sel.r === r && state.sel.c === c) {
      if (cell.across && cell.down) {
        state.dir = state.dir === 'A' ? 'D' : 'A';
      }
    } else if (cell.across && !cell.down) {
      state.dir = 'A';
    } else if (cell.down && !cell.across) {
      state.dir = 'D';
    }
    state.sel = { r, c };
    paintSelection();
    focusKbd();
  }

  function selectWord(w) {
    state.dir = w.dir;
    state.sel = { r: w.cells[0].r, c: w.cells[0].c };
    paintSelection();
    focusKbd();
  }

  function activeWord() {
    if (!state.sel) return null;
    const cell = state.puzzle.cells.find((x) => x.r === state.sel.r && x.c === state.sel.c);
    if (!cell) return null;
    return state.dir === 'A' ? cell.across : cell.down;
  }

  function focusKbd() {
    const kbd = $('#kbd');
    kbd.value = '';
    if (window.matchMedia('(pointer: coarse)').matches) kbd.focus({ preventScroll: true });
  }

  function typeLetter(ch) {
    const word = activeWord();
    if (!word || !state.sel) return;
    const cell = state.puzzle.cells.find((x) => x.r === state.sel.r && x.c === state.sel.c);
    if (!cell) return;
    state.letters[key(cell.r, cell.c)] = ch;
    paintCell(cell.r, cell.c);
    advance(+1);
  }

  function eraseLetter() {
    if (!state.sel) return;
    const { r, c } = state.sel;
    if (state.letters[key(r, c)]) {
      delete state.letters[key(r, c)];
      paintCell(r, c);
      return;
    }
    advance(-1);
    if (state.sel) {
      delete state.letters[key(state.sel.r, state.sel.c)];
      paintCell(state.sel.r, state.sel.c);
    }
  }

  function advance(step) {
    const word = activeWord();
    if (!word || !state.sel) return;
    const idx = word.cells.findIndex((x) => x.r === state.sel.r && x.c === state.sel.c);
    const next = word.cells[idx + step];
    if (next) {
      state.sel = { r: next.r, c: next.c };
      paintSelection();
    }
  }

  function paintCell(r, c) {
    const el = document.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"] .letter');
    if (el) el.textContent = state.letters[key(r, c)] || '';
    const wrap = document.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"]');
    if (wrap) wrap.classList.remove('wrong', 'revealed');
    updateStatus();
    renderClues();
    paintSelection();
    save();
    maybeFinish();
  }

  function maybeFinish() {
    const p = state.puzzle;
    if (!p || state.finished) return;
    const done = p.words.every(isWordDone);
    if (!done) return;
    state.finished = true;
    stopTimer();
    $('#resultTime').textContent = fmtTime(state.elapsed);
    $('#resultWords').textContent = p.words.length;
    $('#resultMode').textContent = MODE_INFO[state.mode].label;
    $('#resultLine').textContent = 'Alle ' + p.words.length + ' Wörter gelöst.';
    openSheet('#sheetResult');
    localStorage.removeItem(STORE);
  }

  /* ── Werkzeuge ───────────────────────────────────────── */

  function checkAll() {
    const p = state.puzzle;
    let wrong = 0;
    p.cells.forEach((cell) => {
      const typed = state.letters[key(cell.r, cell.c)];
      const el = document.querySelector('.cell[data-r="' + cell.r + '"][data-c="' + cell.c + '"]');
      if (!el) return;
      el.classList.remove('wrong');
      if (typed && typed !== cell.ch) {
        el.classList.add('wrong');
        wrong++;
      }
    });
    toast(wrong ? wrong + ' falsche Buchstaben' : 'Alles richtig bis hierher');
    setTimeout(() => document.querySelectorAll('.cell.wrong').forEach((el) => el.classList.remove('wrong')), 2600);
  }

  function revealWord() {
    const word = activeWord();
    if (!word) return;
    word.cells.forEach((cell) => {
      state.letters[key(cell.r, cell.c)] = cell.ch;
      const el = document.querySelector('.cell[data-r="' + cell.r + '"][data-c="' + cell.c + '"]');
      if (el) {
        el.querySelector('.letter').textContent = cell.ch;
        el.classList.add('revealed');
      }
    });
    updateStatus();
    renderClues();
    save();
    maybeFinish();
  }

  /* ── Timer ───────────────────────────────────────────── */

  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      if (document.hidden) return;
      state.elapsed++;
      $('#statTime').textContent = fmtTime(state.elapsed);
      if (state.elapsed % 5 === 0) save();
    }, 1000);
  }

  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  /* ── Speichern ───────────────────────────────────────── */

  function save() {
    if (!state.puzzle || state.finished) return;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        seed: state.seed,
        mode: state.mode,
        size: state.size,
        lists: [...state.lists],
        letters: state.letters,
        elapsed: state.elapsed,
      }));
    } catch (e) { /* Speicher voll oder blockiert */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !data.seed) return false;
      state.mode = data.mode || 'easy';
      state.size = data.size || 11;
      state.lists = new Set(data.lists || [1, 2, 3, 4]);
      state.seed = data.seed;
      state.elapsed = data.elapsed || 0;
      const pool = buildPool([...state.lists], state.mode, state.size);
      const puzzle = buildPuzzle(pool, state.size, state.seed);
      if (!puzzle) return false;
      state.puzzle = puzzle;
      state.letters = data.letters || {};
      showPuzzle();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── Ansichten ───────────────────────────────────────── */

  function showPuzzle() {
    $('#setupView').classList.add('off');
    $('#puzzleView').classList.add('on');
    $('#btnBack').hidden = false;
    $('#btnClues').hidden = false;
    $('#navTitle').textContent = 'Rätsel';
    renderPuzzle();
    $('#statTime').textContent = fmtTime(state.elapsed);
    startTimer();
  }

  function showSetup() {
    stopTimer();
    save();
    $('#setupView').classList.remove('off');
    $('#puzzleView').classList.remove('on');
    $('#btnBack').hidden = true;
    $('#btnClues').hidden = true;
    $('#navTitle').textContent = 'Kreuzworträtsel';
    closeSheets();
    state.puzzle = null;
    state.letters = {};
    state.sel = null;
    state.finished = false;
    state.elapsed = 0;
    updatePoolHint();
  }

  function newPuzzle(force) {
    if (!force && state.puzzle && Object.keys(state.letters).length) {
      if (!window.confirm('Neues Rätsel starten? Der aktuelle Fortschritt geht verloren.')) return;
    }
    const pool = buildPool([...state.lists], state.mode, state.size);
    if (pool.length < 5) {
      toast('Zu wenige Wörter für diese Auswahl');
      return;
    }
    state.seed = Math.floor(Math.random() * 1e9);
    const puzzle = buildPuzzle(pool, state.size, state.seed);
    if (!puzzle) {
      toast('Kein Rätsel möglich — andere Listen probieren');
      return;
    }
    state.puzzle = puzzle;
    state.letters = {};
    state.checked = {};
    state.finished = false;
    state.elapsed = 0;
    state.sel = { r: puzzle.cells[0].r, c: puzzle.cells[0].c };
    state.dir = 'A';
    localStorage.removeItem(STORE);
    closeSheets();
    showPuzzle();
    save();
  }

  /* ── Sheets ──────────────────────────────────────────── */

  function openSheet(sel) {
    closeSheets();
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
    $(sel).classList.add('open');
    $('#scrim').classList.add('on');
    document.body.style.overflow = 'hidden';
  }

  function closeSheets() {
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
    $('#scrim').classList.remove('on');
    document.body.style.overflow = '';
  }

  /* ── Start ───────────────────────────────────────────── */

  function init() {
    renderListChips();

    document.querySelectorAll('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.range;
        state.lists = new Set();
        if (r === 'all') for (let i = 1; i <= 50; i++) state.lists.add(i);
        else {
          const [a, b] = r.split('-').map(Number);
          for (let i = a; i <= b; i++) state.lists.add(i);
        }
        document.querySelectorAll('#listChips .chip').forEach((chip) => {
          chip.classList.toggle('on', state.lists.has(Number(chip.textContent)));
        });
        updatePoolHint();
      });
    });

    initSeg('#segMode', (btn) => {
      state.mode = btn.dataset.mode;
      $('#modeHint').textContent = MODE_INFO[state.mode].hint;
      updatePoolHint();
    });
    initSeg('#segSize', (btn) => {
      state.size = Number(btn.dataset.size);
      updatePoolHint();
    });

    $('#btnStart').addEventListener('click', () => newPuzzle(true));
    $('#btnNew').addEventListener('click', () => newPuzzle(false));
    $('#btnBack').addEventListener('click', showSetup);
    $('#btnClues').addEventListener('click', () => openSheet('#sheetClues'));
    $('#scrim').addEventListener('click', closeSheets);
    $('#btnResultClose').addEventListener('click', () => { closeSheets(); showSetup(); });
    $('#btnResultNew').addEventListener('click', () => newPuzzle(true));
    $('#btnCheck').addEventListener('click', checkAll);
    $('#btnReveal').addEventListener('click', revealWord);

    $('#btnPrev').addEventListener('click', () => stepWord(-1));
    $('#btnNext').addEventListener('click', () => stepWord(1));

    const kbd = $('#kbd');
    kbd.addEventListener('input', () => {
      const value = kbd.value.replace(/[^A-Za-z]/g, '');
      kbd.value = '';
      if (value) typeLetter(value.slice(-1).toUpperCase());
    });
    kbd.addEventListener('keydown', (ev) => {
      if (ev.key === 'Backspace') { ev.preventDefault(); eraseLetter(); }
    });

    document.addEventListener('keydown', (ev) => {
      if (!state.puzzle || document.querySelector('.sheet.open')) return;
      if (ev.target === kbd) return;
      if (/^[a-zA-Z]$/.test(ev.key)) { typeLetter(ev.key.toUpperCase()); ev.preventDefault(); }
      else if (ev.key === 'Backspace') { eraseLetter(); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { moveSel(0, 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { moveSel(0, -1); ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { moveSel(1, 0); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { moveSel(-1, 0); ev.preventDefault(); }
      else if (ev.key === 'Tab' || ev.key === 'Enter') { stepWord(1); ev.preventDefault(); }
    });

    window.addEventListener('resize', () => {
      if (state.puzzle) {
        document.documentElement.style.setProperty('--cell', cellSize(state.puzzle.cols) + 'px');
      }
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

    updatePoolHint();
    if (!restore()) showSetup();
  }

  function moveSel(dr, dc) {
    if (!state.sel) return;
    const next = { r: state.sel.r + dr, c: state.sel.c + dc };
    const cell = state.puzzle.cells.find((x) => x.r === next.r && x.c === next.c);
    if (!cell) return;
    state.sel = next;
    if (cell.across && !cell.down) state.dir = 'A';
    if (cell.down && !cell.across) state.dir = 'D';
    paintSelection();
  }

  function stepWord(step) {
    if (!state.puzzle) return;
    const list = state.dir === 'A' ? state.puzzle.across : state.puzzle.down;
    if (!list.length) return;
    const current = activeWord();
    const idx = current ? list.findIndex((w) => w.no === current.no) : -1;
    const next = list[(idx + step + list.length) % list.length];
    selectWord(next);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
