/* ============================================================
   轻单 v0.7 · 共享动效与主题
   ------------------------------------------------------------
   1) setupTheme()  新增：四套配色全站切换，写 localStorage，
      并广播 qd-theme-change（登录页粒子引擎据此重建 sprite）
   2) 动效收敛：入场 240ms / 递进 30ms、交互反馈 <=160ms、
      转场 150ms，低端设备关闭指针柔光
   3) setupStates()  数据区四态，由 ?state= 驱动
   4) setupChartTooltip() 只读 SVG data-points 一份真源
   5) setupBatchBar() 原生 checkbox，计数与吸底栏联动
   保留 prefers-reduced-motion 兜底
   ============================================================ */
(function(){
  'use strict';
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var lowEnd = (navigator.hardwareConcurrency || 8) <= 4;

  root.classList.remove('no-js');
  if(!reduce) root.classList.add('qd-enter');

  window.setTimeout(function(){
    root.classList.remove('qd-enter','qd-leave');
  },600);

  function ready(fn){
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn,{once:true});
    else fn();
  }

  /* ---- 0 · 主题切换 ---- */
  var THEMES=[
    {key:'moss',   name:'苔绿', color:'#93AE9C'},
    {key:'mist',   name:'雾蓝', color:'#8FA9BE'},
    {key:'bronze', name:'古铜', color:'#C4A57B'},
    {key:'paper',  name:'宣纸', color:'#3E5B50'}
  ];
  function setupTheme(){
    var cur=root.getAttribute('data-theme')||'moss';
    var box=document.createElement('div');
    box.className='qd-switch';
    box.setAttribute('role','group');
    box.setAttribute('aria-label','界面配色');
    var label=document.createElement('span');
    label.textContent='配色';
    box.appendChild(label);
    THEMES.forEach(function(t){
      var b=document.createElement('button');
      b.type='button';
      b.style.background=t.color;
      b.title=t.name+' · '+t.key;
      b.setAttribute('aria-label','切换到'+t.name+'配色');
      b.setAttribute('aria-pressed',String(t.key===cur));
      b.addEventListener('click',function(){
        if(t.key==='moss') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme',t.key);
        try{localStorage.setItem('qd-theme',t.key);}catch(e){}
        box.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed','false');});
        b.setAttribute('aria-pressed','true');
        if(window.CustomEvent) window.dispatchEvent(new CustomEvent('qd-theme-change',{detail:t.key}));
      });
      box.appendChild(b);
    });
    var sb=document.querySelector('.sidebar');
    var foot=sb&&sb.querySelector('.sb-foot');
    if(sb&&foot){
      box.classList.add('in-sidebar');
      sb.insertBefore(box,foot);
    }else{
      document.body.appendChild(box);
    }
  }

  /* ---- 1 · 数据区状态机 ---- */
  function setupStates(){
    var want=null;
    try{ want=new URLSearchParams(location.search).get('state'); }catch(e){ want=null; }
    if(want!=='empty'&&want!=='loading'&&want!=='error') return;
    document.querySelectorAll('[data-state]').forEach(function(el){
      el.setAttribute('data-state',want);
    });
  }

  /* ---- 2 · 入场 ---- */
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

  /* ---- 3 · 生长 ---- */
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

  /* ---- 4 · 页间转场 ---- */
  function isPlainLeftClick(e){ return e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey; }
  function internalTarget(a){
    var href=a.getAttribute('href')||'';
    if(!href||href.charAt(0)==='#') return null;
    if(a.target&&a.target!=='_self') return null;
    if(a.hasAttribute('download')) return null;
    if(/^(https?:|mailto:|tel:)/i.test(href)) return null;
    return href;
  }
  function setupTransitions(){
    var navigating=false;
    document.addEventListener('click',function(e){
      var a=e.target.closest?e.target.closest('a[href]'):null;
      if(!a||!isPlainLeftClick(e)) return;
      var href=internalTarget(a);
      if(!href) return;
      if(reduce) return;
      e.preventDefault();
      if(navigating) return;
      navigating=true;
      root.classList.add('qd-leave');
      window.setTimeout(function(){window.location.href=href;},150);
      window.setTimeout(function(){navigating=false;root.classList.remove('qd-leave');},800);
    },true);
    window.addEventListener('pageshow',function(){
      navigating=false;
      root.classList.remove('qd-enter','qd-leave');
      document.querySelectorAll('[data-reveal]').forEach(function(el){el.classList.add('is-in');});
    });
  }

  /* ---- 5 · 指针柔光（低端设备关闭） ---- */
  function setupAura(){
    if(lowEnd||reduce) return;
    if(!document.body.hasAttribute('data-aura')) return;
    if(!window.matchMedia||!window.matchMedia('(pointer:fine)').matches) return;
    var aura=document.createElement('div');
    aura.className='qd-aura';
    document.body.appendChild(aura);
    var x=window.innerWidth/2,y=window.innerHeight*0.4;
    var tx=x,ty=y,on=false,raf=0;
    function loop(){
      x+=(tx-x)*0.085; y+=(ty-y)*0.085;
      aura.style.transform='translate3d('+x.toFixed(1)+'px,'+y.toFixed(1)+'px,0)';
      raf=(on||Math.abs(tx-x)>0.6||Math.abs(ty-y)>0.6)?requestAnimationFrame(loop):0;
    }
    function kick(){if(!raf) raf=requestAnimationFrame(loop);}
    document.addEventListener('pointermove',function(e){
      tx=e.clientX;ty=e.clientY;
      if(!on){on=true;x=tx;y=ty;root.classList.add('qd-pointer');}
      kick();
    },{passive:true});
    document.addEventListener('pointerleave',function(){on=false;root.classList.remove('qd-pointer');kick();});
  }

  /* ---- 6 · 吸底栏（单据页）---- */
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

  /* ---- 7 · 折线图 hover tooltip（报表页）---- */
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

  /* ---- 8 · 空态等距插图（v0.8）----
     全站只在这里画一次：页面里的 .st-ico 留空即可，JS 按上下文补图。 */
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
  };

  function setupArt(){
    var icons = document.querySelectorAll('.st-ico');
    Array.prototype.forEach.call(icons, function(el){
      if(el.getAttribute('data-art-done')) return;
      var want = el.getAttribute('data-art') || (el.closest('.st-error') ? 'error' : 'empty');
      el.innerHTML = ART[want] || ART.empty;
      el.setAttribute('data-art-done','1');
    });
  }

  /* ---- 9 · 折线图按数据生成路径（v0.8）----
     以前 path 的 d 是手写死的，改一个数字要同时改三处。
     现在 data-points 是唯一真源：x/y 直接用，估算线由 est 金额反算 y。 */
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
    setupChartPath();
    setupArt();
    setupTheme();
    setupStates();
    if(!reduce) setupReveal();
    setupGrow();
    setupTransitions();
    setupAura();
    setupBatchBar();
    setupChartTooltip();
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ root.classList.remove('qd-enter'); });
    });
  });
})();
