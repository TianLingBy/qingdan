/* 轻单 v0.13 · 登录页脚本（粒子引擎 + 表单），由 v0.11 内联脚本抽出 */

/* ============================================================
 轻单 v0.13 · 登录页粒子引擎（源自 v0.3 星座）
 纯黑星空：星点统一冷白 / 亮白，不再混入强调色
 ============================================================ */
var cv=document.getElementById('fx');
var ctx=cv.getContext('2d');
var aura=document.getElementById('aura');
var card=document.querySelector('.card');

/* 纯黑星空：星点统一冷白 / 亮白，不再混入强调色 */
var COLD='236,240,248';
var GOLD='250,252,255';
/* v0.6 光点整体提亮 30% */
var GLOW=1.3;
var reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
var W=0,H=0,DPR=1;

var SPR={};
function makeSprite(rgb,core){
 var s=document.createElement('canvas');
 var size=64;s.width=s.height=size;
 var c=s.getContext('2d');
 var g=c.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
 g.addColorStop(0,'rgba('+rgb+','+core+')');
 g.addColorStop(.28,'rgba('+rgb+','+(core*.5)+')');
 g.addColorStop(.62,'rgba('+rgb+','+(core*.12)+')');
 g.addColorStop(1,'rgba('+rgb+',0)');
 c.fillStyle=g;c.beginPath();c.arc(size/2,size/2,size/2,0,Math.PI*2);c.fill();
 return s;
}
function buildSprites(){
 SPR.cold=makeSprite(COLD,1);
 SPR.gold=makeSprite(GOLD,1);
}

var CONSTELLATIONS=[
 {x:.30,y:.245,size:.50,depth:1.0,
 pts:[[.00,.35],[.18,.62],[.38,.55],[.22,.25],[.54,.46],[.72,.30],[.92,.10]],
 links:[[0,1],[1,2],[2,3],[3,0],[2,4],[4,5],[5,6]]},
 {x:.40,y:.780,size:.44,depth:.8,
 pts:[[.26,.06],[.74,.02],[.36,.46],[.50,.48],[.64,.50],[.30,.94],[.70,.88]],
 links:[[0,2],[1,4],[2,3],[3,4],[2,5],[4,6],[0,1]]}
];
var layout=[];var focusIdx=-1;

function layoutConstellations(){
 var base=Math.min(W,H);
 layout=CONSTELLATIONS.map(function(c){
 var size=base*c.size,cx=W*c.x,cy=H*c.y;
 var pts=c.pts.map(function(p){return{x:cx+(p[0]-.5)*size,y:cy+(p[1]-.5)*size};});
 return Object.assign({},c,{cx:cx,cy:cy,size:size,pts:pts});
 });
}

var COUNT=function(){return window.innerWidth<900?240:440;};
var LINK_DIST=90,ATTRACT_R=200,GATHER_R=32,BLOOM_R=140,BLOOM_COOLDOWN=240,BLOOM_DECAY=1100;
var pts=[];

var BLANKS=[
 {x:.25,y:.47,rx:.19,ry:.15},
 {x:.57,y:.48,rx:.09,ry:.28},
 {x:.80,y:.10,rx:.15,ry:.10},
 {x:.10,y:.86,rx:.11,ry:.12},
 {x:.47,y:.86,rx:.10,ry:.10}
];

function spawn(){
 pts.length=0;var n=COUNT();
 var cols=Math.max(1,Math.round(Math.sqrt(n*(W/Math.max(1,H)))));
 var rows=Math.max(1,Math.ceil(n/cols));
 var cw=W/cols,ch=H/rows;var k=0;
 for(var r=0;r<rows&&k<n;r++){
 for(var c=0;c<cols&&k<n;c++,k++){
 var isGold=Math.random()<.12;
 var hx=(c+.5)*cw+(Math.random()-.5)*cw*.66;
 var hy=(r+.5)*ch+(Math.random()-.5)*ch*.66;
 var blank=0;
 for(var b=0;b<BLANKS.length;b++){
 var bk=BLANKS[b];
 var nx=(hx/W-bk.x)/bk.rx,ny=(hy/H-bk.y)/bk.ry;
 var v=Math.exp(-(nx*nx+ny*ny));
 if(v>blank) blank=v;
 }
 if(Math.random()<blank*.95) continue;
 pts.push({x:hx,y:hy,hx:hx,hy:hy,px:0,py:0,
 vx:(Math.random()-.5)*.16,vy:(Math.random()-.5)*.16,
 r:isGold?8+Math.random()*14:1.0+Math.random()*1.8,
 a:isGold?.12+Math.random()*.10:.32+Math.random()*.36,
 gold:isGold,ph:Math.random()*Math.PI*2,
 sp:.4+Math.random()*.8,bl:null});
 }
 }
}

