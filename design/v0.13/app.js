/* ============================================================
   轻单 v0.13 · 全站脚本（唯一一份）
   ------------------------------------------------------------
   合并自 v0.11 的 motion.js / nav.js / ui.js 三个文件：
   - 外观只有亮/暗两套（data-mode）+ 转场四选一，字号固定 18px；
     删除已废弃的四套配色切换器与 ?theme= 逻辑
   - 链接转场只保留一处（原 motion.setupTransitions 与 ui.bindNav 重复）
   - 壳层（侧栏 / 顶栏 / 页脚）由此脚本统一注入，22 页不再各写一份
   - 保留状态机、入场、图表路径/tooltip、等距空态插图、排序、
     分页、空态、抽屉、轻提示等全部活跃交互
   v0.13 变更：空态升级——等距插图 + 按页面专属文案 + 主操作按钮，
   空态时同步隐藏分页条；覆盖全部 19 个带表格的标准列表页
   ============================================================ */
(function(){
'use strict';
var root=document.documentElement;
var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
function LS(k,v){ if(v===undefined){ try{return localStorage.getItem(k);}catch(e){return null;} } try{localStorage.setItem(k,v);}catch(e){} }
var q=new URLSearchParams(location.search);
var mode=q.get('mode')||LS('qd-mode')||(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
var trans=q.get('trans')||LS('qd-trans')||'fade';
/* 侧栏宽度：读取上次拖拽结果（默认 236px），在壳层注入前写入，避免闪动 */
var sbw=parseInt(LS('qd-sb-w')||'',10);
if(sbw>=168&&sbw<=400) root.style.setProperty('--sb-w',sbw+'px');
/* 侧栏显隐：提前加类，避免刷新时先闪出再隐藏 */
if(LS('qd-sb-hidden')==='1') root.classList.add('sb-hidden');
/* 字号固定 18px，字号调节器已移除 */
root.style.setProperty('--fs-live','18px');
var fs='live';

/* ---- 1 · 外观（同步立即执行，避免换肤闪烁） ---- */
function applyAppearance(){
  root.setAttribute('data-mode',mode);
  root.setAttribute('data-fs',fs);
  root.setAttribute('data-trans',trans);
  document.querySelectorAll('.qd-dock [data-k]').forEach(function(b){
    b.classList.toggle('on',(b.dataset.k==='mode'&&b.dataset.v===mode)||
      (b.dataset.k==='fs'&&b.dataset.v===fs)||(b.dataset.k==='trans'&&b.dataset.v===trans));
  });
}
applyAppearance();

/* ---- 2 · 侧栏数据（唯一真源） ---- */
var NAV=[
  {d:'公共',items:[['workbench','工作台','工作台.html'],['flow','业务全流程图','业务全流程图.html']]},
  {d:'单据与结算',items:[['purchase-orders','采购单 A','采购单A.html'],['processing-orders','加工单 B','加工单B.html'],['sales-orders','销售单 E','销售单E.html'],['internal-trades','内部交易单 N','内部交易单N.html'],['settlements','结算单 C','结算单C.html'],['reversals','冲正单据','冲正单据.html']]},
  {d:'主数据',items:[['products','商品资料','商品资料.html'],['customers','客户','客户.html'],['suppliers','供应商','供应商.html'],['processors','加工厂档案','加工厂档案.html']]},
  {d:'库存',items:[['inventory','库存数量','库存.html'],['inventory-flows','库存流水','库存流水.html'],['stocktakes','盘点','盘点.html']]},
  {d:'组织',items:[['employees','员工','员工.html'],['permissions','权限设置','权限设置.html'],['companies','公司管理','公司管理.html']]},
  {d:'报表',items:[['profit-report','利润报表','报表.html']]},
  {d:'系统',items:[['audit-logs','操作日志','操作日志.html'],['api-integration','API 与集成','API与集成.html']]}
];
var ICON='<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
/* 侧栏图标：与工作台「常用界面」同一套线性图标（未收录的入口用近义图标） */
var ICONS={
  'workbench':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1"/><rect x="11" y="11" width="5.5" height="5.5" rx="1"/></svg>',
  'flow':'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="5.5" r="1.8"/><circle cx="15" cy="10" r="1.8"/><circle cx="5" cy="14.5" r="1.8"/><path d="M6.7 6.4l6.5 2.8M13.2 11 6.8 13.7"/></svg>',
  'purchase-orders':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3H5.5v14h9V6z"/><path d="M11 3v3h3.5"/><path d="M8 10.5h4.5M8 13.5h4.5"/></svg>',
  'processing-orders':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l5.2-5.2"/><path d="M9.2 5.6 12.2 3l4.6 4.6-2.6 3z"/></svg>',
  'sales-orders':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10.5 3H16v5.5L9.5 15 4 9.5z"/><circle cx="12.8" cy="6.2" r="1.1"/></svg>',
  'internal-trades':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7h11l-2.5-2.5M16 13H5l2.5 2.5"/></svg>',
  'settlements':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="5.5" width="13" height="10" rx="1.5"/><path d="M13 10.5h3.5"/></svg>',
  'reversals':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.5 4 7.5l3 3"/><path d="M4 7.5h8.5a3.75 3.75 0 0 1 0 7.5H9"/></svg>',
  'products':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l6 3.2v7.6L10 17l-6-3.2V6.2z"/><path d="M4 6.2 10 9.4l6-3.2M10 9.4V17"/></svg>',
  'customers':'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="2.8"/><path d="M4.5 16.5c.9-2.8 3-4 5.5-4s4.6 1.2 5.5 4"/></svg>',
  'suppliers':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="6.5" width="9" height="7"/><path d="M12 9h3.5l1.5 2.5v2h-5"/><circle cx="6.5" cy="15.2" r="1.3"/><circle cx="14" cy="15.2" r="1.3"/></svg>',
  'processors':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 16.5v-8l4.5 3v-3l4.5 3v-8h4v13z"/></svg>',
  'inventory':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l6.5 3v8L10 17l-6.5-3V6z"/><path d="M3.5 6 10 9l6.5-3M10 9v8"/></svg>',
  'inventory-flows':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg>',
  'stocktakes':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="3.5" width="11" height="13" rx="1.5"/><path d="M7.5 9.5l2 2 3.5-3.5"/></svg>',
  'employees':'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="7" r="2.6"/><path d="M3.5 16c.8-2.6 2.5-3.6 4.5-3.6s3.7 1 4.5 3.6"/><path d="M14.5 5.5v4M12.5 7.5h4"/></svg>',
  'permissions':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l5.5 1.8v4.7c0 3.6-2.6 5.5-5.5 6.5-2.9-1-5.5-2.9-5.5-6.5V4.8z"/></svg>',
  'companies':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="4" width="9" height="12.5"/><path d="M8.5 7.5h1M10.8 7.5h1M8.5 10.5h1M10.8 10.5h1M9.3 16.5V14h1.6v2.5"/></svg>',
  'profit-report':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16.5V10M9 16.5V5M14 16.5v-4"/><path d="M3 16.5h13"/></svg>',
  'audit-logs':'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="3.5" width="11" height="13" rx="1.5"/><path d="M7 7.5h6M7 10.5h6M7 13.5h3.5"/></svg>',
  'api-integration':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4.5v3M12 4.5v3"/><path d="M6.5 7.5h7v2.2a3.5 3.5 0 0 1-7 0z"/><path d="M10 13.7V17"/></svg>'
};

/* ---- 3 · 统一壳层注入 ---- */
function injectShell(){
  var body=document.body;
  if(!body.querySelector('.wrap')) return;
  if(body.querySelector('.sidebar')) return;
  var crumb=body.getAttribute('data-crumb')||'';
  var aside=document.createElement('aside');
  aside.className='sidebar'; aside.id='qd-sidebar';
  aside.innerHTML='<div class="sb-brand"><div class="sb-mark">轻</div><div class="sb-name">轻单<small>Qingdan</small></div></div>'+
    '<nav class="sb-nav"></nav>'+
    '<div class="sb-foot"><div class="sb-avatar">何</div><div class="sb-user"><b>何XX</b><small>演示公司</small></div></div>';
  body.insertBefore(aside,body.firstChild);
  var main=document.createElement('div'); main.className='main';
  Array.prototype.slice.call(body.childNodes).forEach(function(n){ if(n!==aside) main.appendChild(n); });
  var top=document.createElement('header'); top.className='topbar';
  top.innerHTML='<nav class="crumb"><a href="工作台.html">轻单</a><span class="sep">/</span><span class="cur">'+crumb+'</span></nav>'+
    '<div class="snapshot"><span>今日单据 <b>24</b></span><span class="sep">|</span><span>待处理 <b>3</b></span><span class="sep">|</span><span>本月成本 <b>¥1,286,400</b></span></div>';
  main.insertBefore(top,main.firstChild);
  var foot=document.createElement('footer'); foot.className='foot';
  foot.textContent='轻单 v0.13 设计稿 · 演示数据 · 字段对齐 docs/api/openapi.yaml';
  main.appendChild(foot);
  body.appendChild(main);
  setupSidebarResize();
  setupSidebarToggle();
}
/* 侧栏右上角显隐开关：点击隐藏整条导航，再点左上角开关恢复 */
function setupSidebarToggle(){
  var b=document.createElement('button');
  b.type='button'; b.className='sb-toggle';
  b.innerHTML='<svg class="ico-hide" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8.5 4v12"/><path d="M12.8 7.6 10.4 10l2.4 2.4"/></svg>'+
              '<svg class="ico-show" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8.5 4v12"/><path d="M10.4 7.6 12.8 10l-2.4 2.4"/></svg>';
  function paint(){
    var hid=root.classList.contains('sb-hidden');
    b.title=hid?'显示导航栏':'隐藏导航栏';
    b.setAttribute('aria-label',b.title);
    b.setAttribute('aria-expanded',String(!hid));
    b.setAttribute('aria-controls','qd-sidebar');
  }
  b.addEventListener('click',function(){
    root.classList.toggle('sb-hidden');
    LS('qd-sb-hidden',root.classList.contains('sb-hidden')?'1':'0');
    paint();
  });
  paint();
  document.body.appendChild(b);
}
/* 侧栏右缘拖拽改宽：168–400px，双击复位 236px，结果写入 localStorage */
function setupSidebarResize(){
  var sb=document.querySelector('.sidebar'); if(!sb) return;
  var h=document.createElement('div');
  h.className='sb-resizer'; h.title='拖动调整导航宽度 · 双击复位';
  h.tabIndex=0; h.setAttribute('role','separator'); h.setAttribute('aria-orientation','vertical');
  h.setAttribute('aria-label','拖动调整导航宽度');
  sb.appendChild(h);
  var MIN=168,MAX=400,DEF=236,drag=false;
  function apply(w){
    w=Math.max(MIN,Math.min(MAX,Math.round(w)));
    root.style.setProperty('--sb-w',w+'px');
    return w;
  }
  h.addEventListener('pointerdown',function(e){
    drag=true; h.classList.add('on'); document.body.classList.add('sb-resizing');
    if(h.setPointerCapture) h.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  h.addEventListener('pointermove',function(e){ if(drag) apply(e.clientX); });
  function end(){
    if(!drag) return;
    drag=false; h.classList.remove('on'); document.body.classList.remove('sb-resizing');
    LS('qd-sb-w',String(Math.round(sb.getBoundingClientRect().width)));
  }
  h.addEventListener('pointerup',end);
  h.addEventListener('pointercancel',end);
  h.addEventListener('dblclick',function(){ LS('qd-sb-w',String(apply(DEF))); });
  h.addEventListener('keydown',function(e){
    if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight') return;
    e.preventDefault();
    var next=apply(sb.getBoundingClientRect().width+(e.key==='ArrowRight'?8:-8));
    LS('qd-sb-w',String(next));
  });
}
function renderNav(){
  var host=document.querySelector('.sb-nav'); if(!host) return;
  var cur=document.body.getAttribute('data-nav')||'';
  host.innerHTML=NAV.map(function(g){
    var active=g.items.some(function(it){return it[0]===cur;});
    return '<div class="sb-domain'+(active?' open':'')+'">'+g.d+'</div><div class="sb-group'+(active?' open':'')+'">'+
      g.items.map(function(it){
        return '<a href="'+it[2]+'" class="sb-link'+(it[0]===cur?' on':'')+'">'+(ICONS[it[0]]||ICON)+'<span class="sb-label">'+it[1]+'</span></a>';
      }).join('')+'</div>';
  }).join('');
  host.querySelectorAll('.sb-domain').forEach(function(h){
    h.addEventListener('click',function(){
      h.classList.toggle('open');
      var g=h.nextElementSibling; if(g) g.classList.toggle('open');
    });
  });
}

/* ---- 4 · 外观设置坞 ---- */

function dock() {
    var ICON_MOON='<svg viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true"><path d="M2 0h3v1h-3z M1 1h2v1h-2z M0 2h3v1h-3z M0 3h3v1h-3z M0 4h3v1h-3z M1 5h2v1h-2z M2 6h3v1h-3z"/></svg>';
    var ICON_SUN='<svg viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true"><path d="M3 0h1v1h-1z M1 1h1v1h-1z M3 1h1v1h-1z M5 1h1v1h-1z M2 2h3v1h-3z M0 3h1v1h-1z M2 3h3v1h-3z M6 3h1v1h-1z M2 4h3v1h-3z M1 5h1v1h-1z M3 5h1v1h-1z M5 5h1v1h-1z M3 6h1v1h-1z"/></svg>';
    var d = document.createElement('div');
    d.className = 'qd-dock';
    d.innerHTML = '<div class="qd-dock-panel">' +
      '<div class="qd-row"><span>界面</span><div class="qd-mode-tgl">' +
        '<button data-k="mode" data-v="dark" aria-label="暗色模式" title="暗">'+ICON_MOON+'</button>' +
        '<button data-k="mode" data-v="light" aria-label="亮色模式" title="亮">'+ICON_SUN+'</button></div></div>' +
      '<div class="qd-row"><span>转场</span><div class="qd-opts">' +
        '<button data-k="trans" data-v="fade">淡</button><button data-k="trans" data-v="slide">滑</button><button data-k="trans" data-v="scale">缩</button><button data-k="trans" data-v="wipe">擦</button></div></div>' +
      '</div><button class="qd-dock-btn" aria-label="外观设置">◐</button>';
    document.body.appendChild(d);
    d.querySelector('.qd-dock-btn').addEventListener('click', function () { d.classList.toggle('open'); });
    d.addEventListener('click', function (e) {
      var b = e.target.closest('[data-k]'); if (!b) return;
      if (b.dataset.k === 'mode') mode = b.dataset.v;
      if (b.dataset.k === 'trans') trans = b.dataset.v;
      LS('qd-' + b.dataset.k, b.dataset.v); applyAppearance();
    });
    document.addEventListener('click', function (e) { if (!d.contains(e.target)) d.classList.remove('open'); });
  }

/* ---- 5 · 表格 / 分页 / 空态 / 抽屉 / 转场 ---- */

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
function bindDrawer() {
    document.querySelectorAll('[data-drawer]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.querySelector(b.dataset.drawer); if (!el) return;
        var t = el.querySelector('[data-sheet-title]');
        if (t && b.dataset.sheetTitle) t.textContent = b.dataset.sheetTitle;
        el.hidden = false;
      });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.querySelector(b.dataset.close); if (el) el.hidden = true;
      });
    });
    /* 点遮罩 / 按 Esc 关闭主数据抽屉 */
    document.querySelectorAll('.md-scrim').forEach(function (el) {
      el.addEventListener('click', function (e) { if (e.target === el) el.hidden = true; });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.md-scrim:not([hidden])').forEach(function (el) { el.hidden = true; });
    });
  }
