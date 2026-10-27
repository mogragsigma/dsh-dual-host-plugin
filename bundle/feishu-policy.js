// dsh-im-feishu 1.0.5 compatibility seam; no secrets or transport ownership.
export function botIdentity(response) {
  // node-sdk returns the body; $return_headers wrappers are supported explicitly.
  const body = response?.bot ? response : response?.data;
  if (body?.code !== 0 || !/^ou_[a-zA-Z0-9]+$/.test(body?.bot?.open_id ?? '')) return '';
  return body.bot.open_id;
}

export function routeDecision(data, selfOpenId, text) {
  const message = data?.message;
  const sender = data?.sender;
  if (!message?.message_id || !message?.chat_id || !sender?.sender_id?.open_id) return 'invalid';
  if (sender.sender_type === 'bot') return /^\s*\[A2A\]/.test(text) ? 'bot-a2a' : 'bot-ignored';
  if (sender.sender_type !== 'user') return 'unknown-sender';
  if (message.chat_type === 'p2p') return 'human-private';
  if (message.chat_type !== 'group') return 'unknown-chat';
  if (!selfOpenId) return 'identity-unavailable';
  const hit = (Array.isArray(message.mentions) ? message.mentions : []).some(m => {
    const id = typeof m?.id === 'string' ? m.id : m?.id?.open_id;
    return id === selfOpenId; // names / user_id / union_id are not identity proofs.
  });
  return hit ? 'human-mentioned' : 'not-mentioned';
}
export const mayDispatch = decision => ['bot-a2a', 'human-private', 'human-mentioned'].includes(decision);
