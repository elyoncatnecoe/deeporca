import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractClassNameExpressions,
  scanClassNames,
  scanCode,
  stripComments,
} from './css-audit-lib.ts'

/**
 * className 守卫的解析层测试（审查意见 P2 第 1~5 条）。
 *
 * 这些都是「拿具体输入跑一遍」的用例，不是对整棵源码树做结构断言：
 * CRLF、注释、字符串里的示例、重复表达式的行号、模板串前后缀，
 * 每一条都得有实际输入才算验证过。
 */

/* ------------------------------------------------------------------ */
/* P2-5：CRLF 的注释处理                                                */
/* ------------------------------------------------------------------ */

test('P2-5：CRLF 源码里的行注释照样剥得掉', () => {
  const crlf = [
    'const a = 1',
    '// className="ghost" 这是注释里的示例',
    'const b = 2',
    '',
  ].join('\r\n')
  const stripped = stripComments(crlf)
  assert.ok(!stripped.includes('className'), 'CRLF 行尾的 \\r 不该让注释整行漏掉')
  assert.ok(stripped.includes('const a = 1') && stripped.includes('const b = 2'), '代码本身要留着')
})

test('P2-5：剥注释不改变长度，也不吃换行（行号还能对回原文）', () => {
  const text = 'x\r\n// 注释\r\ny'
  const stripped = stripComments(text)
  assert.equal(stripped.length, text.length, '长度必须不变')
  assert.equal((stripped.match(/\n/g) ?? []).length, 2, '换行必须原样保留')
})

test('P2-5：块注释里的 className 不算数', () => {
  const text = '/*\n * 示例：className="ghost"\n */\n<div className="real" />'
  const found = extractClassNameExpressions(text)
  assert.deepEqual(found.map((item) => item.raw), ['"real"'])
})

/* ------------------------------------------------------------------ */
/* P2-3：字符串里的示例不算 JSX 属性                                    */
/* ------------------------------------------------------------------ */

test('P2-3：字符串字面量里的 className 不算数', () => {
  const text = [
    'const html = \'<div className="ghost">x</div>\'',
    'const tpl = `<span className="ghost2"></span>`',
    '<div className="real" />',
  ].join('\n')
  const found = extractClassNameExpressions(text)
  assert.deepEqual(found.map((item) => item.raw), ['"real"'], '只有真 JSX 属性才该被统计')
})

test('P2-3：真正的 className 不会被误跳过', () => {
  const text = 'const a = `x`\n<div className="real" />\nconst b = \'y\''
  assert.deepEqual(extractClassNameExpressions(text).map((item) => item.raw), ['"real"'])
})

/* ------------------------------------------------------------------ */
/* P2-4：重复表达式的行号                                               */
/* ------------------------------------------------------------------ */

test('P2-4：同一个表达式出现两次，行号各算各的', () => {
  const text = [
    '<a className="dup" />',
    '',
    '',
    '<b className="dup" />',
  ].join('\n')
  const found = extractClassNameExpressions(text)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((item) => item.line), [1, 4], '第二处不许被算成第 1 行')
  assert.notEqual(found[0].index, found[1].index, '偏移也要各不相同')
})

test('P2-4：大括号表达式里的重复内容也按各自位置定位', () => {
  const text = [
    '<a className={`item ${on ? \'is-on\' : \'\'}`} />',
    '<b className={`item ${on ? \'is-on\' : \'\'}`} />',
  ].join('\n')
  const found = extractClassNameExpressions(text)
  assert.deepEqual(found.map((item) => item.line), [1, 2])
})

/* ------------------------------------------------------------------ */
/* P2-1：模板串的前缀与后缀                                             */
/* ------------------------------------------------------------------ */

test('P2-1：tier-${level} 解析成前缀', () => {
  const scan = scanClassNames('{`tier-${level}`}')
  assert.deepEqual(scan.prefixes, ['tier-'])
  assert.deepEqual(scan.suffixes, [])
  assert.deepEqual(scan.static, [])
  assert.equal(scan.unresolved, false)
})

test('P2-1：tier-${level}-active 前后缀都要解析出来', () => {
  const scan = scanClassNames('{`tier-${level}-active`}')
  assert.deepEqual(scan.prefixes, ['tier-'])
  assert.deepEqual(scan.suffixes, ['-active'])
  assert.equal(scan.unresolved, false, '前后缀都能归约，就不算「无法解析」')
})

test('P2-1：前缀片段旁边的完整类名仍然是静态类名', () => {
  const scan = scanClassNames('{`item gap-${size}`}')
  assert.deepEqual(scan.static, ['item'])
  assert.deepEqual(scan.prefixes, ['gap-'])
})

