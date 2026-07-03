const MAIL_EVENT_TABLE = "邮件事件";

function summary(text, limit) {
  return text.slice(0, limit);
}

function attachmentList(mail) {
  return mail.attachments.join(", ");
}

function displayName(mail) {
  return mail.fromName || mail.fromEmail || mail.subject;
}

function inboxRecord(mail, result) {
  return {
    邮件ID: mail.messageId,
    收信时间: mail.receivedAt,
    发件邮箱: mail.fromEmail,
    发件人: mail.fromName,
    邮件主题: mail.subject,
    正文摘要: summary(mail.body, 300),
    附件名: attachmentList(mail),
    分类结果: result.classification,
    发件人角色: result.senderRole,
    置信度: String(result.confidence),
    判断依据: result.evidence,
    处理状态: result.classification === "other" ? "needs_review" : "new",
    原始载荷: summary(JSON.stringify(mail.raw), 1000),
  };
}

function candidateRecord(mail, options = {}) {
  return {
    "姓名 & 昵称": mail.fromName || mail.subject,
    邮箱: options.keepSenderEmail ? mail.fromEmail : "",
    简历文件名: attachmentList(mail),
    来源邮件ID: mail.messageId,
    邮件正文摘要: summary(mail.body, 300),
    补充材料文件名: options.keepSenderEmail ? "" : attachmentList(mail),
  };
}

function jobRecord(mail) {
  return {
    岗位名称: mail.subject,
    岗位描述: summary(mail.body, 1000),
    "邮件标题格式｜生态伙伴": mail.subject,
  };
}

function clientRecord(mail) {
  return {
    客户名称: displayName(mail),
    邮箱: mail.fromEmail,
    公司全称: mail.fromName || mail.fromEmail,
    发布日期: mail.receivedAt,
  };
}

function hunterPartnerRecord(mail) {
  return {
    "姓名 & 昵称": displayName(mail),
    收件邮箱: mail.fromEmail,
  };
}

function ecosystemPartnerRecord(mail) {
  return {
    "姓名&昵称": displayName(mail),
    你的邮箱: mail.fromEmail,
    "可以简单介绍一下你自己嘛？": summary(mail.body, 1000),
  };
}

const ROUTES = {
  candidate_direct: {
    table: "候选人",
    fields: (mail) => candidateRecord(mail, { keepSenderEmail: true }),
  },
  client_forward_resume: {
    table: "候选人",
    fields: (mail) => candidateRecord(mail, { keepSenderEmail: false }),
  },
  client_job: {
    writes: [
      { table: "客户列表", fields: clientRecord },
      { table: "岗位", fields: jobRecord },
    ],
  },
  hunter_partner: {
    table: "猎头伙伴",
    fields: hunterPartnerRecord,
  },
  ecosystem_partner: {
    table: "生态伙伴",
    fields: ecosystemPartnerRecord,
  },
};

export function planMailWrites(mail, result) {
  const writes = [{ table: MAIL_EVENT_TABLE, fields: inboxRecord(mail, result) }];
  const route = ROUTES[result.classification];

  if (route) {
    for (const item of route.writes ?? [route]) {
      writes.push({ table: item.table, fields: item.fields(mail) });
    }
  }

  return writes;
}