var CELL=LINK_DIST,gridMap=new Map();
function buildGrid(){
 gridMap.clear();
 for(var i=0;i<pts.length;i++){
 var p=pts[i];if(p.gold) continue;
 var key=Math.floor(p.x/CELL)+':'+Math.floor(p.y/CELL);
 var arr=gridMap.get(key);
 if(!arr){arr=[];gridMap.set(key,arr);}
 arr.push(i);
 }
}

var ptr={x:W/2,y:H/2,tx:W/2,ty:H/2,down:false,inside:false,spd:0,anchor:{x:W/2,y:H/2}};
var prevCursor={x:W/2,y:H/2},lastBloom=0,releaseAt=0;
var parallax={x:0,y:0,tx:0,ty:0},paused=false;

addEventListener('pointermove',function(e){
 ptr.tx=e.clientX;ptr.ty=e.clientY;
 if(!ptr.inside){ptr.inside=true;document.body.classList.add('has-pointer');}
 parallax.tx=(e.clientX/W-.5)*2;parallax.ty=(e.clientY/H-.5)*2;
 aura.style.left=e.clientX+'px';aura.style.top=e.clientY+'px';
},{passive:true});
addEventListener('pointerdown',function(e){
 if(e.target.closest('.card,.panel')) return;
 ptr.down=true;
 for(var i=0;i<pts.length;i++){
 var p=pts[i];var dx=p.x-e.clientX,dy=p.y-e.clientY;
 var d=Math.hypot(dx,dy)||1;
 if(d<300){var f=(1-d/300)*7;p.vx+=dx/d*f;p.vy+=dy/d*f;}
 }
});
addEventListener('pointerup',function(){ptr.down=false;});
addEventListener('pointerleave',function(){
 if(!reduce) bloom(ptr.x,ptr.y,1.1);
 ptr.inside=false;ptr.spd=0;document.body.classList.remove('has-pointer');
});
addEventListener('visibilitychange',function(){paused=document.hidden;});

function bloom(cx,cy,power){
 var now=performance.now();
 for(var i=0;i<pts.length;i++){
 var p=pts[i];var dx=p.x-cx,dy=p.y-cy;
 var d=Math.hypot(dx,dy)||1;
 if(d>BLOOM_R) continue;
 var f=(1-d/BLOOM_R)*power;if(f<.05) continue;
 p.bl={t0:now+d*.95,ax:dx/d,ay:dy/d,f:f};
 }
}

