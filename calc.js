// 清单项目第一个业务模块：四则运算的最小实现。
// shortcut: 只实现 add，其他运算符等真实需求出现再加，别预先铺。

function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    // 不加校验时 '1' + 2 会静默变 '12'，这是真坑，不是防御性代码。
    throw new TypeError('add() expects numbers');
  }
  return a + b;
}

module.exports = { add };
