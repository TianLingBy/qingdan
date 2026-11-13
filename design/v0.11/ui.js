/* 轻单 v0.9.1 · 交互增强：亮暗 / 字号三档 / 转场四选一 / 排序 / 分页输入 / 表格呈现 / 日期区间 / 录入抽屉 */
(function () {
  var root = document.documentElement;
  var LS = function (k, v) { if (v === undefined) { try { return localStorage.getItem(k); } catch (e) { return null; } } try { localStorage.setItem(k, v); } catch (e) {} };
  var mode = LS('qd-mode') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  var fs = LS('qd-fs') || 'm';
  var trans = LS('qd-trans') || 'fade';
  var q = new URLSearchParams(location.search);
  if (q.get('mode')) mode = q.get('mode');
  if (q.get('fs')) fs = q.get('fs');
  if (q.get('trans')) trans = q.get('trans');
  function apply() {
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-fs', fs);
    root.setAttribute('data-trans', trans);
    document.querySelectorAll('.qd-dock [data-k]').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.k === 'mode' && b.dataset.v === mode) ||
        (b.dataset.k === 'fs' && b.dataset.v === fs) || (b.dataset.k === 'trans' && b.dataset.v === trans));
    });
  }
  function dock() {
    var d = document.createElement('div');
    d.className = 'qd-dock';
    d.innerHTML = '<div class="qd-dock-panel">' +
      '<div class="qd-row"><span>界面</span><div class="qd-opts">' +
        '<button data-k="mode" data-v="dark">暗</button><button data-k="mode" data-v="light">亮</button></div></div>' +
      '<div class="qd-row"><span>字号</span><div class="qd-opts">' +
        '<button data-k="fs" data-v="s">小</button><button data-k="fs" data-v="m">中</button><button data-k="fs" data-v="l">大</button></div></div>' +
      '<div class="qd-row"><span>转场</span><div class="qd-opts">' +
        '<button data-k="trans" data-v="fade">淡</button><button data-k="trans" data-v="slide">滑</button><button data-k="trans" data-v="scale">缩</button><button data-k="trans" data-v="wipe">擦</button></div></div>' +
      '</div><button class="qd-dock-btn" aria-label="外观设置">◐</button>';
    document.body.appendChild(d);
    d.querySelector('.qd-dock-btn').addEventListener('click', function () { d.classList.toggle('open'); });
    d.addEventListener('click', function (e) {
      var b = e.target.closest('[data-k]'); if (!b) return;
      if (b.dataset.k === 'mode') mode = b.dataset.v;
      if (b.dataset.k === 'fs') fs = b.dataset.v;
      if (b.dataset.k === 'trans') trans = b.dataset.v;
      LS('qd-' + b.dataset.k, b.dataset.v); apply();
    });
    document.addEventListener('click', function (e) { if (!d.contains(e.target)) d.classList.remove('open'); });
  }
  /* 排序 */
  function bindSort() {
    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var table = th.closest('table'); var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
        var asc = !th.classList.contains('asc');
        table.querySelectorAll('th').forEach(function (x) { x.classList.remove('asc', 'desc'); });
        th.classList.add(asc ? 'asc' : 'desc');
        var rows = Array.prototype.slice.call(table.tBodies[0].rows);
        rows.sort(function (a, b) {
          var x = a.cells[idx].innerText.trim(), y = b.cells[idx].innerText.trim();
          var nx = parseFloat(x.replace(/[^\d.-]/g, '')), ny = parseFloat(y.replace(/[^\d.-]/g, ''));
          var r = (!isNaN(nx) && !isNaN(ny)) ? nx - ny : x.localeCompare(y, 'zh-Hans-CN');
          return asc ? r : -r;
        });
        rows.forEach(function (r) { table.tBodies[0].appendChild(r); });
      });
    });
  }
  /* 表格呈现方式 */
  function bindView() {
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        var card = document.querySelector('.card[data-card]');
        if (!card) return;
        card.classList.remove('dense', 'comfy', 'cards-view');
        if (b.dataset.view !== 'normal') card.classList.add(b.dataset.view);
        document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.toggle('on', x === b); });
      });
    });
  }
  /* 分页中间输入 */
  function bindPager() {
    document.querySelectorAll('.pager input').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var n = Math.max(1, Math.min(parseInt(inp.value, 10) || 1, parseInt(inp.closest('.pager').dataset.pages || '1', 10)));
        inp.value = n;
      });
      inp.addEventListener('blur', function () {
        var p = parseInt(inp.closest('.pager').dataset.pages || '1', 10);
        inp.value = Math.max(1, Math.min(parseInt(inp.value, 10) || 1, p));
      });
    });
  }
  /* 日期区间快捷 */
  function bindDates() {
    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-range]').forEach(function (x) { x.classList.toggle('on', x === b); });
        var box = document.querySelector('[data-datebox]'); if (!box) return;
        var d = new Date(), fmt = function (x) { return x.toISOString().slice(0, 10); };
        var s = new Date(d), e = new Date(d);
        if (b.dataset.range === 'week') s.setDate(d.getDate() - 6);
        if (b.dataset.range === 'month') s = new Date(d.getFullYear(), d.getMonth(), 1);
        if (b.dataset.range === 'quarter') s = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
        if (b.dataset.range === 'year') s = new Date(d.getFullYear(), 0, 1);
        box.querySelectorAll('input').forEach(function (i, n) { i.value = fmt(n ? e : s); });
      });
    });
  }
  /* 录入抽屉 */
  function bindDrawer() {
    document.querySelectorAll('[data-drawer]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.querySelector(b.dataset.drawer); if (el) el.hidden = false;
      });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.querySelector(b.dataset.close); if (el) el.hidden = true;
      });
    });
  }
  /* 链接转场 */
  function bindNav() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a'); if (!a || a.target || a.href.startsWith('javascript') || e.metaKey) return;
      if (a.getAttribute('href') && a.getAttribute('href').indexOf('#') === 0) return;
      var main = document.querySelector('.main'); if (!main) return;
      e.preventDefault();
      main.classList.add('qd-leaving');
      setTimeout(function () { location.href = a.href; }, 110);
    });
  }
  function boot() { apply(); dock(); bindSort(); bindView(); bindPager(); bindDates(); bindDrawer(); bindNav(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();


/* v0.11：分页语义 + 空态 */
(function(){
  function initPager(){
    document.querySelectorAll('.pager').forEach(function(p){
      var card = p.closest('.card');
      var rows = card ? card.querySelectorAll('tbody tr').length : 0;
      var pages = Math.max(1, Math.ceil(rows / 10));
      var kids = Array.prototype.slice.call(p.childNodes).filter(function(n){ return !(n.classList && n.classList.contains('count')); });
      if (!p.querySelector('.nav')) {
        var wrap = document.createElement('span'); wrap.className = 'nav';
        kids.forEach(function(n){ wrap.appendChild(n); });
        p.appendChild(wrap);
      }
      if (!p.querySelector('.count')) {
        var c = document.createElement('span'); c.className = 'count';
        c.textContent = '共 ' + rows + ' 条' + (pages > 1 ? ' · 第 1 / ' + pages + ' 页' : '');
        p.insertBefore(c, p.firstChild);
      }
      if (pages <= 1) p.classList.add('single');
    });
  }
  function initEmpty(){
    if(new URLSearchParams(location.search).get('state')!=='empty') return;
    document.querySelectorAll('.card table').forEach(function(t){
      t.style.display='none';
      var d=document.createElement('div'); d.className='empty show';
      d.innerHTML='<div class="ico">∅</div><b>筛下来一条都没有</b><i>换个日期或状态试试；也可能是还没开单。</i>';
      t.parentNode.appendChild(d);
    });
  }
  function boot(){ initPager(); initEmpty(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();

/* v0.11：演示态占位动作 */
(function(){
  var box=null;
  function tip(msg){
    if(!box){box=document.createElement('div');box.style.cssText='position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surf-2);color:var(--text-1);border:1px solid var(--line-2);border-radius:10px;padding:9px 14px;font-size:12.5px;z-index:90;box-shadow:var(--sh-2);opacity:0;transition:opacity .18s';document.body.appendChild(box);}
    box.textContent=msg;box.style.opacity='1';clearTimeout(box._t);box._t=setTimeout(function(){box.style.opacity='0';},1800);
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a'); if(!a) return;
    var h=a.getAttribute('href');
    if(h==='#'){ e.preventDefault(); tip('演示稿：这个操作还没接后端'); }
  },true);
})();