var T=0;
function tick(t){
 if(paused){if(!reduce) requestAnimationFrame(tick);return;}
 T=t;
 var dt=Math.max(1,Math.min(48,t-(tick._last||t)));tick._last=t;
 ptr.x+=(ptr.tx-ptr.x)*.10;ptr.y+=(ptr.ty-ptr.y)*.10;
 parallax.x+=(parallax.tx-parallax.x)*.05;parallax.y+=(parallax.ty-parallax.y)*.05;
 var ox=parallax.x*14,oy=parallax.y*10;
 var instSpd=Math.hypot(ptr.tx-prevCursor.x,ptr.ty-prevCursor.y)/dt;
 ptr.spd+=(instSpd-ptr.spd)*.3;prevCursor.x=ptr.tx;prevCursor.y=ptr.ty;
 if(!reduce&&ptr.inside){
 if(ptr.spd>1.15&&t-lastBloom>BLOOM_COOLDOWN){
 bloom(ptr.anchor.x,ptr.anchor.y,Math.min(1.2,ptr.spd*.4));
 lastBloom=t;ptr.anchor.x=ptr.x;ptr.anchor.y=ptr.y;
 } else if(ptr.spd<.35){
 ptr.anchor.x+=(ptr.x-ptr.anchor.x)*.07;ptr.anchor.y+=(ptr.y-ptr.anchor.y)*.07;
 }
 }
 ctx.clearRect(0,0,W,H);
 focusIdx=-1;var bestD=1e9;
 layout.forEach(function(c,i){
 var d=Math.hypot(c.cx+ox*c.depth-ptr.x,c.cy+oy*c.depth-ptr.y);
 if(d<c.size*.95&&d<bestD){bestD=d;focusIdx=i;}
 });
 drawConstellations(ox,oy);
 for(var i=0;i<pts.length;i++){
 var p=pts[i];p.px=p.x;p.py=p.y;
 if(!reduce&&ptr.inside){
 var dx=ptr.x-p.x,dy=ptr.y-p.y;var d=Math.hypot(dx,dy)||1;
 var ux=dx/d,uy=dy/d;var fast=ptr.spd>.85;
 if(!fast&&d<ATTRACT_R){
 var k=(1-d/ATTRACT_R);var f=k*(ptr.down?.85:.45);
 p.vx+=ux*f;p.vy+=uy*f;
 if(d<GATHER_R){p.gatherT=(p.gatherT||0)+dt;p.vx*=.84;p.vy*=.84;}
 else{p.gatherT=(p.gatherT||0)*.96;}
 } else if(fast&&d<ATTRACT_R){
 var f=Math.min(1.4,ptr.spd*.40)*(1-d/ATTRACT_R);
 p.vx-=ux*f;p.vy-=uy*f;p.gatherT=(p.gatherT||0)*.6;
 }
 }
 p.vx*=.968;p.vy*=.968;
 p.vx+=(Math.random()-.5)*.008;p.vy+=(Math.random()-.5)*.008;
 p.vx+=(p.hx-p.x)*.0026;p.vy+=(p.hy-p.y)*.0026;
 if(p.bl){
 var age=t-p.bl.t0;
 if(age>=0){var kk=1-age/BLOOM_DECAY;if(kk<=0){p.bl=null;}else{p.vx+=p.bl.ax*p.bl.f*kk*.052;p.vy+=p.bl.ay*p.bl.f*kk*.052;}}
 }
 var sp=Math.hypot(p.vx,p.vy);if(sp>4.6){p.vx=p.vx/sp*4.6;p.vy=p.vy/sp*4.6;}
 p.x+=p.vx;p.y+=p.vy;
 if(p.x<0){p.x=0;p.vx=Math.abs(p.vx)*.55;}else if(p.x>W){p.x=W;p.vx=-Math.abs(p.vx)*.55;}
 if(p.y<0){p.y=0;p.vy=Math.abs(p.vy)*.55;}else if(p.y>H){p.y=H;p.vy=-Math.abs(p.vy)*.55;}
 }
 if(!reduce&&ptr.inside&&t>releaseAt){
 var gathered=0;for(var i=0;i<pts.length;i++) if((pts[i].gatherT||0)>160) gathered++;
 if(gathered>18){bloom(ptr.x,ptr.y,1.05+Math.min(.7,gathered/40));for(var i=0;i<pts.length;i++) pts[i].gatherT=0;releaseAt=t+1000;}
 }
 buildGrid();ctx.lineWidth=1;
 var linkAlpha=(focusIdx>=0?.08:.12)*GLOW;
 for(var i=0;i<pts.length;i++){
 var a=pts[i];if(a.gold) continue;
 var cx=Math.floor(a.x/CELL),cy2=Math.floor(a.y/CELL);
 for(var gx=cx-1;gx<=cx+1;gx++){
 for(var gy=cy2-1;gy<=cy2+1;gy++){
 var arr=gridMap.get(gx+':'+gy);if(!arr) continue;
 for(var j=0;j<arr.length;j++){
 var ji=arr[j];if(ji<=i) continue;
 var b=pts[ji];var dx2=a.x-b.x,dy2=a.y-b.y;
 var dist=Math.hypot(dx2,dy2);if(dist>LINK_DIST) continue;
 var alpha=(1-dist/LINK_DIST)*linkAlpha;
 ctx.strokeStyle='rgba('+COLD+','+alpha.toFixed(3)+')';
 ctx.beginPath();ctx.moveTo(a.x+ox,a.y+oy);ctx.lineTo(b.x+ox,b.y+oy);ctx.stroke();
 }
 }
 }
 }
 if(ptr.down){
 for(var i=0;i<pts.length;i++){
 var p=pts[i];var vx=p.x-p.px,vy=p.y-p.py;
 var speed=Math.hypot(vx,vy);
 if(speed>.7){
 ctx.strokeStyle='rgba('+(p.gold?GOLD:COLD)+','+Math.min(.28,speed*.06).toFixed(3)+')';
 ctx.beginPath();ctx.moveTo(p.px+ox,p.py+oy);ctx.lineTo(p.x+ox,p.y+oy);ctx.stroke();
 }
 }
 }
 for(var i=0;i<pts.length;i++){
 var p=pts[i];
 var breathe=.82+Math.sin(t*.001*p.sp+p.ph)*.18;
 var x=p.x+ox,y=p.y+oy,rr=p.r*breathe;
 ctx.globalAlpha=Math.min(1,p.a*breathe*GLOW);
 ctx.drawImage(p.gold?SPR.gold:SPR.cold,x-rr,y-rr,rr*2,rr*2);
 }
 ctx.globalAlpha=1;
 if(!reduce){
 card.style.transform='translate3d('+(parallax.x*-3).toFixed(2)+'px,'+(parallax.y*-2.5).toFixed(2)+'px,0)';
 requestAnimationFrame(tick);
 }
}

