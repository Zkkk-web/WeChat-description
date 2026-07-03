function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function describeMailTask(simulation) {
  const tables = simulation.plannedWrites.map((item) => item.table).join(", ") || "none";

  return [
    "External event: mail received.",
    `Classification: ${simulation.classification.classification}.`,
    `Sender role: ${simulation.classification.senderRole}.`,
    `Confidence: ${simulation.classification.confidence}.`,
    `Planned tables: ${tables}.`,
    "",
    "Task:",
    "Review the mail event, validate the routing decision, and execute the matching Hermes skill.",
    "If the event is a candidate, parse resume evidence and prepare candidate ingestion.",
    "If the event is a client job demand, prepare client and job ingestion.",
    "If the event is a partner mail, prepare the matching partner workflow.",
  ].join("\n");
}

function describeFeishuMailReceived(event) {
  const mailbox = event.payload.mail_address ?? "<mail_address>";
  const messageId = event.payload.message_id ?? "<message_id>";

  return [
    "External event: Feishu mail received.",
    `Mailbox: ${mailbox}.`,
    `Message ID: ${messageId}.`,
    "",
    "Fetch required content before Hermes execution:",
    `GET /open-apis/mail/v1/user_mailboxes/${mailbox}/messages/${messageId}?format=plain_text_full`,
    "Decode subject, sender, plain text body, and attachment metadata.",
    "If attachments are needed, call the attachment download URL API with the returned attachment IDs.",
    "",
    "Task:",
    "After the mail content is fetched, classify it and execute the matching Hermes recruiting skill.",
  ].join("\n");
}

function describeFeishuMinuteGenerated(event) {
  const minuteToken = event.payload.minute_token ?? "<minute_token>";
  const source = event.payload.minute_source ?? {};
  const meetingId = source.source_entity_id ?? "<meeting_id>";

  return [
    "External event: Feishu minutes generated.",
    `Minute token: ${minuteToken}.`,
    `Meeting ID: ${meetingId}.`,
    "",
    "Fetch required content before Hermes execution:",
    `GET /open-apis/minutes/v1/minutes/${minuteToken}`,
    `GET /open-apis/minutes/v1/minutes/${minuteToken}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`,
    "",
    "Task:",
    "Use the transcript and minutes metadata to execute the matching Hermes meeting-summary or article-writing skill.",
  ].join("\n");
}

function describeFeishuMeetingEnded(event) {
  const meeting = event.payload.meeting ?? {};
  const meetingId = meeting.id ?? "<meeting_id>";

  return [
    "External event: Feishu meeting ended.",
    `Meeting ID: ${meetingId}.`,
    `Topic: ${meeting.topic ?? ""}.`,
    "",
    "Fetch required content before Hermes execution:",
    `GET /open-apis/vc/v1/meetings/${meetingId}?query_mode=1`,
    `GET /open-apis/vc/v1/meetings/${meetingId}/recording`,
    "",
    "Task:",
    "Do not write the final article from this event alone. First fetch meeting artifacts, transcript, or minutes URL.",
  ].join("\n");
}

function describeGenericTask(event) {
  return [
    `External event: ${event.type}.`,
    "",
    "Task:",
    "Inspect the event payload and decide which Hermes skill should handle it.",
    "If the payload only contains resource IDs, fetch or request the missing source content before final execution.",
  ].join("\n");
}

function describeTask(event, simulation) {
  if (event.type === "mail.user_mailbox.event.message_received_v1") {
    return describeFeishuMailReceived(event);
  }

  if (event.type === "minutes.minute.generated_v1") {
    return describeFeishuMinuteGenerated(event);
  }

  if (event.type === "vc.meeting.all_meeting_ended_v1" || event.type === "vc.meeting.meeting_ended_v1") {
    return describeFeishuMeetingEnded(event);
  }

  if (simulation) {
    return describeMailTask(simulation);
  }

  return describeGenericTask(event);
}

export function buildHermesPrompt(event, simulation, enrichment = null) {
  const task = describeTask(event, simulation);

  const parts = [
    task,
    "",
    "Event envelope:",
    compactJson({
      source: event.source,
      type: event.type,
      receivedAt: event.receivedAt,
      eventId: event.eventId,
    }),
    "",
    "Event payload:",
    compactJson(event.payload),
  ];

  if (enrichment) {
    parts.push("", "Fetched content:", compactJson(enrichment));
  }

  parts.push("", "Return a concise execution summary with the selected skill, required inputs, and next action.");

  return parts.join("\n");
}