/* 分面筛选：公司 / 状态（[data-facet] 按钮组过滤 tbody tr[data-xxx]） */
function bindFacets() {
    document.querySelectorAll('[data-facet]').forEach(function (seg) {
      var key = seg.dataset.facet;
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        var val = b.dataset.val || 'all';
        document.querySelectorAll('tbody tr[data-' + key + ']').forEach(function (tr) {
          tr.style.display = (val === 'all' || tr.getAttribute('data-' + key) === val) ? '' : 'none';
        });
      });
    });
  }
/* 三级下钻：对接人 → 该对接人的订单 */
function bindDrill() {
    document.querySelectorAll('[data-drill]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = document.querySelector(b.dataset.drill); if (!t) return;
        var open = t.hidden;
        t.hidden = !open;
        b.textContent = open ? '收起订单' : '查看订单';
      });
    });
  }
/* 疑似重复审核：合并 / 确认独立（演示态，只改文案不落库） */
function bindDedupe() {
    document.querySelectorAll('[data-dedupe-action]').forEach(function (b) {
      b.addEventListener('click', function () {
        var grp = b.closest('.md-dup'); if (!grp) return;
        var act = b.dataset.dedupeAction;
        grp.querySelectorAll('button').forEach(function (x) { x.disabled = true; x.style.opacity = '.45'; x.style.cursor = 'default'; });
        var st = grp.querySelector('.md-dup-state');
        if (st) {
          st.textContent = act === 'merge'
            ? '已合并：保留主档案，另一条归档；历史单据不改写。'
            : '已确认各自独立：该组不再提醒。';
          st.className = 'md-dup-state ok';
        }
      });
    });
  }