function drawConstellations(ox,oy){
 layout.forEach(function(c,ci){
 var focused=focusIdx===ci,anyFocus=focusIdx>=0,k=c.depth;
 var swayX=Math.sin(T*.00008+ci*1.7)*5,swayY=Math.cos(T*.00006+ci*2.3)*4;
 var dx=ox*k+swayX,dy=oy*k+swayY;
 var lineA=(focused?.36:(anyFocus?.07:.16))*GLOW;
 var starBoost=focused?1.5:1;
 ctx.lineWidth=focused?1.2:1;
 ctx.strokeStyle='rgba('+COLD+','+lineA+')';
 ctx.beginPath();
 c.links.forEach(function(l){
 var a=c.pts[l[0]],b=c.pts[l[1]];if(!a||!b) return;
 ctx.moveTo(a.x+dx,a.y+dy);ctx.lineTo(b.x+dx,b.y+dy);
 });
 ctx.stroke();
 c.pts.forEach(function(p,pi){
 var tw=.75+Math.sin(T*.0012+pi*1.9+ci)*.25;
 var r=(1.6+(pi%3)*.7)*starBoost*tw;
 var x=p.x+dx,y=p.y+dy;
 ctx.globalAlpha=Math.min(1,(focused?.95:(anyFocus?.32:.7))*tw*GLOW);
 ctx.drawImage(SPR.cold,x-r*2,y-r*2,r*4,r*4);
 ctx.globalAlpha=Math.min(1,(focused?1:(anyFocus?.4:.85))*GLOW);
 ctx.fillStyle='rgba('+COLD+',.95)';
 ctx.beginPath();ctx.arc(x,y,Math.max(.7,r*.28),0,Math.PI*2);ctx.fill();
 ctx.globalAlpha=1;
 });
 });
}

function resize(){
 DPR=Math.min(2,window.devicePixelRatio||1);
 W=window.innerWidth;H=window.innerHeight;
 cv.width=Math.floor(W*DPR);cv.height=Math.floor(H*DPR);
 cv.style.width=W+'px';cv.style.height=H+'px';
 ctx.setTransform(DPR,0,0,DPR,0,0);
 buildSprites();spawn();layoutConstellations();
}
addEventListener('resize',function(){resize();if(reduce) tick(performance.now());});
resize();requestAnimationFrame(tick);
/* v0.12：删除 qd-theme-change 监听——四套配色已废弃，且切换亮暗时
   由 modeFab 触发 location.search 重载，粒子引擎会随页面重新初始化。 */

