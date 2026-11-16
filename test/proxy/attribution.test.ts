import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  extractConversationSteps,
  hashSteps,
  matchLoop,
  mergeMessageTimes,
  TAIL_WINDOW_MS,
  type LoopCandidate,
} from '../../src/proxy/attribution.js'

const NOW = 1_700_000_000_000

function candidate(partial: Partial<LoopCandidate> & { pairId: number }): LoopCandidate {
  return {
    terminalHash: null,
    tailHash: null,
    source: 'proxy',
    lastActiveAt: NOW,
    ...partial,
  }
}

/** 构造一轮 OpenAI 风格请求体：system + user (+ 上一轮 assistant/tool) */
function openaiTurn(userTexts: string[], opts?: { system?: string; assistantText?: string }): Record<string, unknown> {
  const messages: unknown[] = []
  messages.push({ role: 'system', content: opts?.system ?? '你是助手' })
  for (const t of userTexts) messages.push({ role: 'user', content: t })
  if (opts?.assistantText) messages.push({ role: 'assistant', content: opts.assistantText })
  return { model: 'gpt-x', messages }
}

describe('proxy/attribution extractConversationSteps', () => {
  it('openai messages：system/user/assistant/tool 各成一条', () => {
    const body = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"f":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
      ],
    }
    const steps = extractConversationSteps(body)
    assert.strictEqual(steps.length, 4)
    assert.deepStrictEqual(
      steps.map((s) => s.kind),
      ['message', 'message', 'tool-call', 'tool-result'],
    )
    assert.strictEqual(steps[2].toolName, 'read')
    assert.strictEqual(steps[3].toolCallId, 'c1')
  })

  it('anthropic：顶层 system 字符串 + messages', () => {
    const body = {
      system: 'be nice',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
      ],
    }
    const steps = extractConversationSteps(body)
    assert.strictEqual(steps.length, 3)
    assert.strictEqual(steps[0].role, 'system')
    assert.strictEqual(steps[1].text, 'hi')
    // anthropic 的 tool_use 内容块与前端账本同粒度：整条 assistant 消息算一个
    // message step（tool_use 块无文本键 → 空文本），哈希靠后续消息区分
    assert.strictEqual(steps[2].kind, 'message')
    assert.strictEqual(steps[2].text, '')
  })

  it('openai-responses：instructions + input 数组（function_call/output/reasoning）', () => {
    const body = {
      instructions: 'resp sys',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
        { type: 'function_call', name: 'grep', arguments: '{"p":"x"}', call_id: 'call_1' },
        { type: 'function_call_output', call_id: 'call_1', output: '结果' },
      ],
    }
    const steps = extractConversationSteps(body)
    assert.strictEqual(steps.length, 5)
    assert.strictEqual(steps[0].role, 'system')
    assert.deepStrictEqual(
      steps.slice(1).map((s) => s.kind),
      ['message', 'thinking', 'tool-call', 'tool-result'],
    )
    assert.strictEqual(steps[3].toolName, 'grep')
    assert.strictEqual(steps[4].toolCallId, 'call_1')
  })

  it('input 字符串算一条 user 消息', () => {
    const steps = extractConversationSteps({ input: 'plain' })
    assert.strictEqual(steps.length, 1)
    assert.strictEqual(steps[0].role, 'user')
    assert.strictEqual(steps[0].text, 'plain')
  })

  it('图片块用占位符参与文本，不哈希字节', () => {
    const img = (n: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${n}` } })
    const steps = extractConversationSteps({
      messages: [{ role: 'user', content: [img('AAA'), { type: 'text', text: '看图' }] }],
    })
    assert.strictEqual(steps.length, 1)
    assert.strictEqual(steps[0].text, '[图片]\n看图')
  })

  it('无消息 / 非对象输入返回空数组', () => {
    assert.strictEqual(extractConversationSteps({ model: 'x' }).length, 0)
    assert.strictEqual(extractConversationSteps(null).length, 0)
    assert.strictEqual(extractConversationSteps('str').length, 0)
  })
})

describe('proxy/attribution hashSteps + matchLoop', () => {
  it('同序列哈希一致，序列不同哈希不同', () => {
    const a = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    const b = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    const c = hashSteps(extractConversationSteps(openaiTurn(['ho'])))
    assert.strictEqual(a.terminalHash, b.terminalHash)
    assert.notStrictEqual(a.terminalHash, c.terminalHash)
  })

  it('前缀链性质：第 2 轮的 prefixHashes 包含第 1 轮的 terminalHash', () => {
    const t1 = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    const t2Body = openaiTurn(['hi'], { assistantText: '回答' })
    ;(t2Body.messages as unknown[]).push({ role: 'user', content: '下一问' })
    const t2 = hashSteps(extractConversationSteps(t2Body))
    assert.ok(t2.prefixHashes.includes(t1.terminalHash!))
    assert.notStrictEqual(t2.terminalHash, t1.terminalHash)
  })

  it('前缀规则：第 2 轮命中第 1 轮 loop', () => {
    const t1 = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    const t2Body = openaiTurn(['hi'], { assistantText: '回答' })
    ;(t2Body.messages as unknown[]).push({ role: 'user', content: '下一问' })
    const t2 = hashSteps(extractConversationSteps(t2Body))
    const m = matchLoop(t2, [candidate({ pairId: 1, terminalHash: t1.terminalHash, tailHash: t1.tailHash })], {
      source: 'proxy',
      now: NOW,
    })
    assert.ok(m)
    assert.strictEqual(m.pairId, 1)
    assert.strictEqual(m.rule, 'prefix')
    assert.strictEqual(m.matchedSteps, 2)
    assert.strictEqual(m.retry, false)
  })

  it('同轮重试：完整消息序列一致 → retry=true', () => {
    const t1 = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    const m = matchLoop(t1, [candidate({ pairId: 7, terminalHash: t1.terminalHash, tailHash: t1.tailHash })], {
      source: 'proxy',
      now: NOW,
    })
    assert.ok(m)
    assert.strictEqual(m.retry, true)
    assert.strictEqual(m.matchedSteps, 2)
  })

  it('多个候选时取匹配位置最深者', () => {
    const b1 = openaiTurn(['hi'])
    const h1 = hashSteps(extractConversationSteps(b1))
    const b2 = structuredClone(b1)
    ;(b2.messages as unknown[]).push({ role: 'assistant', content: '答' }, { role: 'user', content: '再问' })
    const h2 = hashSteps(extractConversationSteps(b2))
    const b3 = structuredClone(b2)
    ;(b3.messages as unknown[]).push({ role: 'assistant', content: '答2' }, { role: 'user', content: '三问' })
    const h3 = hashSteps(extractConversationSteps(b3))
    const m = matchLoop(
      h3,
      [
        candidate({ pairId: 1, terminalHash: h1.terminalHash, tailHash: h1.tailHash }),
        candidate({ pairId: 2, terminalHash: h2.terminalHash, tailHash: h2.tailHash }),
      ],
      { source: 'proxy', now: NOW },
    )
    assert.strictEqual(m!.pairId, 2)
    assert.strictEqual(m!.matchedSteps, 4)
  })

  it('tail 兜底：上下文压缩后前缀断裂但末尾保留 → 命中', () => {
    const b1 = openaiTurn(['长任务开始'])
    for (let i = 0; i < 5; i++) {
      ;(b1.messages as unknown[]).push({ role: 'assistant', content: `答${i}` }, { role: 'user', content: `问${i}` })
    }
    const h1 = hashSteps(extractConversationSteps(b1))
    // 压缩后：全新 summary 前缀 + 末尾 3 条原样保留
    const compacted = {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '[压缩摘要] 之前的对话概要' },
        ...(b1.messages as unknown[]).slice(-3),
      ],
    }
    const h2 = hashSteps(extractConversationSteps(compacted))
    const m = matchLoop(
      h2,
      [candidate({ pairId: 9, terminalHash: h1.terminalHash, tailHash: h1.tailHash, lastActiveAt: NOW })],
      { source: 'proxy', now: NOW + 1000 },
    )
    assert.ok(m)
    assert.strictEqual(m.pairId, 9)
    assert.strictEqual(m.rule, 'tail')
    assert.strictEqual(m.matchedSteps, 0)
    assert.strictEqual(m.retry, false)
  })

  it('tail 兜底：活跃窗口外 / source 不同 / 短对话不启用', () => {
    const b1 = openaiTurn(['长任务开始'])
    for (let i = 0; i < 5; i++) {
      ;(b1.messages as unknown[]).push({ role: 'assistant', content: `答${i}` }, { role: 'user', content: `问${i}` })
    }
    const h1 = hashSteps(extractConversationSteps(b1))
    const cand = candidate({ pairId: 9, terminalHash: h1.terminalHash, tailHash: h1.tailHash })

    const compacted = {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '[压缩摘要]' },
        ...(b1.messages as unknown[]).slice(-3),
      ],
    }
    const h2 = hashSteps(extractConversationSteps(compacted))

    assert.strictEqual(
      matchLoop(h2, [candidate({ ...cand, lastActiveAt: NOW - TAIL_WINDOW_MS - 1 })], { source: 'proxy', now: NOW })?.pairId ?? null,
      null,
    )
    assert.strictEqual(
      matchLoop(h2, [{ ...cand }], { source: 'adapter-x', now: NOW })?.pairId ?? null,
      null,
    )

    // 短对话（≤3 条）不启用 tail 规则
    const short = hashSteps(extractConversationSteps(openaiTurn(['hi'], { system: '变了' })))
    assert.strictEqual(
      matchLoop(short, [candidate({ pairId: 3, terminalHash: 'other', tailHash: short.tailHash })], { source: 'proxy', now: NOW })?.pairId ?? null,
      null,
    )
  })

  it('无候选 / 无消息时返回 null', () => {
    const h = hashSteps(extractConversationSteps(openaiTurn(['hi'])))
    assert.strictEqual(matchLoop(h, [], { source: 'proxy', now: NOW }), null)
    assert.strictEqual(matchLoop({ prefixHashes: [], terminalHash: null, tailHash: null }, [candidate({ pairId: 1 })], { source: 'proxy', now: NOW }), null)
  })
})

describe('proxy/attribution mergeMessageTimes', () => {
  it('前缀规则：匹配段继承旧时间，其余盖新时间', () => {
    const times = mergeMessageTimes([111, 222], { pairId: 1, matchedSteps: 2, retry: false, rule: 'prefix' }, 999, 4)
    assert.deepStrictEqual(times, [111, 222, 999, 999])
  })

  it('tail 规则 / 新 loop：全部盖新时间', () => {
    assert.deepStrictEqual(
      mergeMessageTimes([111, 222], { pairId: 1, matchedSteps: 0, retry: false, rule: 'tail' }, 999, 2),
      [999, 999],
    )
    assert.deepStrictEqual(mergeMessageTimes([], null, 999, 3), [999, 999, 999])
  })

  it('重试：全部继承旧时间', () => {
    const times = mergeMessageTimes([111, 222], { pairId: 1, matchedSteps: 2, retry: true, rule: 'prefix' }, 999, 2)
    assert.deepStrictEqual(times, [111, 222])
  })
})