/* 停用二次确认：展开 / 收起原因填写 */
function bindConfirm() {
    document.querySelectorAll('[data-confirm-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var box = document.querySelector(b.dataset.confirmToggle); if (box) box.classList.toggle('show');
      });
    });
    document.querySelectorAll('[data-confirm-cancel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var box = document.querySelector(b.dataset.confirmCancel); if (box) box.classList.remove('show');
      });
    });
  }
/* 第 5 态：?state=noprice —— 无看价权限，金额列统一显示「—」 */
function initPriceMask() {
    if (new URLSearchParams(location.search).get('state') !== 'noprice') return;
    document.querySelectorAll('[data-money]').forEach(function (el) {
      el.textContent = '—';
      el.title = '无 product.view_price 权限，金额已隐藏';
    });
    var card = document.querySelector('.card');
    if (card && !document.querySelector('.md-noprice')) {
      var n = document.createElement('p');
      n.className = 'md-noprice';
      n.textContent = '当前账号没有看价权限（product.view_price），金额一律显示「—」；数量与状态不受影响。';
      card.parentNode.insertBefore(n, card);
    }
  }
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
/* 空态：按页面（data-nav）给专属文案与主操作按钮；
   没有映射的页面退回通用文案。btn 用 href="#"，
   由全局 # 链接拦截统一弹「演示稿」轻提示。 */
