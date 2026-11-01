/* Расчёт зарплаты МВУ. Общий для калькулятора и админки.
   Условия лежат в config.json, DEFAULT_CONFIG — запасной вариант, если файл не загрузился. */
(function (global) {
  'use strict';

  var DEFAULT_CONFIG = {
    version: 1,
    title: 'Мотивация МВУ с 1.08.2026',
    updated: '2026-11-01',
    baseDays: 7,
    days: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
    floor: { rate: 2, from: 10000 },
    tiers: [
      { rate: 3, from: 300000 },
      { rate: 5, from: 430000 },
      { rate: 6, from: 570000 },
      { rate: 7, from: 900000 }
    ],
    minMeetings: 20,
    saleConv: { min: 25, bonus: 12000 },
    subConv: { min: 35, bonus: 4000 },
    meetingRate: 320,
    hardFix: 12000,
    payday: 10,
    okk: { clean: 3500, error: 3500 },
    grades: [
      { prev: 5, coef: 1.15 },
      { prev: 6, coef: 1.3 }
    ]
  };

  var EPS = 1e-9;

  function num(v, d) {
    var n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
    return typeof n === 'number' && isFinite(n) ? n : d;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Приводит любой config к полной и корректной форме. */
  function normalize(raw) {
    var d = DEFAULT_CONFIG, c = raw && typeof raw === 'object' ? raw : {};
    var out = clone(d);
    out.version = num(c.version, d.version);
    out.title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : d.title;
    out.updated = typeof c.updated === 'string' ? c.updated : d.updated;
    out.baseDays = Math.max(1, Math.round(num(c.baseDays, d.baseDays)));
    if (Array.isArray(c.days)) {
      var days = c.days.map(function (x) { return Math.round(num(x, 0)); }).filter(function (x) { return x >= 1 && x <= 31; });
      days = days.filter(function (x, i) { return days.indexOf(x) === i; }).sort(function (a, b) { return b - a; });
      if (days.length) out.days = days;
    }
    if (out.days.indexOf(out.baseDays) < 0) { out.days.push(out.baseDays); out.days.sort(function (a, b) { return b - a; }); }
    if (c.floor) out.floor = { rate: Math.max(0, num(c.floor.rate, d.floor.rate)), from: Math.max(0, num(c.floor.from, d.floor.from)) };
    if (Array.isArray(c.tiers)) {
      out.tiers = c.tiers.map(function (t) { return { rate: Math.max(0, num(t && t.rate, 0)), from: Math.max(0, num(t && t.from, 0)) }; })
        .filter(function (t) { return t.rate > 0 && t.from > 0; })
        .sort(function (a, b) { return a.from - b.from; });
    }
    out.minMeetings = Math.max(0, num(c.minMeetings, d.minMeetings));
    ['saleConv', 'subConv'].forEach(function (k) {
      if (c[k]) out[k] = { min: Math.max(0, num(c[k].min, d[k].min)), bonus: Math.max(0, num(c[k].bonus, d[k].bonus)) };
    });
    out.meetingRate = Math.max(0, num(c.meetingRate, d.meetingRate));
    out.hardFix = Math.max(0, num(c.hardFix, d.hardFix));
    out.payday = Math.min(31, Math.max(1, Math.round(num(c.payday, d.payday))));
    if (c.okk) out.okk = { clean: Math.max(0, num(c.okk.clean, d.okk.clean)), error: Math.max(0, num(c.okk.error, d.okk.error)) };
    if (Array.isArray(c.grades)) {
      out.grades = c.grades.map(function (g) { return { prev: Math.max(0, num(g && g.prev, 0)), coef: num(g && g.coef, 1) }; })
        .filter(function (g) { return g.prev > 0 && g.coef > 1; });
    }
    return out;
  }

  /* Пороги и бонусы для цикла из N дней: значения из config заданы для baseDays и масштабируются, как в таблице мотивации. */
  function scale(cfg, days) {
    var k = days / cfg.baseDays;
    var tiers = [{ rate: 0, from: 0 }];
    if (cfg.floor.rate > 0) tiers.push({ rate: cfg.floor.rate / 100, from: cfg.floor.from, fixed: true });
    cfg.tiers.forEach(function (t) { tiers.push({ rate: t.rate / 100, from: Math.round(t.from * k) }); });
    tiers.sort(function (a, b) { return a.from - b.from || a.rate - b.rate; });
    return {
      k: k,
      tiers: tiers,
      minMeet: Math.round(cfg.minMeetings * k),
      saleBonus: Math.round(cfg.saleConv.bonus * k),
      subBonus: Math.round(cfg.subConv.bonus * k)
    };
  }

  function coefOptions(cfg) { return [1].concat(cfg.grades.map(function (g) { return g.coef; })); }

  function gradeLevel(cfg, coef) {
    var lvl = -1;
    cfg.grades.forEach(function (g, i) { if (coef >= g.coef - EPS) lvl = i; });
    return lvl;
  }

  /* Кэф на следующий цикл: ступень i даётся за процент цикла >= grades[i].prev,
     а со второй ступени ещё и если сейчас уже есть кэф предыдущей ступени. */
  function nextCoef(cfg, ratePct, coef) {
    var cur = gradeLevel(cfg, coef), best = -1;
    cfg.grades.forEach(function (g, i) {
      if (ratePct >= g.prev - EPS && (i === 0 || cur >= i - 1)) best = i;
    });
    return best < 0 ? 1 : cfg.grades[best].coef;
  }

  /* Что нужно, чтобы следующий кэф стал выше. */
  function coefGoal(cfg, sc, revenue, ratePct, coef) {
    var nc = nextCoef(cfg, ratePct, coef), lvl = gradeLevel(cfg, nc), cur = gradeLevel(cfg, coef);
    var g = cfg.grades[lvl + 1];
    if (!g) return null;
    if (lvl + 1 > 0 && cur < lvl) return { coef: g.coef, needNextCycle: true, prev: g.prev };
    var target = sc.tiers.filter(function (t) { return t.rate * 100 >= g.prev - EPS; })[0];
    if (!target) return null;
    return { coef: g.coef, prev: g.prev, need: Math.max(0, target.from - revenue) };
  }

  function int(v) { return Math.max(0, Math.round(num(v, 0))); }

  function compute(cfg, input) {
    var s = {
      days: cfg.days.indexOf(int(input.days)) >= 0 ? int(input.days) : cfg.baseDays,
      own: int(input.own), closers: int(input.closers), meetings: int(input.meetings),
      sales: int(input.sales), subs: int(input.subs), okkClean: int(input.okkClean), okkErr: int(input.okkErr),
      coef: Math.max(1, num(input.coef, 1))
    };
    var sc = scale(cfg, s.days);
    var revenue = s.own + s.closers;
    var ti = 0;
    sc.tiers.forEach(function (t, i) { if (revenue >= t.from) ti = i; });
    var cur = sc.tiers[ti], next = sc.tiers[ti + 1] || null;
    var pct = revenue * cur.rate;
    var coefAdd = pct * (s.coef - 1);
    var cs = s.meetings ? s.sales / s.meetings : 0;
    var cp = s.meetings ? s.subs / s.meetings : 0;
    var meetOK = s.meetings >= sc.minMeet;
    var saleOK = meetOK && cs * 100 >= cfg.saleConv.min - EPS;
    var subOK = meetOK && cp * 100 >= cfg.subConv.min - EPS;
    var okk = s.okkClean * cfg.okk.clean - s.okkErr * cfg.okk.error;
    var bonuses = (saleOK ? sc.saleBonus : 0) + (subOK ? sc.subBonus : 0);
    var weekly = pct + coefAdd + bonuses + okk;
    var soft = s.meetings * cfg.meetingRate;
    var ratePct = cur.rate * 100;
    return {
      input: s, scale: sc, revenue: revenue, ti: ti, cur: cur, next: next, ratePct: ratePct,
      pct: pct, coefAdd: coefAdd, cs: cs, cp: cp, meetOK: meetOK, saleOK: saleOK, subOK: subOK,
      saleBonus: sc.saleBonus, subBonus: sc.subBonus, bonuses: bonuses, okk: okk,
      weekly: weekly, soft: soft, total: weekly + soft,
      toNext: next ? next.from - revenue : 0,
      nextGain: next ? (next.from * next.rate - pct) * s.coef : 0,
      nextCoef: nextCoef(cfg, ratePct, s.coef),
      coefGoal: coefGoal(cfg, sc, revenue, ratePct, s.coef)
    };
  }

  /* Сколько ещё оплат/подач нужно для бонуса при текущем числе встреч. */
  function convNeed(have, minPct, meetings) {
    var req = Math.ceil(minPct / 100 * meetings - EPS);
    return Math.max(0, req - have);
  }

  var nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  function fmt(n) { return nf.format(Math.round(n)).replace('-', '−'); }
  function rub(n) { return fmt(n) + ' ₽'; }
  function pc(x) { var v = Math.round(x * 10) / 10; return String(v).replace('.', ',') + '%'; }
  function kf(c) { return String(Math.round(c * 1000) / 1000).replace('.', ','); }
  function pl(n, f) {
    n = Math.abs(n) % 100; var n1 = n % 10;
    if (n > 10 && n < 20) return f[2]; if (n1 > 1 && n1 < 5) return f[1]; if (n1 === 1) return f[0]; return f[2];
  }
  function dateRu(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
  }

  /* Загружает config.json рядом с сайтом. base — путь до корня сайта ('' или '../'). */
  function loadConfig(base) {
    var url = (base || '') + 'config.json?v=' + Date.now();
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return { cfg: normalize(j), ok: true }; })
      .catch(function () { return { cfg: normalize(DEFAULT_CONFIG), ok: false }; });
  }

  global.MVU = {
    DEFAULT_CONFIG: DEFAULT_CONFIG, normalize: normalize, scale: scale, compute: compute,
    nextCoef: nextCoef, coefOptions: coefOptions, gradeLevel: gradeLevel, convNeed: convNeed,
    loadConfig: loadConfig, fmt: fmt, rub: rub, pc: pc, kf: kf, pl: pl, dateRu: dateRu, num: num
  };
})(typeof window !== 'undefined' ? window : globalThis);
