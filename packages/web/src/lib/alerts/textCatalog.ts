// Plain TypeScript with no imports beside the locale list, so the unit tests can load it under bare Node.
// The Telegram alert texts in the five languages (I4). Each is fixed words plus the figures text.ts computes and the
// site's own origin: no bill reference and no name from Telegram ever lands in one, in any language (C48).
import type { Locale } from "../../i18n/locales";

export type AlertWords = {
  levelCrossed: (symbol: string, ltv: string, level: string, app: string) => string;
  protected: (amount: string, symbol: string, before: string, after: string, app: string) => string;
  linked: (wallet: string, app: string) => string;
  refused: (wallet: string) => string;
  moved: (wallet: string) => string;
  stopped: () => string;
  pending: () => string;
  expired: () => string;
  hello: () => string;
};

export const ALERT_WORDS: Record<Locale, AlertWords> = {
  en: {
    levelCrossed: (symbol, ltv, level, app) => `Adag: your ${symbol} loan is at ${ltv} of your bitcoin's value, past your ${level} alert.\nAdd cirBTC or repay to bring it down: ${app}`,
    protected: (amount, symbol, before, after, app) =>
      `Adag's loan guard repaid ${amount} ${symbol} of your loan from your wallet.\nIt went from ${before} to ${after} of your bitcoin's value.\nDetails: ${app}`,
    linked: (wallet, app) => `Adag alerts are on for wallet ${wallet}. Send /stop here at any time to turn them off. ${app}`,
    refused: (wallet) =>
      `Someone tried to link wallet ${wallet} to this chat. It was refused, because this chat already gets Adag alerts for another wallet. Nothing changed. To switch wallets, send /stop here, then link again from Adag.`,
    moved: (wallet) => `Adag alerts for wallet ${wallet} moved to another chat. This chat gets nothing more for that wallet.`,
    stopped: () => "Adag alerts are off for this chat.",
    pending: () => "Almost done. Go back to the Adag page where you asked for alerts and sign the message in your wallet. If you did not ask for this, ignore it.",
    expired: () => "That link has expired or was already used. Start again from Adag.",
    hello: () => "Open the link on Adag's alerts page to connect a wallet.",
  },
  "zh-CN": {
    levelCrossed: (symbol, ltv, level, app) => `Adag：您的 ${symbol} 贷款已达到您比特币价值的 ${ltv}，超过了您设置的 ${level} 提醒线。\n添加 cirBTC 或偿还一部分以降低它：${app}`,
    protected: (amount, symbol, before, after, app) =>
      `Adag 的贷款守护已从您的钱包偿还了您贷款中的 ${amount} ${symbol}。\n贷款占您比特币价值的比例从 ${before} 降到了 ${after}。\n详情：${app}`,
    linked: (wallet, app) => `钱包 ${wallet} 的 Adag 提醒已开启。随时在此发送 /stop 即可关闭。${app}`,
    refused: (wallet) => `有人尝试将钱包 ${wallet} 关联到此聊天。请求已被拒绝，因为此聊天已在接收另一个钱包的 Adag 提醒。没有任何改变。要更换钱包，请先在此发送 /stop，再从 Adag 重新关联。`,
    moved: (wallet) => `钱包 ${wallet} 的 Adag 提醒已转移到另一个聊天。此聊天不再接收该钱包的任何消息。`,
    stopped: () => "此聊天的 Adag 提醒已关闭。",
    pending: () => "快完成了。请回到您申请提醒的 Adag 页面，在钱包中签署消息。如果您没有申请过，请忽略此消息。",
    expired: () => "该链接已过期或已被使用。请从 Adag 重新开始。",
    hello: () => "请在 Adag 的提醒页面打开链接以连接钱包。",
  },
  ko: {
    levelCrossed: (symbol, ltv, level, app) => `Adag: ${symbol} 대출이 비트코인 가치의 ${ltv}에 도달해 설정한 ${level} 알림 기준을 넘었어요.\ncirBTC를 추가하거나 일부를 상환해 낮춰 주세요: ${app}`,
    protected: (amount, symbol, before, after, app) =>
      `Adag 대출 보호가 지갑에서 대출 중 ${amount} ${symbol}을 상환했어요.\n비트코인 가치 대비 비율이 ${before}에서 ${after}로 내려갔어요.\n자세히 보기: ${app}`,
    linked: (wallet, app) => `지갑 ${wallet}의 Adag 알림이 켜졌어요. 언제든 여기에 /stop을 보내면 꺼져요. ${app}`,
    refused: (wallet) =>
      `누군가 지갑 ${wallet}을 이 채팅에 연결하려 했어요. 이 채팅은 이미 다른 지갑의 Adag 알림을 받고 있어서 거절됐어요. 바뀐 것은 없어요. 지갑을 바꾸려면 먼저 여기에 /stop을 보낸 뒤 Adag에서 다시 연결해 주세요.`,
    moved: (wallet) => `지갑 ${wallet}의 Adag 알림이 다른 채팅으로 옮겨졌어요. 이 채팅은 그 지갑에 대한 알림을 더 받지 않아요.`,
    stopped: () => "이 채팅의 Adag 알림이 꺼졌어요.",
    pending: () => "거의 다 됐어요. 알림을 요청한 Adag 페이지로 돌아가 지갑에서 메시지에 서명해 주세요. 요청한 적이 없다면 무시해도 돼요.",
    expired: () => "이 링크는 만료됐거나 이미 사용됐어요. Adag에서 다시 시작해 주세요.",
    hello: () => "지갑을 연결하려면 Adag 알림 페이지의 링크를 열어 주세요.",
  },
  ja: {
    levelCrossed: (symbol, ltv, level, app) => `Adag：${symbol} の借入がビットコイン価値の ${ltv} に達し、設定した ${level} の通知ラインを超えました。\ncirBTC を追加するか一部を返済して下げてください：${app}`,
    protected: (amount, symbol, before, after, app) =>
      `Adag のローンガードが、ウォレットから借入のうち ${amount} ${symbol} を返済しました。\nビットコイン価値に対する比率は ${before} から ${after} になりました。\n詳細：${app}`,
    linked: (wallet, app) => `ウォレット ${wallet} の Adag 通知をオンにしました。いつでもここに /stop を送るとオフになります。${app}`,
    refused: (wallet) =>
      `誰かがウォレット ${wallet} をこのチャットに連携しようとしました。このチャットはすでに別のウォレットの Adag 通知を受け取っているため、拒否しました。何も変わっていません。ウォレットを切り替えるには、ここに /stop を送ってから Adag で再度連携してください。`,
    moved: (wallet) => `ウォレット ${wallet} の Adag 通知は別のチャットに移りました。このチャットにはそのウォレットの通知は届きません。`,
    stopped: () => "このチャットの Adag 通知をオフにしました。",
    pending: () => "あと少しです。通知を申し込んだ Adag のページに戻り、ウォレットでメッセージに署名してください。申し込んだ覚えがなければ無視してください。",
    expired: () => "このリンクは期限切れか、すでに使われています。Adag からやり直してください。",
    hello: () => "ウォレットを接続するには、Adag の通知ページにあるリンクを開いてください。",
  },
  es: {
    levelCrossed: (symbol, ltv, level, app) => `Adag: tu préstamo en ${symbol} está en ${ltv} del valor de tu bitcoin, por encima de tu alerta de ${level}.\nAgrega cirBTC o devuelve una parte para bajarlo: ${app}`,
    protected: (amount, symbol, before, after, app) =>
      `El guardián del préstamo de Adag devolvió ${amount} ${symbol} de tu préstamo desde tu billetera.\nPasó de ${before} a ${after} del valor de tu bitcoin.\nDetalles: ${app}`,
    linked: (wallet, app) => `Las alertas de Adag están activas para la billetera ${wallet}. Envía /stop aquí en cualquier momento para apagarlas. ${app}`,
    refused: (wallet) =>
      `Alguien intentó vincular la billetera ${wallet} a este chat. Se rechazó, porque este chat ya recibe alertas de Adag para otra billetera. Nada cambió. Para cambiar de billetera, envía /stop aquí y vuelve a vincular desde Adag.`,
    moved: (wallet) => `Las alertas de Adag para la billetera ${wallet} pasaron a otro chat. Este chat ya no recibe nada para esa billetera.`,
    stopped: () => "Las alertas de Adag están apagadas para este chat.",
    pending: () => "Casi listo. Vuelve a la página de Adag donde pediste las alertas y firma el mensaje en tu billetera. Si no pediste esto, ignóralo.",
    expired: () => "Ese enlace expiró o ya se usó. Empieza de nuevo desde Adag.",
    hello: () => "Abre el enlace en la página de alertas de Adag para conectar una billetera.",
  },
};