var EMPTY_BY_PAGE = {
  'purchase-orders':   {t:'还没有采购单',   d:'第一张采购单会出现在这里。开单后按 开单 → 供应商确认 → 入库完成 走；数量不对不要直接改，取消重开。', btn:'+ 新建采购单'},
  'processing-orders': {t:'还没有加工单',   d:'委托外部加工厂的每一笔加工费都会挂在加工单上，先开一张试试。', btn:'+ 新建加工单'},
  'sales-orders':      {t:'还没有销售单',   d:'客户下单后在这里登记，交付完成后按 C 单结算。', btn:'+ 新建销售单'},
  'internal-trades':   {t:'还没有内部交易单', d:'兄弟公司之间的调拨与往来开 N 单记录，总部可看全部。', btn:'+ 新建内部交易单'},
  'settlements':       {t:'还没有结算单',   d:'单据走完后按 C 单结算，一单一成本在这里收口。', btn:'+ 新建结算单'},
  'reversals':         {t:'没有需要冲正的单据', d:'开错的单用冲正纠正：R 冲采购、S 冲销售、I 冲内部交易，不直接改原单。', btn:'+ 新建冲正单'},
  'customers':         {t:'还没有客户档案', d:'客户跟进与订单都挂在客户名下，先建第一个客户。', btn:'+ 新建客户'},
  'suppliers':         {t:'还没有供应商',   d:'采购单要挂供应商，先在集团主数据里登记。', btn:'+ 新建供应商'},
  'processors':        {t:'还没有加工厂',   d:'先登记加工厂，开 B 单时才能选到它。', btn:'+ 新建加工厂'},
  'products':          {t:'还没有商品资料', d:'商品与规格统一在集团主数据维护，各子公司共用。', btn:'+ 新建商品'},
  'employees':         {t:'还没有员工',     d:'员工由老板 / 经理登记，登录账号一并开通（一期不发验证码）。', btn:'+ 新建员工'},
  'permissions':       {t:'还没有权限组',   d:'按岗位配权限：看价、子公司隔离、操作授权。', btn:'+ 新建权限组'},
  'companies':         {t:'还没有子公司',   d:'总部在这里登记各子公司，数据按公司相互隔离。', btn:'+ 新增子公司'},
  'inventory':         {t:'仓库还没有货',   d:'货到入库后，每一笔库存都能追溯到所属员工。', btn:'+ 新建入库'},
  'inventory-flows':   {t:'还没有库存流水', d:'每一次入库、出库、调拨都会在这里留痕。', btn2:'查看库存'},
  'stocktakes':        {t:'还没有盘点任务', d:'先建一张盘点单，照单清点仓库，盈亏数量手填。', btn:'+ 新建盘点'},
  'profit-report':     {t:'还没有报表数据', d:'订单走完结算后，按期间出成本与毛利；无看价权限时金额显示「—」。', btn2:'查看单据'},
  'audit-logs':        {t:'还没有操作记录', d:'谁动了哪张单、什么时候动的，这里都会记一笔。'},
  'api-integration':   {t:'还没有接入',     d:'在这里创建 API Token，把 Excel 台账换成自动同步。', btn:'+ 创建 Token'}
};
var EMPTY_FALLBACK = {t:'这里还没有数据', d:'等第一批数据进来，就会出现在这个列表里。'};
function initEmpty(){
    if(new URLSearchParams(location.search).get('state')!=='empty') return;
    var cfg = EMPTY_BY_PAGE[document.body.getAttribute('data-nav')] || EMPTY_FALLBACK;
    document.querySelectorAll('.card').forEach(function(card){
      var t = card.querySelector('table'); if(!t) return;
      t.style.display='none';
      card.querySelectorAll('.pager').forEach(function(p){ p.style.display='none'; });
      var d=document.createElement('div'); d.className='empty show';
      d.innerHTML='<div class="empty-ico">'+ART.empty+'</div>'
        +'<b>'+cfg.t+'</b><i>'+cfg.d+'</i>'
        +(cfg.btn||cfg.btn2
          ? '<div class="empty-actions">'
            +(cfg.btn ?'<a class="st-btn primary" href="#">'+cfg.btn+'</a>':'')
            +(cfg.btn2?'<a class="st-btn" href="#">'+cfg.btn2+'</a>':'')
            +'</div>'
          : '');
      card.appendChild(d);
    });
  }
