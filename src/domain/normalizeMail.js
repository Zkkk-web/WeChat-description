function attachmentNames(attachments = []) {
  return attachments
    .map((item) => item?.filename ?? item?.name ?? "")
    .filter(Boolean);
}

export function normalizeMailEvent(event) {
  const payload = event.payload ?? {};
  const receivedAt = payload.received_at ?? payload.receivedAt ?? event.receivedAt;

  return {
    messageId: String(payload.message_id ?? payload.messageId ?? `${event.source}:${Date.now()}`),
    receivedAt,
    fromEmail: String(payload.from_email ?? payload.fromEmail ?? ""),
    fromName: String(payload.from_name ?? payload.fromName ?? ""),
    subject: String(payload.subject ?? ""),
    body: String(payload.body ?? payload.text ?? ""),
    attachments: attachmentNames(payload.attachments),
    raw: payload,
  };
}