test('P2-1：模板插值里的字符串也会被算进来', () => {
  const scan = scanClassNames("{`item ${on ? 'is-on' : ''}`}")
  assert.deepEqual([...scan.static].sort(), ['is-on', 'item'], '片段里的 item 和插值里的 is-on 都要算')
  assert.deepEqual(scan.prefixes, [])
})

/* ------------------------------------------------------------------ */
/* P2-2：判断不了的动态表达式必须暴露，不能静默跳过                      */
/* ------------------------------------------------------------------ */

test('P2-2：`${a}-${b}` 这种中间片段标记为无法解析', () => {
  const scan = scanClassNames('{`${a}-${b}`}')
  assert.equal(scan.unresolved, true, '中间片段判断不了，必须置 unresolved 让上层报出来')
})

test('P2-2：完全由变量拼成的 className 也要暴露', () => {
  const scan = scanClassNames('{`${name}`}')
  assert.equal(scan.unresolved, true)
  assert.deepEqual(scan.static, [])
})

test('P2-2：三元里的比较值不是类名', () => {
  const scan = scanClassNames("{mode === 'group' ? 'is-group' : ''}")
  assert.deepEqual(scan.static, ['is-group'], "比较值 'group' 不该被当成类名")
})

/* ------------------------------------------------------------------ */
/* 二审 P2：一个字符串都提不出来的表达式，不许「扫了个空 = 通过」          */
/* ------------------------------------------------------------------ */

test('二审 P2：className={buttonClass} 判为无法解析', () => {
  const scan = scanClassNames('{buttonClass}')
  assert.equal(scan.unresolved, true, '一个字符串都提不出来，不能当成没问题')
  assert.deepEqual(scan.static, [])
})

test('二审 P2：className={getButtonClass()} 判为无法解析', () => {
  const scan = scanClassNames('{getButtonClass()}')
  assert.equal(scan.unresolved, true, '函数调用返回什么类名，静态分析不知道')
  assert.deepEqual(scan.static, [])
})

test('二审 P2：className={props.className} 判为无法解析', () => {
  const scan = scanClassNames('{props.className}')
  assert.equal(scan.unresolved, true)
})

test('二审 P2：三元里混着成员访问 —— 静态分支照查，动态那半边报 unresolved', () => {
  const scan = scanClassNames("{condition ? styles.active : 'normal'}")
  assert.deepEqual(scan.static, ['normal'], '能确认的静态分支仍然要提取并检查')
  assert.equal(scan.unresolved, true, "styles.active 拼出什么，静态分析不知道")
})

test('二审 P2：纯静态的三元不报 unresolved（条件本身不是类名）', () => {
  const scan = scanClassNames("{condition ? 'active' : 'normal'}")
  assert.deepEqual([...scan.static].sort(), ['active', 'normal'])
  assert.equal(scan.unresolved, false)
})

test('二审 P2：布尔守卫（cond && 字面量）不算动态残留', () => {
  const scan = scanClassNames("{on && 'is-on'}")
  assert.deepEqual(scan.static, ['is-on'])
  assert.equal(scan.unresolved, false, 'on 产出的是布尔值，不是类名')
})

test('二审 P2：报告能给出文件、行号和原始表达式', () => {
  const text = [
    '<a className="ok" />',
    '<b className={buttonClass} />',
    '',
    '<c className={getButtonClass()} />',
    '<d className={condition ? styles.active : \'normal\'} />',
  ].join('\n')
  const bad = extractClassNameExpressions(text)
    .map((item) => ({ item, scan: scanClassNames(item.raw) }))
    .filter((entry) => entry.scan.unresolved)

  assert.deepEqual(bad.map((entry) => entry.item.line), [2, 4, 5], '行号要对得上')
  assert.deepEqual(bad.map((entry) => entry.item.raw), [
    '{buttonClass}',
    '{getButtonClass()}',
    "{condition ? styles.active : 'normal'}",
  ], '原文要能直接贴出来给人看')
})

/* ------------------------------------------------------------------ */
/* 扫描器本身                                                          */
/* ------------------------------------------------------------------ */

test('扫描器能区分注释与字符串，且区间不重叠到代码上', () => {
  const text = 'a // b\nc /* d */ e'
  const scan = scanCode(text)
  assert.equal(scan.comments.length, 2)
  const lineComment = scan.comments[0]
  assert.equal(text.slice(lineComment[0], lineComment[1]), '// b')
  const blockComment = scan.comments[1]
  assert.equal(text.slice(blockComment[0], blockComment[1]), '/* d */')
})

test('扫描器不会把正则里的 // 当成行注释', () => {
  const text = 'const re = /\\/\\//g\n<div className="real" />'
  const scan = scanCode(text)
  assert.deepEqual(scan.comments, [], '正则字面量里的 // 不是注释')
  assert.deepEqual(extractClassNameExpressions(text).map((item) => item.raw), ['"real"'])
})
