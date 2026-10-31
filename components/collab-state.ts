import type { Member } from '../lib/collab/types'

export function memberLabel(member: Pick<Member, 'id' | 'name'>, viewerId: string): string {
  return member.id === viewerId ? `${member.name} (you)` : member.name
}

// Every member renders replies, so markdown images become links: no member can make the others' browsers fetch a URL.
export function replyMarkdown(text: string): string {
  return text.replaceAll('![', '[')
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