/* ---- 登录表单 ---- */
var form=document.getElementById('form');
var submit=document.getElementById('submit');
var toast=document.getElementById('toast');
var root=document.documentElement;

function showToast(msg){
 toast.textContent=msg;toast.classList.add('on');
 clearTimeout(showToast._h);
 showToast._h=setTimeout(function(){toast.classList.remove('on');},2400);
}
function markField(id,invalid){
 document.getElementById(id).classList.toggle('invalid',invalid);return !invalid;
}
form.addEventListener('submit',function(e){
 e.preventDefault();
 var phone=document.getElementById('phone').value.trim();
 var code=document.getElementById('code').value.trim();
 var okPhone=markField('f-phone',!/^\d{11}$/.test(phone));
 var okCode=markField('f-code',code.length===0);
 if(!okPhone||!okCode) return;
 submit.classList.add('is-loading');
 submit.querySelector('.label').textContent='验证中…';
 setTimeout(function(){
 submit.querySelector('.label').textContent='进入工作台';
 if(!reduce){
 card.animate(
 [{transform:'scale(1)'},{transform:'scale(1.008)'},{transform:'scale(1)'}],
 {duration:400,easing:'cubic-bezier(.16,1,.3,1)'}
 );
 }
 /* v0.12：原「转场幕」.qd-veil 元素早已不存在，qd-leave 只造成 190ms 空等。
    改为等卡片确认动画（400ms）结束后直接跳转；reduced-motion 下立即跳转。 */
 setTimeout(function(){location.href='工作台.html';},reduce?0:420);
 },900);
});
document.getElementById('phone').addEventListener('input',function(e){
 e.target.value=e.target.value.replace(/\D/g,'').slice(0,11);
 if(e.target.value.length===11) document.getElementById('f-phone').classList.remove('invalid');
});
document.getElementById('code').addEventListener('input',function(e){
 e.target.value=e.target.value.replace(/\D/g,'').slice(0,6);
 if(e.target.value) document.getElementById('f-code').classList.remove('invalid');
});
document.getElementById('help').addEventListener('click',function(e){
 e.preventDefault();showToast('一期不发短信 忘记密码请联系管理员重置');
});
addEventListener('keydown',function(e){
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.getElementById('phone').focus();}
 if(e.key==='Escape'){
 document.getElementById('f-phone').classList.remove('invalid');
 document.getElementById('f-code').classList.remove('invalid');
 }
});


(function(){
 var b=document.getElementById('send'); if(!b) return;
 var n=60,t=null;
 b.addEventListener('click',function(){
 b.disabled=true; b.textContent=n+' 秒后重发';
 t=setInterval(function(){
 n--;
 if(n<=0){clearInterval(t);b.disabled=false;b.textContent='获取验证码';n=60;}
 else b.textContent=n+' 秒后重发';
 },1000);
 });
})();


/* ---- 右下角暗亮开关：与内页共用 qd-mode，暗夜=磨砂玻璃卡，亮色=白底黑字卡 ---- */
(function(){
 var q=new URLSearchParams(location.search);
 var saved=null;
 try{saved=localStorage.getItem('qd-mode');}catch(e){}
 var mode=q.get('mode')||saved||'dark';
 var tgl=document.getElementById('mode-tgl');
 function apply(m){
  document.documentElement.setAttribute('data-mode',m);
  if(!tgl) return;
  tgl.querySelectorAll('[data-mode-set]').forEach(function(b){
   b.classList.toggle('on',b.dataset.modeSet===m);
  });
 }
 apply(mode);
 if(!tgl) return;
 tgl.addEventListener('click',function(e){
  var b=e.target.closest('[data-mode-set]');if(!b) return;
  mode=b.dataset.modeSet;
  try{localStorage.setItem('qd-mode',mode);}catch(err){}
  apply(mode);
 });
})();