/* 加载 / 错误态：列表页通用骨架屏与错误卡。
   单据详情.html 自带 data-state 四态结构（由 setupStates 处理），
   列表页没有该结构，由此函数按 ?state=loading|error 注入。
   错误态「重试」按钮 href="?"：点击去掉 state 参数回到正常列表，
   正好演示「重试成功」。 */
function initListStates(){
    var want=new URLSearchParams(location.search).get('state');
    if(want!=='loading'&&want!=='error') return;
    document.querySelectorAll('.card').forEach(function(card){
      var t=card.querySelector('table'); if(!t) return;
      if(card.querySelector('.empty.show')) return;
      t.style.display='none';
      card.querySelectorAll('.pager').forEach(function(p){ p.style.display='none'; });
      if(want==='loading'){
        var s=document.createElement('div'); s.className='list-state show';
        s.innerHTML='<div class="sk sk-line" style="height:12px;margin:18px 0;width:82%"></div>'
          +'<div class="sk sk-line" style="height:12px;margin:18px 0;width:64%"></div>'
          +'<div class="sk sk-line" style="height:12px;margin:18px 0;width:74%"></div>'
          +'<div class="sk sk-line" style="height:12px;margin:18px 0;width:45%"></div>'
          +'<div class="sk sk-line" style="height:12px;margin:18px 0;width:64%"></div>';
        card.appendChild(s);
      } else {
        var d=document.createElement('div'); d.className='empty show err';
        d.innerHTML='<div class="empty-ico">'+ART.error+'</div>'
          +'<b>列表没取到</b><i>服务端这一次没回数据（演示环境里是故意造的）。数据不会丢，点「重试」再取一次；连续失败两次，把请求编号发给管理员，他能查到具体这一次。</i>'
          +'<div class="empty-actions"><a class="st-btn primary" href="?">重试</a></div>';
        card.appendChild(d);
      }
    });
  }
