(function () {
  'use strict';

  var APP_VERSION = 'Ver20260918.001';
  var QUESTION_TIME_LIMIT = 10; // 1問あたりの目安秒数
  var CONFIDENCE_PENALTY_PER_SEC = 5;
  var HISTORY_KEY = 'mbti64_diagnosis_history';
  var ADMIN_KEY = 'mbti64_admin_mode';

  // 回答時間から「信用度・理解度・俯瞰性」を判定する区分表。
  // (下限秒, 上限秒(nullは無制限), 信用度, 理解度, 俯瞰性, 信用度の重み)
  var TIME_INSIGHT_TABLE = [
    [0.0, 1.0, 'すごく低い', '不明', '不明', 0.2],
    [1.0, 3.0, 'やや低い', 'やや高い', '高い', 0.6],
    [3.0, 5.0, 'やや低い', 'ふつう', 'ふつう', 0.6],
    [5.0, 7.0, 'ふつう', 'ふつう', 'ふつう', 1.0],
    [7.0, 9.0, '高い', 'ふつう', 'やや低い', 1.4],
    [9.0, 10.0, '高い', 'やや低い', 'やや低い', 1.4],
    [10.0, null, '高い', '低い', '低い', 1.4],
  ];
  function timeInsightFor(sec) {
    for (var i = 0; i < TIME_INSIGHT_TABLE.length; i++) {
      var row = TIME_INSIGHT_TABLE[i];
      if (sec >= row[0] && (row[1] === null || sec < row[1])) {
        return { credibility: row[2], comprehension: row[3], metaAwareness: row[4], weight: row[5] };
      }
    }
    var last = TIME_INSIGHT_TABLE[TIME_INSIGHT_TABLE.length - 1];
    return { credibility: last[2], comprehension: last[3], metaAwareness: last[4], weight: last[5] };
  }
  function formatTimeJp(seconds) {
    seconds = Math.max(0, seconds);
    var whole = Math.floor(seconds);
    var frac = Math.round((seconds - whole) * 100);
    if (frac >= 100) { whole += 1; frac = 0; }
    return whole + '秒' + String(frac).padStart(2, '0');
  }
  // 重複出題2問の答えのズレ幅(1〜5の差)ごとの、診断結果②での信頼度ペナルティ
  var MISMATCH_PENALTY = { 0: 1.0, 1: 0.8, 2: 0.6, 3: 0.4, 4: 0.2 };

  // ============================================================
  // アクセス制限（配布リンク対策）
  //
  // ・EXPECTED_REFERRER_PREFIX に配布先(noteの記事URLなど)を設定すると、
  //   そのページから遷移してきた場合(document.referrer が一致する場合)
  //   のみアプリが使えるようになる。直接URLを開いた・別サイトから来た
  //   場合は空欄またはURL不一致になり、ブロック画面が表示される。
  // ・空欄のままなら制限なし(誰でも利用可)。配布直前に設定すること。
  // ・管理者モードでは、このチェックを無視してどこからでも起動できる。
  //   画面左上のウォーターマーク文字をクリックすると、合言葉の入力欄が
  //   現れる(見た目のヒントは一切出さない)。
  // ============================================================
    var EXPECTED_REFERRER_PREFIX = 'https://com-nurse-code.github.io/64personalities/test-link.html';
  var ADMIN_BYPASS_WORD = 'ADMINUSER';

  function isAdminMode() {
    try { return localStorage.getItem(ADMIN_KEY) === 'true'; } catch (e) { return false; }
  }
  function setAdminMode(v) {
    try { localStorage.setItem(ADMIN_KEY, v ? 'true' : 'false'); } catch (e) { /* noop */ }
  }
  function checkAccess() {
    if (isAdminMode()) return true;
    if (!EXPECTED_REFERRER_PREFIX) return true;
    var referrer = document.referrer || '';
    return referrer.indexOf(EXPECTED_REFERRER_PREFIX) === 0;
  }

  var root = document.getElementById('app');

  var state = {
    screen: 'menu',
    name: '',
    questions: [],
    currentIndex: 0,
    answers: [],
    times: [],
    totalOvertime: 0,
    questionStartTime: 0,
    timerHandle: null,
    aspirationMode: 'text',
    resultData: null,
  };

  // ---------------- utilities ----------------
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistoryEntry(entry) {
    var hist = loadHistory();
    hist.push(entry);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    } catch (e) { /* ストレージが使えない場合は履歴を保存しない */ }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function formatDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function formatDateJp(d) {
    return d.getFullYear() + '年' + pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日 ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------------- データロジック（questions.py 相当） ----------------
  function sampleTwo(arr) { return shuffle(arr).slice(0, 2); }

  // 全72問(6軸×12問)を返す。各要素は [axis, text, direction]。
  // 軸ごとに「10問の固有問題」+「そのうち2問を再度出題する重複問題」で
  // 12問のまとまりを作る(重複問題は回答の一貫性チェックに使う)。
  function buildQuestions() {
    var questions = [];
    var axes = shuffle(Object.keys(DATA.RAW_QUESTIONS));
    axes.forEach(function (axis) {
      var items = shuffle(DATA.RAW_QUESTIONS[axis]);
      items.forEach(function (it) { questions.push([axis, it[0], it[1]]); });
      sampleTwo(items).forEach(function (it) { questions.push([axis, it[0], it[1]]); });
    });
    return questions;
  }

  function typeDetails(fullType) {
    var parts = fullType.split('-');
    var core = parts[0], variant = parts[1];
    var info = DATA.TYPE_INFO[core] || ['', '該当するタイプ説明が見つかりませんでした。'];
    var baseNickname = info[0], baseDescription = info[1];
    var variantInfo = DATA.IDENTITY_VARIANTS[variant] || { strengths: [], growth: [], tips: [] };
    var profile = (DATA.TYPE_VARIANT_PROFILES[core] || {})[variant];

    var fullNickname = baseNickname;
    var description = baseDescription;
    if (profile) {
      fullNickname = baseNickname + '・' + profile[0];
      description = baseDescription + '\n「' + profile[1] + '」';
    }

    return {
      accent: DATA.TYPE_COLORS[core] || '#3B82F6',
      nickname: fullNickname,
      description: description,
      strengths: (DATA.TYPE_STRENGTHS[core] || []).concat(variantInfo.strengths || []),
      growth: (DATA.TYPE_GROWTH[core] || []).concat(variantInfo.growth || []),
      tips: (DATA.TRAINING_TIPS[core] || []).concat(variantInfo.tips || []),
    };
  }

  function countOccurrences(text, keywords) {
    return keywords.reduce(function (sum, kw) {
      if (!kw) return sum;
      return sum + (text.split(kw).length - 1);
    }, 0);
  }

  function guessTypeFromText(text) {
    var counts = {};
    for (var axis in DATA.ASPIRATION_KEYWORDS) {
      var pair = DATA.ASPIRATION_KEYWORDS[axis];
      counts[axis] = {
        primary: countOccurrences(text, pair[0]),
        opposite: countOccurrences(text, pair[1]),
      };
    }
    var total = 0;
    for (var a in counts) total += counts[a].primary + counts[a].opposite;
    if (total === 0) return [null, counts];

    function lettersFor(axisKeys) {
      return axisKeys.map(function (ax) {
        var c = counts[ax];
        var opposite = DATA.AXIS_PAIRS[ax];
        return c.opposite > c.primary ? opposite : ax;
      }).join('');
    }
    var core = lettersFor(DATA.CORE_AXIS_KEYS);
    var variant = lettersFor(DATA.VARIANT_AXIS_KEYS);
    return [core + '-' + variant, counts];
  }

  function buildQuickAspirationQuestions() {
    var items = [];
    for (var axis in DATA.ASPIRATION_QUICK_QUESTIONS) {
      DATA.ASPIRATION_QUICK_QUESTIONS[axis].forEach(function (pair) {
        items.push([axis, pair[0], pair[1]]);
      });
    }
    return items;
  }

  function typeFromQuickAnswers(answers) {
    var votes = {};
    for (var axis in DATA.AXIS_PAIRS) votes[axis] = { primary: 0, opposite: 0 };
    answers.forEach(function (pair) {
      var axis = pair[0], chosen = pair[1];
      if (chosen === axis) votes[axis].primary += 1;
      else votes[axis].opposite += 1;
    });
    function lettersFor(axisKeys) {
      return axisKeys.map(function (ax) {
        var v = votes[ax];
        var opposite = DATA.AXIS_PAIRS[ax];
        return v.opposite > v.primary ? opposite : ax;
      }).join('');
    }
    var core = lettersFor(DATA.CORE_AXIS_KEYS);
    var variant = lettersFor(DATA.VARIANT_AXIS_KEYS);
    return core + '-' + variant;
  }

  function compatibilityInfo(a, b) {
    var match = 0;
    for (var i = 0; i < 4; i++) if (a[i] === b[i]) match++;
    var displayValue = match + 1;
    var lv = DATA.COMPATIBILITY_LEVELS[String(displayValue)];
    return [displayValue, lv[0], lv[1]];
  }

  // ---------------- ナビゲーション ----------------
  function clearQuestionTimer() {
    if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
  }

  function navigateTo(screen) {
    clearQuestionTimer();
    state.screen = screen;
    render();
  }

  function headerStrip() {
    return '<div class="header-strip"><span></span><span></span><span></span><span></span></div>';
  }

  function backButton() {
    return '<button class="back-btn" data-nav="menu">☰ メニューに戻る</button>';
  }

  function bindNavButtons() {
    root.querySelectorAll('[data-nav]').forEach(function (el) {
      el.addEventListener('click', function () { navigateTo(el.dataset.nav); });
    });
  }

  // ---------------- アクセス表示・管理者モードの隠し入口（共通パーツ） ----------------
  function renderAccessIndicator() {
    var referrer = document.referrer || '';
    var watermarkText = isAdminMode() ? '👑 管理者モード' : '🌐 Web版';
    var logoutHtml = isAdminMode()
      ? ' <button class="admin-logout-btn" id="admin-logout-btn" type="button">（解除）</button>' : '';
    return (
      '<div class="access-row">' +
      '<span class="watermark" id="watermark-label">' + watermarkText + '</span>' + logoutHtml +
      '<span class="access-url-label">直前のURL</span>' +
      '<input type="text" class="access-url-field" id="referrer-field" value="' +
      escapeHtml(referrer) + '" readonly placeholder="（直接アクセス）">' +
      '</div>' +
      '<div class="hidden-admin-box" id="hidden-admin-box" hidden>' +
      '<input type="password" class="admin-word-input" id="admin-word-input" placeholder="合言葉">' +
      '<button class="admin-auth-btn" id="admin-auth-btn" type="button">認証する</button>' +
      '<span class="admin-error" id="admin-error"></span>' +
      '</div>' +
      '<p class="access-note">' +
      '※ このアプリは、指定されたリンクを経由してアクセスした場合（「直前のURL」が' +
      'このアプリの設定URLと一致する場合）のみ開始できます。<br>' +
      '※ ご利用のパソコン・スマートフォンやブラウザの設定によっては、リンク元の情報' +
      '（リファラー）が正しく送信されず、正規のリンクからアクセスしてもご利用いただけない' +
      '場合があります。あらかじめご了承ください。' +
      '</p>'
    );
  }

  function bindAccessIndicator() {
    var watermark = document.getElementById('watermark-label');
    var hiddenBox = document.getElementById('hidden-admin-box');
    if (watermark && hiddenBox) {
      watermark.addEventListener('click', function () {
        if (!hiddenBox.hidden) return;
        hiddenBox.hidden = false;
        var input = document.getElementById('admin-word-input');
        if (input) input.focus();
      });
    }
    var authBtn = document.getElementById('admin-auth-btn');
    var wordInput = document.getElementById('admin-word-input');
    if (authBtn && wordInput) {
      var tryAuth = function () {
        var errorEl = document.getElementById('admin-error');
        if (wordInput.value.trim() === ADMIN_BYPASS_WORD) {
          setAdminMode(true);
          navigateTo('menu');
        } else {
          if (errorEl) errorEl.textContent = '合言葉が違います。';
          wordInput.value = '';
        }
      };
      authBtn.addEventListener('click', tryAuth);
      wordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryAuth(); });
    }
    var logoutBtn = document.getElementById('admin-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        setAdminMode(false);
        navigateTo(checkAccess() ? 'menu' : 'blocked');
      });
    }
  }

  // ---------------- ブロック画面（指定リンク以外からのアクセス） ----------------
  function renderBlocked() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px;color:#DC2626">🔒 このページは現在ご利用いただけません</h2>' +
      '<p class="sub-text">指定されたリンクを経由してアクセスした場合のみご利用いただけます。<br>' +
      'URLを直接開いた場合や、別のページから来られた場合はご利用いただけません。<br>' +
      '正規のリンクからもう一度お試しください。</p>' +
      renderAccessIndicator() +
      '</div>';
    bindAccessIndicator();
  }

  // ---------------- ① メインメニュー ----------------
  function renderMenu() {
    var menuItems = [
      ['①  📝  診断する（72問）', '#3B82F6', function () { state.name = ''; navigateTo('nameEntry'); } ],
      ['②  📜  診断履歴を見る', '#D97706', function () { navigateTo('history'); } ],
      ['③  💭  なりたい自分から診断する', '#EC4899', function () { state.aspirationMode = 'text'; navigateTo('aspiration'); } ],
      ['④  🧭  お悩みから目指すタイプを見る', '#7C3AED', function () { navigateTo('concern'); } ],
      ['⑤  📚  64タイプの特徴を見る', '#059669', function () { navigateTo('library'); } ],
      ['⑥  🤝  タイプ別相性表を見る', '#0891B2', function () { navigateTo('compatibility'); } ],
    ];

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<div class="title-row"><div class="app-title">🧭 64タイプ性格診断</div>' +
      '<div class="app-version">' + APP_VERSION + '</div></div>' +
      renderAccessIndicator() +
      '<div class="menu-grid" style="margin-top:16px">' +
      menuItems.map(function (item, i) {
        return '<button class="menu-btn" data-menu-idx="' + i + '" style="color:' + item[1] + '">' +
          escapeHtml(item[0]) + '</button>';
      }).join('') +
      '</div></div>';

    root.querySelectorAll('[data-menu-idx]').forEach(function (btn) {
      btn.addEventListener('click', function () { menuItems[Number(btn.dataset.menuIdx)][2](); });
    });
    bindAccessIndicator();
  }

  // ---------------- 名前入力 ----------------
  function renderNameEntry() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:22px">📝 診断を始める</h2>' +
      '<p class="sub-text">お名前を入力してください。診断履歴に記録されます<br>（空欄のまま始めることもできます）。</p>' +
      '<input type="text" class="name-input" id="name-input" value="' + escapeHtml(state.name) + '" placeholder="お名前">' +
      '<button class="primary-btn" id="start-btn">ここをクリックして始める</button>' +
      backButton() +
      '</div>';

    var input = document.getElementById('name-input');
    input.focus();
    input.select();

    function start() {
      state.name = input.value.trim() || '名無しさん';
      state.questions = buildQuestions();
      state.currentIndex = 0;
      state.answers = new Array(state.questions.length).fill(null);
      state.times = new Array(state.questions.length).fill(null);
      state.totalOvertime = 0;
      navigateTo('question');
    }
    document.getElementById('start-btn').addEventListener('click', start);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
    bindNavButtons();
  }

  // ---------------- ① 診断（64問・1問ずつ・15秒カウント付き） ----------------
  function renderQuestion() {
    clearQuestionTimer();
    var index = state.currentIndex;
    var total = state.questions.length;
    var q = state.questions[index];
    var text = q[1];

    var scaleItems = shuffle([1, 2, 3, 4, 5].map(function (v) { return [v, DATA.SCALE_COLORS[v - 1]]; }));

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<div class="q-top-row"><span>Q' + (index + 1) + ' / ' + total + '</span>' +
      '<span id="timer-label" style="color:#16A34A">⏱ ' + QUESTION_TIME_LIMIT + '</span></div>' +
      '<div class="q-progress-bg"><div class="q-progress-fill" style="width:' + (index / total * 100).toFixed(2) + '%"></div></div>' +
      '<div class="q-text">' + escapeHtml(text) + '</div>' +
      '<div class="q-scale">' +
      scaleItems.map(function (item) {
        return '<button class="scale-btn" data-val="' + item[0] + '" style="background:' + item[1] + '">' +
          escapeHtml(DATA.SCALE_LABELS[item[0]]) + '</button>';
      }).join('') +
      '</div>' +
      backButton() +
      '</div>';

    state.questionStartTime = Date.now();

    root.querySelectorAll('.scale-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { choose(Number(btn.dataset.val)); });
    });

    function choose(val) {
      var elapsed = (Date.now() - state.questionStartTime) / 1000;
      var overtime = Math.max(0, elapsed - QUESTION_TIME_LIMIT);
      state.totalOvertime += overtime;
      state.answers[index] = val;
      state.times[index] = elapsed;
      clearQuestionTimer();
      if (index + 1 < total) {
        state.currentIndex = index + 1;
        render();
      } else {
        finishQuestions();
      }
    }

    var timerLabel = document.getElementById('timer-label');
    function tick() {
      var elapsed = (Date.now() - state.questionStartTime) / 1000;
      var remaining = QUESTION_TIME_LIMIT - Math.floor(elapsed);
      if (remaining >= 0) {
        timerLabel.textContent = '⏱ ' + remaining;
        timerLabel.style.color = remaining > 5 ? '#16A34A' : '#CA8A04';
      } else {
        var over = Math.floor(elapsed) - QUESTION_TIME_LIMIT;
        timerLabel.textContent = '⏱ +' + over + '秒';
        timerLabel.style.color = '#DC2626';
      }
    }
    tick();
    state.timerHandle = setInterval(tick, 1000);

    bindNavButtons();
  }

  function finishQuestions() {
    // ---- 診断結果①: 素点集計(逆転項目は6-値に反転してから加算) ----
    var scores = {}, axisQuestionCounts = {};
    for (var axis in DATA.AXIS_PAIRS) { scores[axis] = 0; axisQuestionCounts[axis] = 0; }
    state.questions.forEach(function (q, i) {
      var val = state.answers[i];
      var direction = q[2];
      scores[q[0]] += (direction === 1) ? val : (6 - val);
      axisQuestionCounts[q[0]] += 1;
    });

    var axisPercentages = [];
    var chosenLetters = {};
    for (var primary in DATA.AXIS_PAIRS) {
      var opposite = DATA.AXIS_PAIRS[primary];
      var n = axisQuestionCounts[primary];
      var total = scores[primary];
      var pctPrimary = (total - n) / (n * 5 - n) * 100;
      pctPrimary = Math.max(0, Math.min(100, pctPrimary));
      chosenLetters[primary] = pctPrimary >= 50 ? primary : opposite;
      axisPercentages.push([primary, opposite, pctPrimary]);
    }

    var core = DATA.CORE_AXIS_KEYS.map(function (a) { return chosenLetters[a]; }).join('');
    var variant = DATA.VARIANT_AXIS_KEYS.map(function (a) { return chosenLetters[a]; }).join('');
    var mbtiType = core + '-' + variant;

    // ---- 回答時間の解析(信用度・理解度・俯瞰性) ----
    var insights = state.times.map(function (t) { return timeInsightFor(t); });
    var avgTime = state.times.length ? state.times.reduce(function (s, t) { return s + t; }, 0) / state.times.length : 0;
    var avgTimeInsight = timeInsightFor(avgTime);

    // ---- 重複問題(ブレ検知)の突き合わせ ----
    var seenFirst = {};
    var consistencyMultiplier = new Array(state.questions.length).fill(1.0);
    var pairCount = 0, matchCount = 0;
    state.questions.forEach(function (q, i) {
      var key = q[0] + '||' + q[1];
      if (seenFirst.hasOwnProperty(key)) {
        var firstI = seenFirst[key];
        var mismatch = Math.abs(state.answers[firstI] - state.answers[i]);
        pairCount++;
        if (mismatch === 0) matchCount++;
        var penalty = MISMATCH_PENALTY.hasOwnProperty(mismatch) ? MISMATCH_PENALTY[mismatch] : 0.2;
        consistencyMultiplier[firstI] = penalty;
        consistencyMultiplier[i] = penalty;
      } else {
        seenFirst[key] = i;
      }
    });
    var consistency = pairCount ? Math.round(matchCount / pairCount * 100) : null;

    // ---- 診断結果②: 回答時間(信用度)× 答えのブレ具合で重み付けした集計 ----
    var weightedScores = {}, weightedTotals = {};
    for (var a2 in DATA.AXIS_PAIRS) { weightedScores[a2] = 0; weightedTotals[a2] = 0; }
    state.questions.forEach(function (q, i) {
      var weight = insights[i].weight * consistencyMultiplier[i];
      var effective = (q[2] === 1) ? state.answers[i] : (6 - state.answers[i]);
      weightedScores[q[0]] += effective * weight;
      weightedTotals[q[0]] += weight;
    });
    var axisPercentagesWeighted = [];
    var chosenLettersWeighted = {};
    for (var primaryW in DATA.AXIS_PAIRS) {
      var oppositeW = DATA.AXIS_PAIRS[primaryW];
      var totalWeight = weightedTotals[primaryW];
      var pctW;
      if (totalWeight > 0) {
        var weightedAvg = weightedScores[primaryW] / totalWeight;
        pctW = (weightedAvg - 1) / 4 * 100;
      } else { pctW = 50; }
      pctW = Math.max(0, Math.min(100, pctW));
      chosenLettersWeighted[primaryW] = pctW >= 50 ? primaryW : oppositeW;
      axisPercentagesWeighted.push([primaryW, oppositeW, pctW]);
    }
    var coreW = DATA.CORE_AXIS_KEYS.map(function (a) { return chosenLettersWeighted[a]; }).join('');
    var variantW = DATA.VARIANT_AXIS_KEYS.map(function (a) { return chosenLettersWeighted[a]; }).join('');
    var mbtiTypeWeighted = coreW + '-' + variantW;

    var avgOvertime = state.questions.length ? state.totalOvertime / state.questions.length : 0;
    var confidence = Math.max(0, Math.min(100, Math.round(100 - avgOvertime * CONFIDENCE_PENALTY_PER_SEC)));

    var now = new Date();
    saveHistoryEntry({
      date: formatDate(now),
      name: state.name || '名無しさん',
      type: mbtiType,
      typeWeighted: mbtiTypeWeighted,
      percentages: axisPercentages.reduce(function (acc, item) {
        acc[item[0]] = Math.round(item[2] * 10) / 10; return acc;
      }, {}),
      confidence: confidence,
      consistency: consistency,
    });

    state.resultData = {
      mbtiType: mbtiType, axisPercentages: axisPercentages, dateText: formatDateJp(now),
      confidence: confidence, consistency: consistency,
      mbtiTypeWeighted: mbtiTypeWeighted, axisPercentagesWeighted: axisPercentagesWeighted,
      avgTime: avgTime, avgTimeInsight: avgTimeInsight,
    };
    navigateTo('result');
  }

  // ---------------- 結果画面 ----------------
  function renderStrengthsGrowthBlock(strengths, growth) {
    if (!strengths.length && !growth.length) return '';
    var html = '';
    if (strengths.length) {
      html += '<div class="strengths-title" style="color:#16A34A">💪 強み</div><ul class="trait-list">' +
        strengths.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ul>';
    }
    if (growth.length) {
      html += '<div class="strengths-title" style="color:#CA8A04">🌱 伸びしろ</div><ul class="trait-list">' +
        growth.map(function (g) { return '<li>' + escapeHtml(g) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function axisCardHtml(item) {
    var primary = item[0], opposite = item[1], pctPrimary = item[2];
    var pctOpposite = 100 - pctPrimary;
    var color = DATA.AXIS_COLORS[primary];
    var labels = DATA.AXIS_LABELS[primary];
    return '<div class="axis-card"><div class="axis-label-row">' +
      '<span style="color:' + color + '">' + escapeHtml(labels[0]) + '  ' + pctPrimary.toFixed(0) + '%</span>' +
      '<span style="color:var(--text-sub)">' + pctOpposite.toFixed(0) + '%  ' + escapeHtml(labels[1]) + '</span>' +
      '</div><div class="axis-bar-bg"><div class="axis-bar-fill" style="width:' +
      Math.max(1, pctPrimary) + '%;background:' + color + '"></div></div></div>';
  }

  function renderWeightedResultBlock(r) {
    if (!r.mbtiTypeWeighted) return '';
    var dw = typeDetails(r.mbtiTypeWeighted);
    var timeHtml = '';
    if (r.avgTime !== null && r.avgTimeInsight) {
      timeHtml =
        '<div style="font-size:13px;font-weight:700;margin:0 0 4px">⏱ 平均回答時間: ' + escapeHtml(formatTimeJp(r.avgTime)) + '</div>' +
        '<div style="font-size:12px;color:var(--text-sub);margin:0 0 16px">信用度: ' + escapeHtml(r.avgTimeInsight.credibility) +
        '　理解度: ' + escapeHtml(r.avgTimeInsight.comprehension) + '　俯瞰性: ' + escapeHtml(r.avgTimeInsight.metaAwareness) + '</div>';
    }
    return '<div style="border-top:1px solid var(--btn-off);margin-top:24px;padding-top:20px">' +
      '<h3 class="section-title" style="font-size:15px;color:var(--purple)">🔎 もう一つの診断結果（回答時間・回答のブレを考慮）</h3>' +
      '<p class="sub-text">即答しすぎた設問・長考しすぎた設問や、重複出題で答えがブレた設問の影響を弱めて再集計した、もう一つの診断結果です。①の結果と近いほど、ふだんの自分をよく分かっている（俯瞰できている）と言えます。</p>' +
      '<div class="type-badge-outer" style="background:' + dw.accent + ';padding:2px">' +
      '<div class="type-badge" style="color:' + dw.accent + ';font-size:20px;padding:6px 16px">' + r.mbtiTypeWeighted + '</div></div>' +
      '<div class="result-nickname" style="font-size:14px">✨ ' + escapeHtml(dw.nickname) + '</div>' +
      timeHtml +
      r.axisPercentagesWeighted.map(axisCardHtml).join('') +
      '</div>';
  }

  function renderResult() {
    var r = state.resultData;
    var details = typeDetails(r.mbtiType);
    var confColor = r.confidence >= 80 ? '#16A34A' : r.confidence >= 50 ? '#CA8A04' : '#DC2626';
    var consHtml = '';
    if (r.consistency !== null && r.consistency !== undefined) {
      var consColor = r.consistency >= 80 ? '#16A34A' : r.consistency >= 50 ? '#CA8A04' : '#DC2626';
      consHtml =
        '<div class="confidence-line" style="color:' + consColor + '">🔁 回答の一貫性: ' + r.consistency + '%</div>' +
        '<div class="confidence-note">一部の設問は、回答のブレを見るために2回出題されています。同じ回答ほど高くなります。</div>';
    }

    var axisHtml = r.axisPercentages.map(axisCardHtml).join('');

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<div class="result-top-row"><span>診断結果</span><span>診断日: ' + escapeHtml(r.dateText) + '</span></div>' +
      '<div class="type-badge-outer" style="background:' + details.accent + '">' +
      '<div class="type-badge" style="color:' + details.accent + '">' + r.mbtiType + '</div></div>' +
      '<div class="result-nickname">✨ ' + escapeHtml(details.nickname) + '</div>' +
      '<div class="result-desc">' + escapeHtml(details.description) + '</div>' +
      '<div class="confidence-line" style="color:' + confColor + '">🎯 診断の信頼度: ' + r.confidence + '%</div>' +
      '<div class="confidence-note">各設問の目安は' + QUESTION_TIME_LIMIT + '秒です。考える時間が長いほど信頼度が下がります。</div>' +
      consHtml +
      '<h3 class="section-title" style="font-size:15px">各軸の傾向</h3>' +
      axisHtml +
      renderStrengthsGrowthBlock(details.strengths, details.growth) +
      renderWeightedResultBlock(r) +
      '<button class="primary-btn" id="retry-btn" style="background:var(--btn-off);color:var(--text-main)">🔄 もう一度診断する</button>' +
      backButton() +
      '</div>';

    document.getElementById('retry-btn').addEventListener('click', function () { state.name = ''; navigateTo('nameEntry'); });
    bindNavButtons();
  }

  // ---------------- ⑤ 64タイプの特徴を見る ----------------
  function renderLibrary() {
    var axisDescHtml = '';
    for (var axisKey in DATA.AXIS_PAIR_NAMES) {
      var labels = DATA.AXIS_LABELS[axisKey];
      var descs = DATA.AXIS_DESCRIPTIONS[axisKey];
      axisDescHtml += '<div class="axis-desc-card">' +
        '<div class="axis-desc-name" style="color:' + DATA.AXIS_COLORS[axisKey] + '">' +
        escapeHtml(DATA.AXIS_PAIR_NAMES[axisKey]) + '</div>' +
        '<div class="axis-desc-pole">' + escapeHtml(labels[0]) + '</div>' +
        '<div class="axis-desc-text">' + escapeHtml(descs[0]) + '</div>' +
        '<div class="axis-desc-pole">' + escapeHtml(labels[1]) + '</div>' +
        '<div class="axis-desc-text">' + escapeHtml(descs[1]) + '</div>' +
        '</div>';
    }

    var baseTypesHtml = '';
    var groupNames = Object.keys(DATA.TYPE_GROUPS);
    groupNames.forEach(function (group) {
      DATA.TYPE_GROUPS[group].forEach(function (core) {
        var info = DATA.TYPE_INFO[core];
        baseTypesHtml += '<div class="card">' +
          '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">' +
          '<span class="type-code-link" style="color:' + DATA.GROUP_COLORS[group] + ';font-size:16px">' + core + '</span>' +
          '<span style="font-weight:700;font-size:14px">' + escapeHtml(info[0]) + '</span></div>' +
          '<div style="font-size:12px;color:var(--text-sub);line-height:1.7">' + escapeHtml(info[1]) + '</div>' +
          '</div>';
      });
    });

    var variantTableHtml = '';
    groupNames.forEach(function (group) {
      var color = DATA.GROUP_COLORS[group];
      variantTableHtml += '<div class="group-heading" style="color:' + color + '">' + escapeHtml(group) + '</div>';
      DATA.TYPE_GROUPS[group].forEach(function (core) {
        var baseNickname = DATA.TYPE_INFO[core][0];
        var variants = DATA.TYPE_VARIANT_PROFILES[core] || {};
        var rows = '';
        for (var vcode in variants) {
          var v = variants[vcode];
          rows += '<div class="variant-row">' +
            '<span class="type-code-link" style="color:' + color + '">' + core + '-' + vcode + '</span>' +
            '<span style="font-weight:700;margin-left:6px">' + escapeHtml(v[0]) + '</span>' +
            '<div class="variant-quote">「' + escapeHtml(v[1]) + '」</div></div>';
        }
        variantTableHtml += '<div class="card">' +
          '<div style="font-weight:700;color:' + color + ';margin-bottom:6px">' + core + '　' + escapeHtml(baseNickname) + '</div>' +
          rows + '</div>';
      });
    });

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">📚 64タイプの特徴</h2>' +
      '<p class="sub-text">基本タイプ（16種類）× 傾向（4種類）の組み合わせで、「INTJ-AC」のように合計64タイプになります。</p>' +
      '<h3 class="section-title">文字の意味 一覧表</h3>' +
      axisDescHtml +
      '<h3 class="section-title" style="margin-top:20px">基本タイプ（16種類）</h3>' +
      baseTypesHtml +
      '<h3 class="section-title" style="margin-top:20px">タイプ別一覧表（64タイプ）</h3>' +
      variantTableHtml +
      backButton() +
      '</div>';

    bindNavButtons();
  }

  // ---------------- ② 診断履歴を見る ----------------
  function renderHistory() {
    var history = loadHistory();
    var bodyHtml;
    if (!history.length) {
      bodyHtml = '<p class="sub-text">まだ診断履歴がありません。「診断する」から最初の診断をしてみましょう。</p>';
    } else {
      bodyHtml = history.slice().reverse().map(function (entry) {
        var mbtiType = entry.type || '----';
        var details = typeDetails(mbtiType);
        var name = entry.name || '名無しさん';
        return '<div class="history-row"><div class="history-top">' +
          '<span class="history-name">' + escapeHtml(name) + '</span>' +
          '<span class="history-result"><span class="type-code-link" style="color:' + details.accent + '">' +
          mbtiType + '</span> ' + escapeHtml(details.nickname) + '</span></div>' +
          '<div class="history-date">' + escapeHtml(entry.date || '') + '</div></div>';
      }).join('');
    }

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">📜 診断履歴</h2>' +
      '<div style="margin:12px 0"></div>' +
      bodyHtml +
      backButton() +
      '</div>';

    bindNavButtons();
  }

  // ---------------- ③ なりたい自分から診断する ----------------
  function renderAspirationResultHtml(mbtiType, labelText) {
    var details = typeDetails(mbtiType);
    return '<div class="card" style="margin-top:16px">' +
      '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<span style="font-size:11px;color:var(--text-sub)">' + labelText + '</span>' +
      '<span class="type-code-link" style="color:' + details.accent + ';font-size:16px">' + mbtiType + '</span>' +
      '<span style="font-weight:700;font-size:16px">' + escapeHtml(details.nickname) + '</span></div>' +
      '<div style="font-size:12px;color:var(--text-sub);line-height:1.7;margin-bottom:10px;white-space:pre-line">' +
      escapeHtml(details.description) + '</div>' +
      (details.tips.length ?
        '<div class="strengths-title" style="color:#16A34A">🏋 近づくためのトレーニング</div><ul class="trait-list">' +
        details.tips.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>' : '') +
      '</div>';
  }

  function renderAspirationText(container) {
    container.innerHTML =
      '<p class="sub-text">「どんな自分になりたいか」を自由に書いてください。内容から近いタイプを推測し、そのタイプに近づくためのヒントを表示します。</p>' +
      '<textarea class="free-text" id="aspiration-text" placeholder="例: もっと人前で堂々と話せるようになりたい"></textarea>' +
      '<div id="aspiration-result"></div>' +
      '<button class="primary-btn" id="aspiration-check-btn">判定する</button>';

    document.getElementById('aspiration-check-btn').addEventListener('click', function () {
      var text = document.getElementById('aspiration-text').value.trim();
      var resultEl = document.getElementById('aspiration-result');
      if (!text) { alert('なりたい自分について、少し書いてみてください。'); return; }
      var res = guessTypeFromText(text);
      var mbtiType = res[0];
      if (!mbtiType) {
        resultEl.innerHTML = '<p style="color:#DC2626;font-size:12px;margin-top:8px">うまく判定できませんでした。もう少し具体的に書いてみてください。<br>（例: 「もっと人前で堂々と話せるようになりたい」など）</p>';
        return;
      }
      resultEl.innerHTML = renderAspirationResultHtml(mbtiType, '近いタイプ:');
    });
  }

  function renderAspirationQuick(container) {
    var quickQuestions = buildQuickAspirationQuestions();
    container.innerHTML =
      '<p class="sub-text">文章にしづらい人向けの、18個の簡単な質問です。なりたい自分に近い方をそれぞれ選んでください。</p>' +
      '<div id="quick-questions">' +
      quickQuestions.map(function (q, i) {
        var axis = q[0], primaryChoice = q[1], oppositeChoice = q[2];
        return '<div class="quick-q-card"><div class="quick-q-label">Q' + (i + 1) + '</div>' +
          '<button class="quick-choice" data-q="' + i + '" data-val="' + axis + '">' + escapeHtml(primaryChoice) + '</button>' +
          '<button class="quick-choice" data-q="' + i + '" data-val="' + DATA.AXIS_PAIRS[axis] + '">' + escapeHtml(oppositeChoice) + '</button>' +
          '</div>';
      }).join('') +
      '</div>' +
      '<div id="aspiration-result"></div>' +
      '<button class="primary-btn" id="quick-check-btn">診断する</button>';

    var answers = new Array(quickQuestions.length).fill(null);
    container.querySelectorAll('.quick-choice').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var qIdx = Number(btn.dataset.q);
        answers[qIdx] = [quickQuestions[qIdx][0], btn.dataset.val];
        container.querySelectorAll('.quick-choice[data-q="' + qIdx + '"]').forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
      });
    });

    document.getElementById('quick-check-btn').addEventListener('click', function () {
      if (answers.some(function (a) { return a === null; })) { alert('すべての質問に答えてください。'); return; }
      var mbtiType = typeFromQuickAnswers(answers);
      document.getElementById('aspiration-result').innerHTML = renderAspirationResultHtml(mbtiType, '近いタイプ:');
    });
  }

  function renderAspiration() {
    var mode = state.aspirationMode || 'text';
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:18px">💭 なりたい自分から診断する</h2>' +
      '<div class="mode-toggle">' +
      '<button data-mode="text" class="' + (mode === 'text' ? 'active' : '') + '">文章で入力する</button>' +
      '<button data-mode="quick" class="' + (mode === 'quick' ? 'active' : '') + '">質問に答える（18問）</button>' +
      '</div><div id="aspiration-body"></div>' +
      backButton() +
      '</div>';

    root.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () { state.aspirationMode = btn.dataset.mode; render(); });
    });

    var bodyEl = document.getElementById('aspiration-body');
    if (mode === 'quick') renderAspirationQuick(bodyEl); else renderAspirationText(bodyEl);
    bindNavButtons();
  }

  // ---------------- ④ お悩みから目指すタイプを見る ----------------
  function renderConcern() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:18px">🧭 お悩みから目指すタイプを見る</h2>' +
      '<p class="sub-text">今困っていること・悩んでいることを自由に書いてください。外向・内向、直観、協調型など12の観点から分析し、目指すとよいタイプの方向性を簡易的に示します。</p>' +
      '<textarea class="free-text" id="concern-text" placeholder="例: 人前で意見を言うのが苦手で悩んでいる"></textarea>' +
      '<div id="concern-result"></div>' +
      '<button class="primary-btn" id="concern-check-btn">診断する</button>' +
      backButton() +
      '</div>';

    document.getElementById('concern-check-btn').addEventListener('click', function () {
      var text = document.getElementById('concern-text').value.trim();
      var resultEl = document.getElementById('concern-result');
      if (!text) { alert('今困っていることについて、少し書いてみてください。'); return; }
      var res = guessTypeFromText(text);
      var mbtiType = res[0], counts = res[1];
      if (!mbtiType) {
        resultEl.innerHTML = '<p style="color:#DC2626;font-size:12px;margin-top:8px">うまく判定できませんでした。もう少し具体的に書いてみてください。<br>（例: 「人前で意見を言うのが苦手で悩んでいる」など）</p>';
        return;
      }
      var details = typeDetails(mbtiType);
      var perspectiveHtml = '';
      for (var axis in DATA.AXIS_PAIR_NAMES) {
        var labels = DATA.AXIS_LABELS[axis];
        var c = counts[axis];
        var primaryWins = c.primary >= c.opposite;
        perspectiveHtml += '<div class="perspective-row">' +
          '<span class="perspective-axis">' + escapeHtml(DATA.AXIS_PAIR_NAMES[axis]) + '</span>' +
          '<span class="' + (primaryWins ? 'perspective-win' : 'perspective-lose') + '">' + escapeHtml(labels[0]) + '</span>' +
          '<span class="perspective-lose"> / </span>' +
          '<span class="' + (!primaryWins ? 'perspective-win' : 'perspective-lose') + '">' + escapeHtml(labels[1]) + '</span>' +
          '</div>';
      }
      resultEl.innerHTML = '<div class="card" style="margin-top:16px">' +
        '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
        '<span style="font-size:11px;color:var(--text-sub)">目指すとよいタイプ:</span>' +
        '<span class="type-code-link" style="color:' + details.accent + ';font-size:16px">' + mbtiType + '</span>' +
        '<span style="font-weight:700;font-size:16px">' + escapeHtml(details.nickname) + '</span></div>' +
        '<div style="font-size:12px;color:var(--text-sub);line-height:1.7;margin-bottom:10px;white-space:pre-line">' +
        escapeHtml(details.description) + '</div>' +
        '<div class="perspective-title">🔍 12の観点からの分析</div>' + perspectiveHtml +
        (details.tips.length ?
          '<div class="strengths-title" style="color:#16A34A">🏋 近づくためのトレーニング</div><ul class="trait-list">' +
          details.tips.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>';
    });

    bindNavButtons();
  }

  // ---------------- ⑥ タイプ別相性表を見る ----------------
  function renderCompatibility() {
    var baseTypes = [];
    for (var g in DATA.TYPE_GROUPS) baseTypes = baseTypes.concat(DATA.TYPE_GROUPS[g]);

    var legendHtml = [5, 4, 3, 2, 1].map(function (m) {
      var lv = DATA.COMPATIBILITY_LEVELS[String(m)];
      return '<div class="legend-chip" style="background:' + lv[1] + '">' + m + ' ' + escapeHtml(lv[0]) + '</div>';
    }).join('');

    var headerRow = '<th></th>' + baseTypes.map(function (t) {
      return '<th style="color:' + DATA.TYPE_COLORS[t] + '">' + t + '</th>';
    }).join('');

    var bodyRows = baseTypes.map(function (rowType) {
      var cells = '<th style="text-align:right;color:' + DATA.TYPE_COLORS[rowType] + '">' + rowType + '</th>';
      cells += baseTypes.map(function (colType) {
        var info = compatibilityInfo(rowType, colType);
        return '<td style="background:' + info[2] + '">' + info[0] + '</td>';
      }).join('');
      return '<tr>' + cells + '</tr>';
    }).join('');

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">🤝 タイプ別相性表</h2>' +
      '<p class="sub-text">基本タイプ（16種類）同士の相性を、4つの軸のうち一致する文字数から簡易的に示した表です。あくまで簡易的な目安としてご覧ください。</p>' +
      '<div class="legend-chips">' + legendHtml + '</div>' +
      '<div class="compat-table-wrap"><table class="compat-table"><thead><tr>' + headerRow +
      '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>' +
      '<p class="sub-text">※ 縦・横それぞれの基本タイプの組み合わせを表しています。数字が大きいほど一致する文字が多く、価値観や物事の進め方が近い傾向にあります。数字が小さい組み合わせは考え方が対照的で、刺激的な反面、理解に工夫が必要な場合があります。</p>' +
      backButton() +
      '</div>';

    bindNavButtons();
  }

  // ---------------- ルーター ----------------
  function render() {
    switch (state.screen) {
      case 'blocked': renderBlocked(); break;
      case 'menu': renderMenu(); break;
      case 'nameEntry': renderNameEntry(); break;
      case 'question': renderQuestion(); break;
      case 'result': renderResult(); break;
      case 'library': renderLibrary(); break;
      case 'history': renderHistory(); break;
      case 'aspiration': renderAspiration(); break;
      case 'concern': renderConcern(); break;
      case 'compatibility': renderCompatibility(); break;
      default: renderMenu();
    }
  }

  state.screen = checkAccess() ? 'menu' : 'blocked';
  render();
})();
