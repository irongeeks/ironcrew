import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";

type L10n = Record<Lang, string[]>;

type AnnouncementReplyDeps = {
  db: RuntimeContext["db"];
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getDeptName: (deptId: string) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
};

export function createAnnouncementReplyScheduler(deps: AnnouncementReplyDeps): {
  generateAnnouncementReply: (agent: AgentRow, announcement: string, lang: Lang) => string;
  scheduleAnnouncementReplies: (announcement: string) => void;
} {
  const { db, resolveLang, getDeptName, l, pickL, sendAgentMessage } = deps;

  function generateAnnouncementReply(agent: AgentRow, announcement: string, lang: Lang): string {
    const name = lang === "ko" ? agent.name_ko || agent.name : agent.name;
    const dept = agent.department_id ? getDeptName(agent.department_id) : "";
    const isUrgent = /긴급|중요|즉시|urgent|important|immediately|critical|緊急|紧急/i.test(announcement);
    const isGoodNews = /축하|달성|성공|감사|congrat|achieve|success|thank|おめでとう|祝贺|恭喜/i.test(announcement);
    const isPolicy = /정책|방침|규칙|변경|policy|change|rule|update|方針|政策/i.test(announcement);
    const isMeeting = /회의|미팅|모임|meeting|gather|会議|开会/i.test(announcement);

    if (isUrgent)
      return pickL(
        l(
          [
            `${dept} ${name}, 확인했습니다! 즉시 팀에 전달하고 대응하겠습니다! 🚨`,
            `네, 긴급 확인! ${dept}에서 바로 조치 취하겠습니다.`,
            `${name} 확인했습니다! 팀원들에게 즉시 공유하겠습니다.`,
          ],
          [
            `${name} from ${dept} — acknowledged! I'll relay this to my team immediately! 🚨`,
            `Urgent noted! ${dept} is on it right away.`,
            `${name} here — confirmed! Sharing with the team ASAP.`,
          ],
          [`${dept}の${name}、確認しました！チームにすぐ伝達します！🚨`],
          [`${dept}${name}收到！立即传达给团队！🚨`],
        ),
        lang,
      );
    if (isGoodNews)
      return pickL(
        l(
          [
            `축하합니다! ${dept}도 함께 기뻐요! 🎉`,
            `좋은 소식이네요! ${dept} 팀원들에게도 공유하겠습니다 😊`,
            `${name} 확인! 정말 좋은 소식입니다! 👏`,
          ],
          [
            `Congratulations! ${dept} is thrilled! 🎉`,
            `Great news! I'll share this with my team 😊`,
            `${name} here — wonderful to hear! 👏`,
          ],
          [`おめでとうございます！${dept}も喜んでいます！🎉`],
          [`恭喜！${dept}也很高兴！🎉`],
        ),
        lang,
      );
    if (isMeeting)
      return pickL(
        l(
          [
            `${dept} ${name}, 확인했습니다! 일정 잡아두겠습니다 📅`,
            `네, 참석하겠습니다! ${dept} 팀원들에게도 전달할게요.`,
            `${name} 확인! 미팅 준비하겠습니다.`,
          ],
          [
            `${name} from ${dept} — noted! I'll block the time 📅`,
            `Will be there! I'll let my team know too.`,
            `${name} confirmed! I'll prepare for the meeting.`,
          ],
          [`${name}確認しました！スケジュール押さえます 📅`],
          [`${name}收到！会安排时间 📅`],
        ),
        lang,
      );
    if (isPolicy)
      return pickL(
        l(
          [
            `${dept} ${name}, 확인했습니다. 팀 내 공유하고 반영하겠습니다 📋`,
            `네, 정책 변경 확인! ${dept}에서 필요한 조치 검토하겠습니다.`,
          ],
          [
            `${name} from ${dept} — understood. I'll share with the team and align accordingly 📋`,
            `Policy update noted! ${dept} will review and adjust.`,
          ],
          [`${name}確認しました。チーム内に共有し反映します 📋`],
          [`${name}收到，会在团队内传达并落实 📋`],
        ),
        lang,
      );
    return pickL(
      l(
        [
          `${dept} ${name}, 확인했습니다! 👍`,
          `네, 공지 확인! ${dept}에서 참고하겠습니다.`,
          `${name} 확인했습니다. 팀에 공유하겠습니다!`,
          `알겠습니다! ${dept} 업무에 반영하겠습니다 📝`,
        ],
        [
          `${name} from ${dept} — acknowledged! 👍`,
          `Noted! ${dept} will take this into account.`,
          `${name} here — confirmed. I'll share with the team!`,
          `Got it! We'll factor this into ${dept}'s work 📝`,
        ],
        [`${dept}の${name}、確認しました！👍`, `承知しました！チームに共有します！`],
        [`${dept}${name}收到！👍`, `明白了！会传达给团队！`],
      ),
      lang,
    );
  }

  function scheduleAnnouncementReplies(announcement: string): void {
    const lang = resolveLang(announcement);
    const teamLeaders = db
      .prepare("SELECT * FROM agents WHERE role = 'team_leader' AND status != 'offline'")
      .all() as unknown as AgentRow[];

    let delay = 1500;
    for (const leader of teamLeaders) {
      const replyDelay = delay + Math.random() * 1500;
      setTimeout(() => {
        const reply = generateAnnouncementReply(leader, announcement, lang);
        sendAgentMessage(leader, reply, "chat", "all", null, null);
      }, replyDelay);
      delay += 1500 + Math.random() * 1500;
    }
  }

  return { generateAnnouncementReply, scheduleAnnouncementReplies };
}
