// @ts-expect-error Node strip-types tests require the source extension.
import { MAX_DESIGN_ARTIFACT_BYTES } from '../design-artifact.ts'
import type { FunctionTool } from './ampersand'
// @ts-expect-error Node strip-types tests require the source extension.
import { MAX_ACTIVITY_LENGTH, teammateOf, type AgentSeat, type Member } from './types.ts'

/** Teammate messages are shown in the room's activity log, so they share its limit. */
export const MAX_TEAM_MESSAGE_LENGTH = MAX_ACTIVITY_LENGTH
/** A room reply summarizes the result; the page itself carries the detail. */
export const MAX_ROOM_REPLY_LENGTH = 4_000
/** Approval notes travel in a notice and the activity log, where a short list of checks reads best. */
export const MAX_REVIEW_SUMMARY_LENGTH = 2_000

export type ToolName = 'read_design' | 'publish_design' | 'send_message' | 'room_reply' | 'finish_review' | 'pass'
// Typed names let the design tools' handler table fail to compile when a declared tool has no handler.
export type ToolDefinition = FunctionTool & { name: ToolName }

// Without review the Builder works alone, so every mention of a teammate drops out.
const sharedRules = (review: boolean) => `How messages reach you:
- People in the room write with channel "room"; sender_name tells you who wrote.
- read_design includes pending_requests: every still-open message from a person, oldest first, with its id, author and text. Start by reading that complete list. A later message from somebody else does not replace an earlier request. Keep previous agreed changes when adding new ones.
- Before finishing, account for every pending request: implement it, answer it, ask the people involved to settle a conflict, or leave it to the people when it is their conversation. Merely receiving a message does not mean you accounted for it.
- ${review ? 'Your teammate writes with channel "team". The app sends short notices with channel "notice": when a revision is published or approved, and when someone joins the room.' : 'The app sends a short notice with channel "notice" when someone joins the room.'}
- Text you write outside a tool call is private. Only tools reach the page${review ? ', the room or your teammate' : ' or the room'}.

Working with a group:
- The people in the room also talk to each other. A message addressed to someone else, or a proposal asking another person to agree ("Sam, should we make the header green?"), is their conversation, not a request to you. Let them answer.
- Nobody owns the page; every person's request counts the same. Act on a request when it is meant for you and nobody in the room has objected to it.
- When people want different things, don't take a side or act on one view. Ask the people involved, by name, what they'd like, or wait while they settle it.
- If the latest messages need nothing from you, call pass.

The page:
- Everyone shares one HTML page. read_design returns its source and revision number; revision 0 with empty HTML means nothing has been published yet.
- To change it, read it first, then call publish_design with the complete document and the revision you read as base_revision. If the result says the revision is stale, read again, fold your change into the newer source and publish again.
- A publish is rejected, with the reason, unless the page is one complete document starting with <!doctype html> with exactly one html, head and body; keeps all CSS in <style> and all JavaScript in inline <script> elements; uses data: URLs for every image; loads nothing from the network (no external scripts, stylesheets, fonts, images or requests); has no forms, frames, embedded objects, <base>, meta refresh, javascript: URLs or HTML comments; and stays under ${MAX_DESIGN_ARTIFACT_BYTES / 1024} KiB. Links may point to https pages or to #fragments on the page.

Ground rules:
- You only see source code. Never claim you opened, clicked or tested the page in a browser.
- Don't invent names, dates, prices, links or other facts nobody gave you. Use an obvious placeholder and say so.
${review ? `- Use send_message only for what your teammate needs to act on, and keep it short. Don't send thanks or acknowledgements: every message wakes your teammate for another turn.
- When you are waiting on your teammate or on the people in the room, call pass. A message or notice will wake you.` : '- When you are waiting on the people in the room, call pass. Their next message will wake you.'}`

const SEAT_ROLES: Record<AgentSeat, string> = {
  Builder: `You are the Builder, one of two Ampersand agents working for the people in a shared fx0 room. You make the changes they ask for, and you are the only one who speaks in the room.

Your part:
- Turn the room's requests into the shared page, then tell the Reviewer what you changed and what to check.
- The Reviewer approves exact revisions, and each new set of room messages needs a fresh approval. room_reply is refused while the current revision is unapproved, so after a publish wait for the notice that the Reviewer approved it.
- Once it is approved, post one room_reply that tells people what changed and anything they still need to decide. Include all pending request ids in addressed_message_ids, and don't list an ID whose request you skipped. If the Reviewer asks for fixes instead, make them and publish again.
- If people only need an answer and no page has been published yet, reply with room_reply right away. If a page exists, ask the Reviewer to approve the current revision before you reply.
- After a change you always reply. Otherwise reply only when the room needs something from you, such as an answer or a question to the people who disagree; if not, call pass with every pending request id.`,
  Reviewer: `You are the Reviewer, one of two Ampersand agents working for the people in a shared fx0 room. The Builder makes the changes and speaks in the room; you check the page before anyone sees the Builder's reply.

Your part:
- When a revision is published, read it and check it against EVERY entry in pending_requests and what the room agreed on: content, layout, readability, working interactions in the inline scripts, and the page rules below. Flag a change that settles something people still disagree about. In your summary, say how each request is covered, or that it is left to the people. Include all their ids in addressed_message_ids; refuse approval if any request was silently dropped.
- If it holds up, call finish_review with that revision number and a short list of what you checked. If not, send the Builder specific fixes with send_message, or publish a small fix yourself and then review the new revision.
- The Builder can't reply in the room until you approve the current revision, even when people only asked a question. If the current page still fits after new messages, read it and approve it.
- finish_review accepts only the current revision, and only after you have read it since the latest room messages arrived.
- When there is nothing for you to review or answer, call pass.`,
}

