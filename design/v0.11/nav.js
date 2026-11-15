(function(){
  var NAV=[
    {d:'公共',items:[['workbench','工作台','工作台.html'],['flow','业务全流程图','业务全流程图.html']]},
    {d:'单据与结算',items:[['purchase-orders','采购单 A','采购单A.html'],['processing-orders','加工单 B','加工单B.html'],['sales-orders','销售单 E','销售单E.html'],['internal-trades','内部交易单 N','内部交易单N.html'],['settlements','结算单 C','结算单C.html']]},
    {d:'冲正',items:[['reversals','冲正单据','冲正单据.html']]},
    {d:'主数据',items:[['products','商品资料','商品资料.html'],['customers','客户','客户.html'],['suppliers','供应商','供应商.html'],['processors','加工厂档案','加工厂档案.html']]},
    {d:'库存',items:[['inventory','库存数量','库存.html'],['inventory-flows','库存流水','库存流水.html'],['stocktakes','盘点','盘点.html']]},
    {d:'组织',items:[['employees','员工','员工.html'],['permissions','权限设置','权限设置.html'],['companies','公司管理','公司管理.html']]},
    {d:'报表',items:[['profit-report','利润报表','报表.html']]},
    {d:'系统',items:[['audit-logs','操作日志','操作日志.html'],['api-integration','API 与集成','API与集成.html']]}
  ];
  var ICON='<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
  function render(){
    var host=document.querySelector('.sb-nav'); if(!host) return;
    var cur=document.body.getAttribute('data-nav')||'';
    host.innerHTML=NAV.map(function(g){
      var active=g.items.some(function(it){return it[0]===cur;});
      return '<div class="sb-domain'+(active?' open':'')+'">'+g.d+'</div><div class="sb-group'+(active?' open':'')+'">'+
        g.items.map(function(it){
          return '<a href="'+it[2]+'" class="sb-link'+(it[0]===cur?' on':'')+'">'+ICON+it[1]+'</a>';
        }).join('')+'</div>';
    }).join('');
    host.querySelectorAll('.sb-domain').forEach(function(h){
      h.addEventListener('click',function(){
        h.classList.toggle('open');
        var g=h.nextElementSibling; if(g) g.classList.toggle('open');
      });
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',render); else render();
})();