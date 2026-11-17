import { describe, expect, test } from 'bun:test'
import { isToolFollowup } from './integration/mock-provider'

const call = { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mexplore', arguments: '{}' } }] }
const result = { role: 'tool', tool_call_id: 'call-1', content: 'no record' }

describe('mock tool follow-up detection', () => {
  test('a new request has no tool result', () => {
    expect(isToolFollowup({ messages: [{ role: 'system' }, { role: 'user', content: 'recall' }] })).toBe(false)
  })

  test('a tool result directly follows an assistant call', () => {
    expect(isToolFollowup({ messages: [call, result] })).toBe(true)
  })

  test('a host user-role reminder after the result does not repeat the tool call', () => {
    expect(isToolFollowup({ messages: [call, result, { role: 'user', content: 'host reminder' }] })).toBe(true)
  })

  test('an old result cannot end a new user turn', () => {
    expect(isToolFollowup({ messages: [call, result, { role: 'assistant', content: 'done' }, { role: 'user', content: 'recall another decision' }] })).toBe(false)
  })

  test('an unfinished tool call is not a follow-up', () => {
    expect(isToolFollowup({ messages: [call] })).toBe(false)
  })

  test('a tool-shaped message without an assistant call is not accepted', () => {
    expect(isToolFollowup({ messages: [{ role: 'user' }, result] })).toBe(false)
  })
})
