document.addEventListener("DOMContentLoaded", () => {
  const config = {
    smoothing: 0.1,
    movementThreshold: 2, // было 0.01 — сотни невидимых кругов после остановки курсора
    sizeFromSpeed: 0.2,
    expandMultiplier: 2,
    expandTime: 2,
    expandEase: "power1.inOut",
    dissolveStart: 2,
    dissolveTime: 3,
    dissolveEase: "power3.in",

    // То, что раньше делал фильтр #smudge-goo
    gooBlur: 25, // = stdDeviation у feGaussianBlur
    gooThreshold: 14.5 / 60, // = середина порога из feColorMatrix "0 0 0 60 -14"
    gridCells: 30000, // точность сетки: больше — точнее контур, но дороже кадр
  };

  const hero = document.querySelector(".hero");
  const smudgeSVG = document.querySelector(".smudge-revealer");
  const smudgeContainer = document.querySelector(".smudge-blobs");

  // Фильтр больше не нужен: «жидкая» форма считается в JS,
  // и в маске лежит один готовый path вместо сотен кругов под blur.
  smudgeContainer.removeAttribute("filter");
  const maskPath = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  maskPath.setAttribute("fill", "#fff");
  maskPath.setAttribute("fill-rule", "evenodd");
  smudgeContainer.replaceChildren(maskPath);

  // Как preventDefault в исходном коде: палец по hero рисует, а не листает.
  // Поставьте "pan-y", если вертикальный свайп должен прокручивать страницу.
  hero.style.touchAction = "none";

  // #region goo-core
  // Повторяет feGaussianBlur + feColorMatrix на грубой сетке
  // и превращает результат в гладкий контур (marching squares).
  function createGoo({ blur, threshold, gridCells }) {
    // Вершины клетки: a=(0,0) b=(1,0) c=(1,1) d=(0,1); рёбра: 0=верх 1=право 2=низ 3=лево
    const MID = [
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ];
    const CORNER = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const BIT = [8, 4, 2, 1];
    const SHARED = { "0,1": 1, "1,2": 2, "2,3": 3, "0,3": 0 };

    // Разворачиваем каждый отрезок так, чтобы «внутри» всегда было с одной стороны:
    // тогда отрезки соседних клеток сцепляются в замкнутые контуры без поиска.
    function orient(caseIndex, pairs) {
      const out = [];
      for (const [e1, e2] of pairs) {
        const key = Math.min(e1, e2) + "," + Math.max(e1, e2);
        const ref = key in SHARED ? SHARED[key] : 0;
        const [x1, y1] = MID[e1];
        const [x2, y2] = MID[e2];
        const [rx, ry] = CORNER[ref];
        const side = Math.sign((x2 - x1) * (ry - y1) - (y2 - y1) * (rx - x1));
        const insideSide = caseIndex & BIT[ref] ? side : -side;
        out.push(...(insideSide < 0 ? [e1, e2] : [e2, e1]));
      }
      return out;
    }

    const RAW = [
      null,
      [[3, 2]],
      [[2, 1]],
      [[3, 1]],
      [[0, 1]],
      [
        [0, 1],
        [3, 2],
      ],
      [[0, 2]],
      [[0, 3]],
      [[0, 3]],
      [[0, 2]],
      [
        [0, 3],
        [2, 1],
      ],
      [[0, 1]],
      [[3, 1]],
      [[1, 2]],
      [[3, 2]],
      null,
    ];
    const SEGS = RAW.map((pairs, i) => (pairs ? orient(i, pairs) : null));
    const SADDLE = {
      5: orient(5, [
        [0, 3],
        [1, 2],
      ]),
      10: orient(10, [
        [0, 1],
        [3, 2],
      ]),
    };

    let cols = 0;
    let rows = 0;
    let cell = 1;
    let pad = 0;
    let boxes = [];
    let field, tmp, colAcc, next, stamp, visit, ptX, ptY, starts;
    let frame = 0;
    const loop = [];

    // Три box-blur подряд ≈ гауссово размытие
    function boxRadii(sigma, n) {
      const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
      let wl = Math.floor(wIdeal);
      if (wl % 2 === 0) wl--;
      const wu = wl + 2;
      const m = Math.round(
        (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4),
      );
      const radii = [];
      for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
      return radii;
    }

    function resize(width, height) {
      cell = Math.max(4, Math.sqrt((width * height) / gridCells));
      boxes = boxRadii(blur / cell, 3);
      pad = boxes.reduce((sum, r) => sum + r, 0) + 2; // запас под «хвост» размытия
      cols = Math.ceil(width / cell) + 2 * pad + 1;
      rows = Math.ceil(height / cell) + 2 * pad + 1;
      const n = cols * rows;
      field = new Float32Array(n);
      tmp = new Float32Array(n);
      colAcc = new Float64Array(cols);
      next = new Int32Array(2 * n);
      stamp = new Uint32Array(2 * n);
      visit = new Uint32Array(2 * n);
      ptX = new Float32Array(2 * n);
      ptY = new Float32Array(2 * n);
      starts = new Int32Array(2 * n);
      frame = 0;
    }

    // Размываем только окно вокруг живых пятен: за его пределами поле и так нулевое
    function blurH(src, dst, r, x0, x1, y0, y1) {
      const C = cols;
      const norm = 1 / (2 * r + 1);
      for (let y = y0; y <= y1; y++) {
        const row = y * C;
        let acc = 0;
        for (let k = x0; k <= x0 + r && k <= x1; k++) acc += src[row + k];
        for (let x = x0; x <= x1; x++) {
          dst[row + x] = acc * norm;
          if (x + r + 1 <= x1) acc += src[row + x + r + 1];
          if (x - r >= x0) acc -= src[row + x - r];
        }
      }
    }

    // По вертикали идём строками и копим суммы сразу для всех столбцов — так быстрее
    function blurV(src, dst, r, x0, x1, y0, y1) {
      const C = cols;
      const acc = colAcc;
      const norm = 1 / (2 * r + 1);
      acc.fill(0);
      for (let k = y0; k <= y0 + r && k <= y1; k++) {
        const row = k * C;
        for (let x = x0; x <= x1; x++) acc[x] += src[row + x];
      }
      for (let y = y0; y <= y1; y++) {
        const row = y * C;
        for (let x = x0; x <= x1; x++) dst[row + x] = acc[x] * norm;
        if (y + r + 1 <= y1) {
          const add = (y + r + 1) * C;
          for (let x = x0; x <= x1; x++) acc[x] += src[add + x];
        }
        if (y - r >= y0) {
          const rem = (y - r) * C;
          for (let x = x0; x <= x1; x++) acc[x] -= src[rem + x];
        }
      }
    }

    // Точка пересечения порога на ребре клетки; id ребра общий для соседних клеток
    function edgePoint(e, x, y, i, va, vb, vc, vd) {
      const N = cols * rows;
      let id, px, py;
      if (e === 0) {
        id = i;
        px = x + (threshold - va) / (vb - va);
        py = y;
      } else if (e === 1) {
        id = N + i + 1;
        px = x + 1;
        py = y + (threshold - vb) / (vc - vb);
      } else if (e === 2) {
        id = i + cols;
        px = x + (threshold - vd) / (vc - vd);
        py = y + 1;
      } else {
        id = N + i;
        px = x;
        py = y + (threshold - va) / (vd - va);
      }
      ptX[id] = px;
      ptY[id] = py;
      return id;
    }

    const round = (v) => Math.round(v * 10) / 10;

    // Ломаную сглаживаем квадратичными кривыми через середины отрезков
    function loopToPath() {
      const n = loop.length;
      const X = (e) => (ptX[e] - pad) * cell;
      const Y = (e) => (ptY[e] - pad) * cell;
      const last = loop[n - 1];
      const first = loop[0];
      let d =
        "M" +
        round((X(last) + X(first)) / 2) +
        " " +
        round((Y(last) + Y(first)) / 2);
      for (let j = 0; j < n; j++) {
        const e = loop[j];
        const f = loop[(j + 1) % n];
        const cx = X(e);
        const cy = Y(e);
        d +=
          "Q" +
          round(cx) +
          " " +
          round(cy) +
          " " +
          round((cx + X(f)) / 2) +
          " " +
          round((cy + Y(f)) / 2);
      }
      return d + "Z";
    }

    // circles: [{ x, y, radius }] в px относительно hero → строка для атрибута d
    function render(circles) {
      const inv = 1 / cell;

      // Окно сетки, где вообще что-то есть (+ запас под размытие)
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const c of circles) {
        if (c.radius <= 0) continue;
        const cx = c.x * inv + pad;
        const cy = c.y * inv + pad;
        const rr = c.radius * inv + 1;
        if (cx - rr < minX) minX = cx - rr;
        if (cy - rr < minY) minY = cy - rr;
        if (cx + rr > maxX) maxX = cx + rr;
        if (cy + rr > maxY) maxY = cy + rr;
      }
      if (minX === Infinity) return "";
      const wx0 = Math.max(0, Math.floor(minX) - pad);
      const wy0 = Math.max(0, Math.floor(minY) - pad);
      const wx1 = Math.min(cols - 1, Math.ceil(maxX) + pad);
      const wy1 = Math.min(rows - 1, Math.ceil(maxY) + pad);
      if (wx1 - wx0 < 2 || wy1 - wy0 < 2) return "";

      for (let y = wy0; y <= wy1; y++)
        field.fill(0, y * cols + wx0, y * cols + wx1 + 1);

      // 1) Круги на сетку (объединение, как белые круги в маске)
      for (const c of circles) {
        if (c.radius <= 0) continue;
        const cx = c.x * inv + pad;
        const cy = c.y * inv + pad;
        const rr = c.radius * inv;
        const cap = Math.min(1, Math.PI * rr * rr); // крошечные круги не раздуваем
        const x0 = Math.max(wx0, Math.floor(cx - rr - 1));
        const x1 = Math.min(wx1, Math.ceil(cx + rr + 1));
        const y0 = Math.max(wy0, Math.floor(cy - rr - 1));
        const y1 = Math.min(wy1, Math.ceil(cy + rr + 1));
        for (let y = y0; y <= y1; y++) {
          const dy = y - cy;
          const row = y * cols;
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            let v = rr - Math.sqrt(dx * dx + dy * dy) + 0.5;
            if (v <= 0) continue;
            if (v > cap) v = cap;
            if (v > field[row + x]) field[row + x] = v;
          }
        }
      }

      // 2) Размытие (feGaussianBlur)
      for (const r of boxes) {
        blurH(field, tmp, r, wx0, wx1, wy0, wy1);
        blurV(tmp, field, r, wx0, wx1, wy0, wy1);
      }

      // Края окна обнуляем, чтобы все контуры гарантированно замыкались
      for (let x = wx0; x <= wx1; x++) {
        field[wy0 * cols + x] = 0;
        field[wy1 * cols + x] = 0;
      }
      for (let y = wy0; y <= wy1; y++) {
        field[y * cols + wx0] = 0;
        field[y * cols + wx1] = 0;
      }

      // 3) Порог (feColorMatrix) → отрезки контура
      frame++;
      let count = 0;
      for (let y = wy0; y < wy1; y++) {
        for (let x = wx0; x < wx1; x++) {
          const i = y * cols + x;
          const va = field[i];
          const vb = field[i + 1];
          const vc = field[i + cols + 1];
          const vd = field[i + cols];
          const idx =
            (va >= threshold ? 8 : 0) |
            (vb >= threshold ? 4 : 0) |
            (vc >= threshold ? 2 : 0) |
            (vd >= threshold ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const segs =
            (idx === 5 || idx === 10) && (va + vb + vc + vd) * 0.25 >= threshold
              ? SADDLE[idx]
              : SEGS[idx];
          for (let s = 0; s < segs.length; s += 2) {
            const from = edgePoint(segs[s], x, y, i, va, vb, vc, vd);
            const to = edgePoint(segs[s + 1], x, y, i, va, vb, vc, vd);
            next[from] = to;
            stamp[from] = frame;
            starts[count++] = from;
          }
        }
      }

      // 4) Сцепляем отрезки в замкнутые контуры
      let d = "";
      for (let k = 0; k < count; k++) {
        const start = starts[k];
        if (visit[start] === frame) continue;
        loop.length = 0;
        let e = start;
        while (visit[e] !== frame) {
          visit[e] = frame;
          loop.push(e);
          if (stamp[e] !== frame) break;
          e = next[e];
        }
        if (e === start && loop.length >= 3) d += loopToPath();
      }
      return d;
    }

    return { resize, render };
  }
  // #endregion goo-core

  const goo = createGoo({
    blur: config.gooBlur,
    threshold: config.gooThreshold,
    gridCells: config.gridCells,
  });

  function matchSVGToViewport() {
    smudgeSVG.style.width = window.innerWidth + "px";
    smudgeSVG.style.height = window.innerHeight + "px";
  }

  matchSVGToViewport();
  window.addEventListener("resize", matchSVGToViewport);

  new ResizeObserver(() => {
    const rect = hero.getBoundingClientRect();
    goo.resize(rect.width, rect.height);
  }).observe(hero);
  {
    const rect = hero.getBoundingClientRect();
    goo.resize(rect.width, rect.height);
  }

  // ---------- Указатель ----------
  const pointer = { x: 0, y: 0 };
  const smoothPointer = { x: 0, y: 0 };
  let hasStarted = false;

  // Координаты относительно hero — не зависят от прокрутки
  function toLocal(e) {
    const rect = hero.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function jumpTo(x, y) {
    pointer.x = smoothPointer.x = x;
    pointer.y = smoothPointer.y = y;
    hasStarted = true;
  }

  hero.addEventListener("pointermove", (e) => {
    const p = toLocal(e);
    if (!hasStarted) {
      jumpTo(p.x, p.y); // без шлейфа из левого верхнего угла
    } else {
      pointer.x = p.x;
      pointer.y = p.y;
    }
  });

  // Новое касание начинается с места пальца, а не с места прошлого касания
  hero.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const p = toLocal(e);
    jumpTo(p.x, p.y);
  });

  // ---------- Пятна ----------
  // Обычный массив вместо DOM-узла и GSAP-таймлайна на каждый круг
  const blobs = []; // { x, y, r, born, radius }
  const expandEase = gsap.parseEase(config.expandEase);
  const dissolveEase = gsap.parseEase(config.dissolveEase);
  const lifetime = Math.max(
    config.expandTime,
    config.dissolveStart + config.dissolveTime,
  );

  function growAt(r, t) {
    const p = Math.min(t / config.expandTime, 1);
    return r + r * (config.expandMultiplier - 1) * expandEase(p);
  }

  // Та же кривая, что у исходного таймлайна: рост, затем растворение до 0
  function radiusAt(r, age) {
    if (age < config.dissolveStart) return growAt(r, age);
    const p = Math.min((age - config.dissolveStart) / config.dissolveTime, 1);
    return growAt(r, config.dissolveStart) * (1 - dissolveEase(p));
  }

  // ---------- Кадр ----------
  let isEmpty = true;

  function update(time) {
    if (hasStarted) {
      // Сглаживание не зависит от частоты кадров (60 / 120 Гц)
      const t = 1 - Math.pow(1 - config.smoothing, gsap.ticker.deltaRatio(60));
      smoothPointer.x += (pointer.x - smoothPointer.x) * t;
      smoothPointer.y += (pointer.y - smoothPointer.y) * t;

      const speed = Math.hypot(
        pointer.x - smoothPointer.x,
        pointer.y - smoothPointer.y,
      );

      if (speed > config.movementThreshold) {
        blobs.push({
          x: smoothPointer.x,
          y: smoothPointer.y,
          r: speed * config.sizeFromSpeed,
          born: time,
          radius: 0,
        });
      }
    }

    // Пятна живут одинаково долго, поэтому самые старые всегда в начале
    while (blobs.length && time - blobs[0].born >= lifetime) blobs.shift();

    if (!blobs.length) {
      if (!isEmpty) {
        maskPath.setAttribute("d", "");
        isEmpty = true;
      }
      return; // в простое ничего не считаем и не перерисовываем
    }

    for (const b of blobs) b.radius = radiusAt(b.r, time - b.born);
    maskPath.setAttribute("d", goo.render(blobs));
    isEmpty = false;
  }

  // Цикл работает, только пока hero виден на экране
  let running = false;
  function setRunning(on) {
    if (on === running) return;
    running = on;
    if (on) gsap.ticker.add(update);
    else gsap.ticker.remove(update);
  }

  new IntersectionObserver(([entry]) =>
    setRunning(entry.isIntersecting),
  ).observe(hero);
});