function tip(msg){
    if(!box){box=document.createElement('div');box.style.cssText='position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surf-2);color:var(--text-1);border:1px solid var(--line-2);border-radius:10px;padding:9px 14px;font-size:12.5px;z-index:90;box-shadow:var(--sh-2);opacity:0;transition:opacity .18s';document.body.appendChild(box);}
    box.textContent=msg;box.style.opacity='1';clearTimeout(box._t);box._t=setTimeout(function(){box.style.opacity='0';},1800);
  }

document.addEventListener('click',function(e){
  var a=e.target.closest('a'); if(!a) return;
  if(a.getAttribute('href')==='#'){ e.preventDefault(); tip('演示稿：这个操作还没接后端'); }
},true);

/* ---- 6 · 数据区状态 / 入场 / 图表 / 空态插图（保留自 motion.js） ---- */

var ART = {
    /* 空态：三张纸的堆叠 + 前面一个虚线空位。
       用 skewY 做一点斜切，比硬画等距多边形更稳、更小、更清楚。 */
    empty: '<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">'
      + '<g transform="skewY(-9)" stroke="currentColor" stroke-linejoin="round">'
      + '<rect x="30" y="34" width="40" height="27" rx="2.5" stroke-opacity=".28" stroke-width="1.2" fill="rgba(var(--text-rgb),.03)"/>'
      + '<rect x="24" y="30" width="40" height="27" rx="2.5" stroke-opacity=".5" stroke-width="1.2" fill="rgba(var(--accent-rgb),.06)"/>'
      + '<rect x="18" y="26" width="40" height="27" rx="2.5" stroke-opacity=".9" stroke-width="1.4" fill="rgba(var(--accent-rgb),.12)"/>'
      + '<path d="M25 35 L45 35M25 40 L51 40M25 45 L40 45" stroke-opacity=".55" stroke-width="1.3"/>'
      + '<rect x="18" y="62" width="40" height="27" rx="2.5" stroke-dasharray="4 5" stroke-opacity=".75" stroke-width="1.3"/>'
      + '<path d="M34 75.5 L42 75.5M38 71.5 L38 79.5" stroke-opacity=".7" stroke-width="1.4"/>'
      + '</g></svg>',
    /* 错误态：纸角撕开一道缝 + 一个感叹号徽标 */
    error: '<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">'
      + '<g transform="skewY(-9)" stroke="currentColor" stroke-linejoin="round">'
      + '<rect x="20" y="26" width="42" height="29" rx="2.5" stroke-opacity=".85" stroke-width="1.4" fill="rgba(var(--text-rgb),.06)"/>'
      + '<path d="M32 35 L52 35M32 41 L58 41M32 47 L44 47" stroke-opacity=".45" stroke-width="1.3"/>'
      + '<path d="M50 47 L62 41" stroke-dasharray="2.5 4" stroke-opacity=".5" stroke-width="1.2"/>'
      + '</g>'
      + '<circle cx="62" cy="62" r="11" fill="rgba(192,83,58,.14)" stroke="currentColor" stroke-opacity=".55" stroke-width="1.4"/>'
      + '<path d="M62 56.5 L62 63" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-opacity=".9"/>'
      + '<circle cx="62" cy="67.5" r="1.2" fill="currentColor" opacity=".9"/>'
      + '</svg>'
  }

function ready(fn){
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn,{once:true});
    else fn();
  }
function setupStates(){
    var want=null;
    try{ want=new URLSearchParams(location.search).get('state'); }catch(e){ want=null; }
    if(want!=='empty'&&want!=='loading'&&want!=='error') return;
    document.querySelectorAll('[data-state]').forEach(function(el){
      el.setAttribute('data-state',want);
    });
  }
