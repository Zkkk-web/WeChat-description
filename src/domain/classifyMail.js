const CANDIDATE_WORDS = ["应聘", "求职", "我的简历", "附件是我的简历", "投递简历", "投递", "申请"];
const CLIENT_JOB_WORDS = ["招聘需求", "岗位需求", "职位需求", "jd", "帮忙找", "招一个", "招聘", "岗位", "职位", "hiring", "role"];
const FORWARD_WORDS = ["推荐", "转发", "这个候选人", "帮看", "候选人不错", "推荐人才", "推荐候选人"];
const HUNTER_WORDS = ["猎头", "猎头伙伴", "候选人资源", "人才资源", "帮你推荐候选人", "推荐简历"];
const ECOSYSTEM_WORDS = ["生态伙伴", "生态合伙人", "合伙人", "合作", "资源合作", "渠道合作", "内推合作"];
const KNOWN_JOB_PLATFORM_WORDS = [
  "linkedin",
  "领英",
  "substack",
  "indeed",
  "boss直聘",
  "智联招聘",
  "前程无忧",
  "拉勾",
  "猎聘",
  "jobstreet",
  "glassdoor",
  "ziprecruiter",
];
const AUTOMATED_SENDER_WORDS = [
  "noreply",
  "no-reply",
  "notifications",
  "notification",
  "newsletter",
  "digest",
  "alerts",
  "mailer",
  "robot",
  "系统通知",
  "自动发送",
];
const JOB_FEED_WORDS = [
  "job alert",
  "recommended jobs",
  "jobs you may be interested in",
  "职位推荐",
  "岗位推荐",
  "招聘推荐",
  "职位订阅",
  "岗位订阅",
  "订阅岗位",
  "今日岗位",
  "每周岗位",
  "为你推荐",
  "相似职位",
  "new jobs",
];
const UNSUBSCRIBE_WORDS = [
  "unsubscribe",
  "取消订阅",
  "退订",
  "管理订阅",
];
const RESUME_WORDS = ["简历", "resume"];
const RESUME_EXTENSIONS = [".pdf", ".doc", ".docx"];

const FALLBACK = {
  classification: "other",
  senderRole: "unknown",
  confidence: 0.35,
  evidence: "未命中候选人、岗位需求、伙伴合作或客户转发简历的高置信规则。",
};

const EXTERNAL_FEED = {
  classification: "external_job_feed",
  senderRole: "platform_feed",
  confidence: 0.92,
  evidence: "邮件来自领英等第三方平台或订阅源，只作为外部岗位信息审计，不写入业务岗位。",
};

const CLASSIFIERS = [
  {
    classification: "candidate_direct",
    senderRole: "candidate",
    evidence: "邮件包含简历附件，并出现候选人本人求职语义。",
    minScore: 0.72,
    signals: [
      ["hasResume", 0.42],
      ["candidateIntent", 0.48],
      ["forwardIntent", -0.2],
    ],
  },
  {
    classification: "client_forward_resume",
    senderRole: "client",
    evidence: "邮件包含简历附件，并出现推荐或转发候选人的语义。",
    minScore: 0.72,
    signals: [
      ["hasResume", 0.38],
      ["forwardIntent", 0.48],
      ["candidateIntent", -0.18],
    ],
  },
  {
    classification: "client_job",
    senderRole: "client",
    evidence: "邮件出现招聘需求、岗位、职位、JD 或帮忙找人的语义。",
    minScore: 0.62,
    signals: [
      ["clientJobIntent", 0.7],
      ["ecosystemIntent", -0.08],
    ],
  },
  {
    classification: "hunter_partner",
    senderRole: "hunter_partner",
    evidence: "邮件出现猎头、候选人资源或推荐简历合作语义。",
    minScore: 0.62,
    signals: [
      ["hunterIntent", 0.66],
      ["hasResume", 0.08],
    ],
  },
  {
    classification: "ecosystem_partner",
    senderRole: "ecosystem_partner",
    evidence: "邮件出现生态伙伴、合伙人、资源合作或渠道合作语义。",
    minScore: 0.62,
    signals: [
      ["ecosystemIntent", 0.66],
      ["clientJobIntent", -0.18],
    ],
  },
];

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function hasResumeAttachment(mail) {
  return mail.attachments.some((name) => {
    const lower = name.toLowerCase();
    return includesAny(lower, RESUME_WORDS) || RESUME_EXTENSIONS.some((extension) => lower.endsWith(extension));
  });
}

function buildSignals(mail) {
  const text = `${mail.fromEmail}\n${mail.fromName}\n${mail.subject}\n${mail.body}`.toLowerCase();
  const knownJobPlatform = includesAny(text, KNOWN_JOB_PLATFORM_WORDS);
  const automatedSender = includesAny(text, AUTOMATED_SENDER_WORDS);
  const jobFeedIntent = includesAny(text, JOB_FEED_WORDS);
  const unsubscribeIntent = includesAny(text, UNSUBSCRIBE_WORDS);

  return {
    hasResume: hasResumeAttachment(mail),
    candidateIntent: includesAny(text, CANDIDATE_WORDS),
    clientJobIntent: includesAny(text, CLIENT_JOB_WORDS),
    forwardIntent: includesAny(text, FORWARD_WORDS),
    hunterIntent: includesAny(text, HUNTER_WORDS),
    ecosystemIntent: includesAny(text, ECOSYSTEM_WORDS),
    externalFeedIntent: knownJobPlatform || (jobFeedIntent && (automatedSender || unsubscribeIntent)),
  };
}

function scoreClassifier(classifier, signals) {
  return classifier.signals.reduce((score, [signal, points]) => (signals[signal] ? score + points : score), 0);
}

function toResult(classifier, score) {
  return {
    classification: classifier.classification,
    senderRole: classifier.senderRole,
    confidence: Math.min(0.95, Math.max(0.35, Number(score.toFixed(2)))),
    evidence: classifier.evidence,
  };
}

export function classifyMail(mail) {
  const signals = buildSignals(mail);

  if (signals.externalFeedIntent) {
    return EXTERNAL_FEED;
  }

  const [winner] = CLASSIFIERS.map((classifier) => ({
    classifier,
    score: scoreClassifier(classifier, signals),
  }))
    .filter((item) => item.score >= item.classifier.minScore)
    .sort((left, right) => right.score - left.score);

  return winner ? toResult(winner.classifier, winner.score) : FALLBACK;
}