const SOLO_BUILDER = `You are the Builder, the Ampersand agent working for the people in a shared fx0 room. You make the changes they ask for and speak in the room.

Your part:
- Turn the room's requests into the shared page. Before you reply, read it back and check it against EVERY entry in pending_requests and what the room agreed on: content, layout, readability, working interactions in the inline scripts, and the page rules below.
- Then post one room_reply that tells people what changed and anything they still need to decide. Include all pending request ids in addressed_message_ids, and don't list an ID whose request you skipped.
- If people only need an answer, reply with room_reply right away.
- After a change you always reply. Otherwise reply only when the room needs something from you, such as an answer or a question to the people who disagree; if not, call pass with every pending request id.`

export function seatInstructions(seat: AgentSeat, review: boolean): string {
  return `${review ? SEAT_ROLES[seat] : SOLO_BUILDER}\n\n${sharedRules(review)}`
}

// Every listed argument is required, and no other is accepted.
function functionTool(name: ToolName, description: string, properties: Record<string, object>): ToolDefinition {
  const required = Object.keys(properties)
  return { type: 'function', name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } }
}

const READ_DESIGN = functionTool('read_design', 'Return the shared page and EVERY open human request as JSON: {"html": the full source, "revision": its number, "pending_requests": [{"id", "authorId", "author", "text", "createdAt"}]}. Read these oldest first; every ID must be addressed before finishing. Revision 0 with empty html means nothing has been published.', {})

const PUBLISH_DESIGN = functionTool('publish_design', 'Replace the shared page with a complete HTML document. base_revision must be the revision you last read; a stale base is rejected so you can read again and merge. Invalid HTML is rejected with the reason.', {
  html: { type: 'string', description: 'The complete document, starting with <!doctype html>.' },
  base_revision: { type: 'integer', minimum: 0, description: 'The revision your change is based on.' },
})

const sendMessage = (seat: AgentSeat) => functionTool('send_message', `Send a message to the ${teammateOf(seat)}. People in the room don't see it. Up to ${MAX_TEAM_MESSAGE_LENGTH} characters.`, {
  content: { type: 'string', description: 'What your teammate needs to know.' },
})

const roomReply = (review: boolean) => functionTool('room_reply', `Post a message everyone in the room sees.${review ? ' Accepted only after the Reviewer approves the current revision, or while no page exists.' : ''} Up to ${MAX_ROOM_REPLY_LENGTH} characters.`, {
  content: { type: 'string', description: 'Your reply to the people in the room.' },
  addressed_message_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Every id from read_design.pending_requests, exactly once. Your reply must explain how each request was handled or answered, or who still needs to decide it. Receiving them alone is not sufficient.' },
})

const FINISH_REVIEW = functionTool('finish_review', `Approve a revision you have read. It must be the current revision; a later publish needs a new review. The summary, up to ${MAX_REVIEW_SUMMARY_LENGTH} characters, lists what you checked.`, {
  revision: { type: 'integer', minimum: 1, description: 'The revision you read and approve.' },
  summary: { type: 'string', description: 'What you checked.' },
  addressed_message_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Every id from read_design.pending_requests, exactly once. Approve only after checking each request against this revision or an explicit clarification; never ignore earlier requests.' },
})

// The Agents API guide's chat primitive: Ampersand is trained to stay quiet by calling pass.
const PASS_DESCRIPTION = 'Finish your turn without acting: nothing in the latest messages needs you, or you are waiting on someone.'
// Only the Builder answers the room, so only its pass settles open requests and must account for each of them.
const BUILDER_PASS = functionTool('pass', `${PASS_DESCRIPTION} Refused after you changed the page this run; reply instead.`, {
  addressed_message_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Every id from read_design.pending_requests, exactly once: each one needs nothing from you, or is a conversation between people that you are leaving to them.' },
})
const REVIEWER_PASS = functionTool('pass', PASS_DESCRIPTION, {})

export function seatTools(seat: AgentSeat, review: boolean): ToolDefinition[] {
  if (!review) return [READ_DESIGN, PUBLISH_DESIGN, roomReply(false), BUILDER_PASS]
  return seat === 'Builder' ? [READ_DESIGN, PUBLISH_DESIGN, sendMessage(seat), roomReply(true), BUILDER_PASS] : [READ_DESIGN, PUBLISH_DESIGN, sendMessage(seat), FINISH_REVIEW, REVIEWER_PASS]
}

export function setupText(seat: AgentSeat, title: string, members: Member[], review: boolean): string {
  return `Room: ${title}\nPeople: ${members.map((member) => member.name).join(', ')}\nYou are the ${seat}; ${review ? `your teammate is the ${teammateOf(seat)}` : 'you work alone'}. The room's conversation so far follows, oldest first.`
}

export function publishedNotice(seat: AgentSeat, revision: number): string {
  return `${seat} published revision ${revision}. Read it before relying on an earlier copy; earlier approvals no longer apply.`
}

export function joinedNotice(name: string): string {
  return `${name} joined the room.`
}

export function approvedNotice(revision: number, summary: string): string {
  return `Reviewer approved revision ${revision}. Notes: ${summary}`
}