function setupReveal(){
    var items=Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    if(!items.length) return;
    var byParent=new Map();
    items.forEach(function(el){
      var p=el.parentElement||document.body;
      if(!byParent.has(p)) byParent.set(p,[]);
      byParent.get(p).push(el);
    });
    byParent.forEach(function(list){
      list.forEach(function(el,i){ el.style.setProperty('--rd',Math.min(i,7)*30+'ms'); });
    });
    function play(el){
      el.style.willChange='opacity,transform';
      el.classList.add('is-in');
      window.setTimeout(function(){el.style.willChange='';},600);
    }
    var io=('IntersectionObserver' in window)
      ?new IntersectionObserver(function(entries){
          entries.forEach(function(e){
            if(!e.isIntersecting) return;
            play(e.target);io.unobserve(e.target);
          });
        },{rootMargin:'0px 0px -6% 0px',threshold:0.01})
      :null;
    items.forEach(function(el){ if(io) io.observe(el); else play(el); });
    requestAnimationFrame(function(){
      items.forEach(function(el){
        var r=el.getBoundingClientRect();
        if(r.top<window.innerHeight*0.94) play(el);
      });
    });
  }
function setupGrow(){
    var grows=document.querySelectorAll('[data-grow]');
    Array.prototype.forEach.call(grows,function(el,i){
      el.style.setProperty('--gd',Math.min(i,8)*30+80+'ms');
    });
    var draws=document.querySelectorAll('[data-draw]');
    Array.prototype.forEach.call(draws,function(path,i){
      var len=0;
      try{len=path.getTotalLength?path.getTotalLength():0;}catch(err){len=0;}
      if(!len) return;
      path.style.strokeDasharray=len;
      path.style.strokeDashoffset=len;
      path.style.transition='stroke-dashoffset var(--d-data) var(--ease-out) '+(120+i*60)+'ms';
    });
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        Array.prototype.forEach.call(document.querySelectorAll('[data-grow]'),function(el){
          el.classList.add('is-in');
        });
        Array.prototype.forEach.call(draws,function(path){ path.style.strokeDashoffset='0'; });
      });
    });
  }
function setupBatchBar(){
    var bar=document.querySelector('.batch');
    if(!bar) return;
    var cbs=document.querySelectorAll('tbody input[type=checkbox]');
    if(!cbs.length) return;

    bar.style.transform='translateY(100%)';
    bar.style.transition='transform var(--d-3) var(--ease-out)';
    var hideTimer=null;

    function update(){
      var count=0;
      cbs.forEach(function(cb){ if(cb.checked) count++; });
      var countEl=bar.querySelector('[data-batch-count]');
      if(countEl) countEl.textContent=count;
      var head=bar.querySelector('[data-batch-total]');
      if(head) head.textContent='¥191,605.50';
      var headSel=document.querySelector('[data-selected-label]');
      if(headSel) headSel.textContent='已选 '+count+' 条';
      var rowSel=document.querySelector('[data-row-selected]');
      if(rowSel) rowSel.textContent='已选 '+count+' 条';
      bar.querySelectorAll('button[data-needs-selection]').forEach(function(b){
        b.disabled=count===0;
        b.style.opacity=count===0?.45:1;
        b.style.cursor=count===0?'not-allowed':'pointer';
      });
      if(count>0){
        clearTimeout(hideTimer);
        bar.style.transform='translateY(0)';
      }else{
        hideTimer=setTimeout(function(){bar.style.transform='translateY(100%)';},400);
      }
    }
    cbs.forEach(function(cb){cb.addEventListener('change',update);});
    var allCb=document.querySelector('thead input[type=checkbox]');
    if(allCb){
      allCb.addEventListener('change',function(){
        cbs.forEach(function(cb){cb.checked=allCb.checked;});
        update();
      });
    }
    update();
  }
