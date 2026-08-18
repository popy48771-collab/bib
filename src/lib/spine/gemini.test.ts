import { describe, expect, it } from 'vitest'
import { extractedSpinesFromGemini, interactionOutputText } from './gemini'

describe('extractedSpinesFromGemini', () => {
  it('外部JSONを検査し、画像の左から右へ並べる', () => {
    const spines = extractedSpinesFromGemini({
      spines: [
        {
          box_2d: [20, 600, 980, 720],
          raw_visible_text: '吾輩は猫である\n夏目漱石',
          title: '吾輩は猫である',
          authors: ['夏目漱石'],
          publisher: '',
          confidence: 0.91,
        },
        {
          box_2d: [10, 100, 990, 240],
          raw_visible_text: '思考の整理学\n外山滋比古\nちくま文庫',
          title: '思考の整理学',
          authors: ['外山滋比古'],
          publisher: 'ちくま文庫',
          confidence: 0.87,
        },
      ],
    })

    expect(spines).toHaveLength(2)
    expect(spines[0]).toMatchObject({
      title: '思考の整理学',
      authors: ['外山滋比古'],
      publisher: 'ちくま文庫',
      engine: 'remoteVision',
      box: { x: 0.1, y: 0.01, height: 0.98 },
    })
    expect(spines[0].box?.width).toBeCloseTo(0.14)
    expect(spines[1].fragments?.map((fragment) => fragment.text)).toEqual([
      '吾輩は猫である',
      '夏目漱石',
    ])
  })

  it('書名が空なら見えている文字を使い、壊れた項目だけを落とす', () => {
    const spines = extractedSpinesFromGemini({
      spines: [
        {
          box_2d: [-20, 50, 1020, 200],
          raw_visible_text: '文化政策の現在',
          title: '',
          authors: '著者ではない配列',
          publisher: null,
          confidence: 2,
        },
        {
          box_2d: [0, 300, 0, 400],
          raw_visible_text: '高さがない枠',
          title: '無効',
          authors: [],
          publisher: '',
          confidence: 0.5,
        },
      ],
    })

    expect(spines).toHaveLength(1)
    expect(spines[0]).toMatchObject({
      title: '文化政策の現在',
      authors: [],
      confidence: 1,
      box: { x: 0.05, y: 0, height: 1 },
    })
    expect(spines[0].box?.width).toBeCloseTo(0.15)
  })

  it('想定外の応答は空配列にする', () => {
    expect(extractedSpinesFromGemini(null)).toEqual([])
    expect(extractedSpinesFromGemini({ spines: 'not-an-array' })).toEqual([])
  })
})

describe('interactionOutputText', () => {
  it('Interactions REST の model_output からJSON本文を取り出す', () => {
    expect(
      interactionOutputText({
        status: 'completed',
        steps: [
          { type: 'user_input', content: [] },
          {
            type: 'model_output',
            content: [{ type: 'text', text: '{"spines":[]}' }],
          },
        ],
      }),
    ).toBe('{"spines":[]}')
  })

  it('本文のない応答は null', () => {
    expect(interactionOutputText({ status: 'failed', steps: [] })).toBeNull()
  })
})