function setupChartTooltip(){
    var svg=document.querySelector('svg.chart');
    if(!svg) return;
    var data=null;
    try{data=JSON.parse(svg.getAttribute('data-points')||'null');}catch(e){data=null;}
    if(!data||!data.length) return;

    var tip=document.createElement('div');
    tip.className='chart-tip';
    tip.style.cssText='position:fixed;pointer-events:none;z-index:50;'
      +'background:var(--bg-2);border:1px solid var(--line-3);border-radius:8px;'
      +'padding:10px 14px;font-size:12px;color:var(--text-1);'
      +'box-shadow:var(--sh-2);opacity:0;transition:opacity 150ms;min-width:150px;';
    document.body.appendChild(tip);

    var vb=svg.viewBox.baseVal;
    var cursor=svg.querySelector('.pt-cursor');
    if(!cursor){
      cursor=document.createElementNS('http://www.w3.org/2000/svg','circle');
      cursor.setAttribute('r','4.5');
      cursor.style.fill='var(--accent-light)';
      cursor.style.stroke='var(--bg-0)';
      cursor.setAttribute('stroke-width','2');
      cursor.style.opacity='0';
      cursor.style.transition='opacity 150ms';
      cursor.classList.add('pt-cursor');
      svg.appendChild(cursor);
    }
    var guide=svg.querySelector('.pt-guide');
    if(!guide){
      guide=document.createElementNS('http://www.w3.org/2000/svg','line');
      guide.setAttribute('y1','20');
      guide.setAttribute('y2','260');
      guide.style.stroke='rgba(var(--accent-rgb), .35)';
      guide.setAttribute('stroke-width','1');
      guide.setAttribute('stroke-dasharray','3 4');
      guide.style.opacity='0';
      guide.style.transition='opacity 150ms';
      guide.classList.add('pt-guide');
      svg.appendChild(guide);
    }
    function find(mx){
      var best=null,bestD=1e9;
      data.forEach(function(p){ var d=Math.abs(p.x-mx); if(d<bestD){bestD=d;best=p;} });
      return bestD<=48?best:null;
    }
    svg.addEventListener('mousemove',function(e){
      var rect=svg.getBoundingClientRect();
      var mx=(e.clientX-rect.left)/rect.width*vb.width;
      var best=find(mx);
      if(!best){tip.style.opacity='0';cursor.style.opacity='0';guide.style.opacity='0';return;}
      cursor.setAttribute('cx',best.x);cursor.setAttribute('cy',best.y);cursor.style.opacity='1';
      guide.setAttribute('x1',best.x);guide.setAttribute('x2',best.x);guide.style.opacity='1';
      tip.innerHTML='<div style="color:var(--text-3);font-size:10px;letter-spacing:.1em;margin-bottom:6px;font-family:var(--mono)">'+best.d+'</div>'
        +'<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:3px">'
        +'<span style="color:var(--text-2)">净毛利</span><span style="color:var(--accent-light);font-family:var(--mono)">'+best.net+'</span></div>'
        +'<div style="display:flex;justify-content:space-between;gap:18px">'
        +'<span style="color:var(--text-3)">估算成本线</span><span style="color:var(--text-3);font-family:var(--mono)">'+best.est+'</span></div>';
      tip.style.opacity='1';
      var tx=e.clientX+16,ty=e.clientY-56;
      if(tx+170>window.innerWidth) tx=e.clientX-170;
      tip.style.left=tx+'px';tip.style.top=ty+'px';
    });
    svg.addEventListener('mouseleave',function(){
      tip.style.opacity='0';cursor.style.opacity='0';guide.style.opacity='0';
    });
  }
function setupArt(){
    var icons = document.querySelectorAll('.st-ico');
    Array.prototype.forEach.call(icons, function(el){
      if(el.getAttribute('data-art-done')) return;
      var want = el.getAttribute('data-art') || (el.closest('.st-error') ? 'error' : 'empty');
      el.innerHTML = ART[want] || ART.empty;
      el.setAttribute('data-art-done','1');
    });
  }
function setupChartPath(){
    var svg = document.querySelector('svg.chart');
    if(!svg) return;
    var data = null;
    try{ data = JSON.parse(svg.getAttribute('data-points') || 'null'); }catch(e){ data = null; }
    if(!data || !data.length) return;
    var Y0 = 260, LOW = 8000, PER = 1000, PX = 30;   /* viewBox：y=260 → ¥8,000，每 ¥1,000 = 30px */
    function toY(v){ return Y0 - (v - LOW) / PER * PX; }
    function toNum(s){ return parseInt(String(s).replace(/[^\d]/g, ''), 10); }
    function build(key){
      var out = [];
      data.forEach(function(p, i){
        var x = p.x;
        var y = (key === 'net') ? p.y : toY(toNum(p.est));
        out.push((i ? 'L' : 'M') + x + ' ' + y.toFixed(1));
      });
      return out.join(' ');
    }
    var main = svg.querySelector('.line-main');
    var est  = svg.querySelector('.line-est');
    if(main) main.setAttribute('d', build('net'));
    if(est)  est.setAttribute('d', build('est'));
  }

/* ---- 启动 ---- */
ready(function(){
  injectShell();
  renderNav();
  applyAppearance();
  dock();
  bindSort(); bindView(); bindPager(); bindDates(); bindDrawer(); bindNav();
  bindFacets(); bindDrill(); bindDedupe(); bindConfirm();
  initPager(); initEmpty(); initListStates(); initPriceMask();
  setupStates();
  setupChartPath();
  setupArt();
  if(!reduce) setupReveal();
  setupGrow();
  setupBatchBar();
  setupChartTooltip();
});
})();
